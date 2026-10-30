import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { broadcast } from "../broadcast.js";
import { sendImessage } from "../sendblue.js";
import { getRuntimeConfig, type RuntimeConfig } from "../runtime-config.js";
import { runAgentRuntime } from "../runtimes/index.js";
import {
  branchName,
  codingPrompt,
  isOwnerConversation,
  newBuildId,
  parseGitHubRepo,
  prBody,
  readyMessage,
  restartScript,
  tail,
} from "./plan.js";

const execFileAsync = promisify(execFile);

const CODING_TIMEOUT_MS = 45 * 60_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_MODEL = "claude-opus-5-5";

const running = new Map<string, AbortController>();

interface Shell {
  ok: boolean;
  output: string;
}

async function sh(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Shell> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 50 * 1024 * 1024,
      env: options.env ?? realNodeEnv(),
    });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n"),
    };
  }
}

async function must(command: string, args: string[], options: Parameters<typeof sh>[2] = {}) {
  const result = await sh(command, args, options);
  if (!result.ok) throw new Error(`${command} ${args.join(" ")} failed:\n${tail(result.output, 15)}`);
  return result.output;
}

/**
 * Convex's generated types are gitignored, so a fresh worktree has none and a
 * copied set can predate the branch (missing whole modules). Generate them
 * from the worktree's own convex/ folder; `convex codegen` reads the
 * deployment but doesn't change what runs on it. Fall back to the running
 * app's copy if codegen can't reach Convex.
 */
async function refreshGeneratedTypes(worktree: string, src: string): Promise<void> {
  const generated = await sh("npx", ["convex", "codegen", "--typecheck", "disable"], {
    cwd: worktree,
    timeout: 180_000,
  });
  if (generated.ok) return;
  console.warn(`[self-build] convex codegen failed, copying generated types:\n${tail(generated.output, 5)}`);
  const fallback = [join(process.cwd(), "convex", "_generated"), join(src, "convex", "_generated")].find(
    (dir) => existsSync(dir),
  );
  if (!fallback) return;
  await rm(join(worktree, "convex", "_generated"), { recursive: true, force: true });
  await must("cp", ["-R", fallback, join(worktree, "convex", "_generated")]);
}

export function sourceDir(): string | null {
  const dir = process.env.BOOP_SOURCE_DIR;
  return dir && existsSync(join(dir, ".git")) ? dir : null;
}

function stateDir(): string {
  return join(homedir(), "Library", "Application Support", "Boop", "self-build");
}

function currentAppPath(): string {
  const match = process.execPath.match(/^(.*\.app)\/Contents\/MacOS\//);
  return match?.[1] ?? "/Applications/Boop.app";
}

/** Secrets stay out of the coding agent's reach: it gets PATH/HOME, not Boop's keys. */
/**
 * The desktop app puts a `node` shim first on PATH that runs Electron as Node.
 * Tools that parse their own argv (electron-builder via yargs) see
 * process.versions.electron and drop the wrong arguments, so builds run with
 * the system Node instead.
 */
export function realNodeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const shimDir = env.BOOP_NODE_CMD ? dirname(env.BOOP_NODE_CMD) : null;
  const path = (env.PATH ?? "")
    .split(":")
    .filter((dir) => dir && dir !== shimDir && !dir.endsWith("/Application Support/Boop/bin"))
    .join(":");
  const clean: NodeJS.ProcessEnv = { ...env, PATH: path };
  delete clean.ELECTRON_RUN_AS_NODE;
  delete clean.BOOP_NODE_CMD;
  return clean;
}

export function codingEnv(env: NodeJS.ProcessEnv = realNodeEnv()): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|SENDBLUE|CONVEX|COMPOSIO|DATABASE_URL|PUBLIC_URL/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

async function codingRuntime(): Promise<RuntimeConfig> {
  const config = await getRuntimeConfig();
  return {
    ...config,
    runtime: "claude",
    model: process.env.BOOP_SELF_BUILD_MODEL ?? DEFAULT_MODEL,
    billingMode: "api",
  };
}

async function notify(conversationId: string, text: string): Promise<void> {
  try {
    if (conversationId.startsWith("sms:")) await sendImessage(conversationId.slice(4), text);
    await convex.mutation(api.messages.send, { conversationId, role: "assistant", content: text });
    broadcast("self_build", { conversationId, text });
  } catch (err) {
    console.error("[self-build] notify failed", err);
  }
}

async function setStatus(
  buildId: string,
  patch: Omit<Parameters<typeof convex.mutation<typeof api.selfBuilds.update>>[1], "buildId">,
) {
  await convex.mutation(api.selfBuilds.update, { buildId, ...patch });
}

async function activeBuild() {
  const recent = await convex.query(api.selfBuilds.recent, { limit: 10 });
  return recent.find((b) => ["coding", "testing", "shipping", "restarting"].includes(b.status)) ?? null;
}

function refuseUnlessOwner(conversationId: string): string | null {
  if (isOwnerConversation(conversationId, process.env.BOOP_OWNER_NUMBERS)) return null;
  return "Only Boop's owner can change Boop's code. Add your number to BOOP_OWNER_NUMBERS in .env.local to allow it.";
}

export async function startSelfBuild(input: { conversationId: string; request: string }): Promise<string> {
  const refused = refuseUnlessOwner(input.conversationId);
  if (refused) return refused;
  const src = sourceDir();
  if (!src) return "Self-build isn't set up: set BOOP_SOURCE_DIR in .env.local to Boop's git checkout.";
  const busy = await activeBuild();
  if (busy) return `Build ${busy.buildId} is still ${busy.status}. Wait for it, or say "cancel build".`;

  const buildId = newBuildId();
  await convex.mutation(api.selfBuilds.create, {
    buildId,
    conversationId: input.conversationId,
    request: input.request,
  });
  void runBuild({ ...input, buildId, src }).catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[self-build ${buildId}] failed`, err);
    await setStatus(buildId, { status: "failed", error: message.slice(0, 4000) }).catch(() => undefined);
    await notify(input.conversationId, `Build ${buildId} failed: ${message.split("\n")[0]}`);
  });
  return `Started build ${buildId}. I'm coding it on its own branch and will text you the PR when it's ready (usually 5–30 minutes).`;
}

async function runBuild(input: {
  conversationId: string;
  request: string;
  buildId: string;
  src: string;
}): Promise<void> {
  const { buildId, src } = input;
  const branch = branchName(input.request, buildId);
  const worktree = join(src, ".claude", "worktrees", `self-build-${buildId}`);
  console.log(`[self-build ${buildId}] ${branch} → ${worktree}`);

  await must("git", ["fetch", "origin", "main"], { cwd: src });
  await must("git", ["worktree", "add", "-b", branch, worktree, "origin/main"], { cwd: src });
  if (existsSync(join(src, "node_modules"))) {
    await symlink(join(src, "node_modules"), join(worktree, "node_modules"), "dir");
  }
  await refreshGeneratedTypes(worktree, src);
  await setStatus(buildId, { status: "coding", branch, worktreePath: worktree });

  const abort = new AbortController();
  running.set(buildId, abort);
  const timer = setTimeout(() => abort.abort(), CODING_TIMEOUT_MS);
  const runtimeConfig = await codingRuntime();
  const started = Date.now();
  let summary = "";
  try {
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: codingPrompt(input.request),
      systemPrompt:
        "You are a careful senior engineer extending Boop, a personal agent, in its own repository. Work only inside the current directory.",
      tools: [],
      mode: "execution",
      cwd: worktree,
      env: codingEnv(),
      abortController: abort,
    });
    summary = result.text.trim();
    const usage = result.usage;
    await convex
      .mutation(api.usageRecords.record, {
        source: "self-build",
        conversationId: input.conversationId,
        runtime: runtimeConfig.runtime,
        billingMode: runtimeConfig.billingMode,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd,
        durationMs: Date.now() - started,
      })
      .catch(() => undefined);
  } finally {
    clearTimeout(timer);
    running.delete(buildId);
  }
  if (abort.signal.aborted) {
    const build = await convex.query(api.selfBuilds.get, { buildId });
    if (build?.status === "cancelled") return;
    throw new Error("The coding run took longer than 45 minutes and was stopped.");
  }

  await setStatus(buildId, { status: "testing", summary: summary.slice(0, 8000) });
  const dirty = await must("git", ["status", "--porcelain"], { cwd: worktree });
  if (dirty.trim()) {
    await must("git", ["add", "-A", "--", ".", ":!node_modules", ":!.env*"], { cwd: worktree });
    await must("git", ["commit", "-m", `feat: ${input.request.slice(0, 72)}`], { cwd: worktree });
  }
  const ahead = Number((await must("git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: worktree })).trim());
  if (!ahead) throw new Error("The coding run finished without changing anything.");

  await refreshGeneratedTypes(worktree, src);
  const typecheck = await sh("npx", ["tsc", "--noEmit"], { cwd: worktree, timeout: CHECK_TIMEOUT_MS });
  const tests = await sh("npx", ["vitest", "run"], { cwd: worktree, timeout: CHECK_TIMEOUT_MS });
  const testsPassed = typecheck.ok && tests.ok;
  const testOutput = `$ npx tsc --noEmit\n${tail(typecheck.output, 20) || "(clean)"}\n\n$ npx vitest run\n${tail(tests.output, 20)}`;

  const repo = parseGitHubRepo(await must("git", ["remote", "get-url", "origin"], { cwd: src }));
  if (!repo) throw new Error("Couldn't tell which GitHub repo origin points at.");
  await must("git", ["push", "-u", "origin", branch], { cwd: worktree });
  const prUrl = (
    await must(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        repo,
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        `Boop self-build: ${input.request.slice(0, 60)}`,
        "--body",
        prBody({ request: input.request, summary, testsPassed, testOutput }),
      ],
      { cwd: worktree },
    )
  )
    .trim()
    .split("\n")
    .pop()!;

  await setStatus(buildId, { status: "pr_open", prUrl, testsPassed, testOutput: testOutput.slice(0, 8000) });
  await notify(input.conversationId, readyMessage({ buildId, summary, prUrl, testsPassed }));
}

export async function cancelSelfBuild(input: { conversationId: string; buildId?: string }): Promise<string> {
  const refused = refuseUnlessOwner(input.conversationId);
  if (refused) return refused;
  const recent = await convex.query(api.selfBuilds.recent, { limit: 10 });
  const build = input.buildId
    ? recent.find((b) => b.buildId === input.buildId)
    : recent.find((b) => ["coding", "testing", "pr_open"].includes(b.status));
  if (!build) return "There's no build to cancel.";
  if (!["coding", "testing", "pr_open"].includes(build.status)) {
    return `Build ${build.buildId} is ${build.status} and can't be cancelled now.`;
  }
  await setStatus(build.buildId, { status: "cancelled" });
  running.get(build.buildId)?.abort();
  if (build.prUrl) {
    const repo = parseGitHubRepo(build.prUrl.replace(/\/pull\/\d+$/, ""));
    await sh("gh", ["pr", "close", build.prUrl, ...(repo ? ["--repo", repo] : [])]);
  }
  return `Cancelled build ${build.buildId}.${build.prUrl ? " I closed its PR." : ""}`;
}

export async function listSelfBuilds(): Promise<string> {
  const recent = await convex.query(api.selfBuilds.recent, { limit: 5 });
  if (recent.length === 0) return "No self-builds yet.";
  return recent
    .map(
      (b) =>
        `${b.buildId} · ${b.status}${b.testsPassed === false ? " (checks failing)" : ""} · ${b.request.slice(0, 80)}${b.prUrl ? ` · ${b.prUrl}` : ""}`,
    )
    .join("\n");
}

export async function shipSelfBuild(input: {
  conversationId: string;
  buildId?: string;
  allowFailingChecks?: boolean;
}): Promise<string> {
  const refused = refuseUnlessOwner(input.conversationId);
  if (refused) return refused;
  const src = sourceDir();
  if (!src) return "Self-build isn't set up: set BOOP_SOURCE_DIR in .env.local to Boop's git checkout.";
  const recent = await convex.query(api.selfBuilds.recent, { limit: 10 });
  const shippable = (b: (typeof recent)[number]) =>
    Boolean(b.prUrl) && (b.status === "pr_open" || b.status === "failed" || b.status === "rolled_back");
  const build = input.buildId
    ? recent.find((b) => b.buildId === input.buildId)
    : recent.find(shippable);
  if (!build || !shippable(build) || !build.prUrl) {
    return "There's no finished build waiting to ship.";
  }
  const merged = await prIsMerged(build.prUrl);
  if (build.status !== "pr_open" && !merged) {
    return `That build's last attempt failed before its PR was merged (${build.error?.split("\n")[0] ?? "unknown error"}). Ask the owner whether to start a new build instead.`;
  }
  if (!merged && !build.testsPassed && !input.allowFailingChecks) {
    return `Build ${build.buildId} has failing checks. Ask the owner to confirm shipping it anyway before calling this again with allowFailingChecks.`;
  }
  await setStatus(build.buildId, { status: "shipping" });
  void shipBuild({ build: { buildId: build.buildId, prUrl: build.prUrl }, conversationId: build.conversationId, src }).catch(
    async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[self-build ${build.buildId}] ship failed`, err);
      await setStatus(build.buildId, { status: "failed", error: message.slice(0, 4000) }).catch(() => undefined);
      await notify(build.conversationId, `Shipping build ${build.buildId} failed: ${message.split("\n")[0]}`);
    },
  );
  return `Shipping build ${build.buildId}: merging, rebuilding and restarting. I'll be offline for a minute or two and text you when I'm back.`;
}

async function prIsMerged(prUrl: string): Promise<boolean> {
  const repo = parseGitHubRepo(prUrl.replace(/\/pull\/\d+$/, ""));
  const state = await sh("gh", ["pr", "view", prUrl, "--json", "state", "-q", ".state", ...(repo ? ["--repo", repo] : [])]);
  return state.ok && state.output.trim().split("\n").pop() === "MERGED";
}

async function shipBuild(input: {
  build: { buildId: string; prUrl: string };
  conversationId: string;
  src: string;
}): Promise<void> {
  const { buildId, prUrl } = input.build;
  const repo = parseGitHubRepo(prUrl.replace(/\/pull\/\d+$/, ""));
  if (!(await prIsMerged(prUrl))) {
    await must("gh", ["pr", "merge", prUrl, "--merge", ...(repo ? ["--repo", repo] : [])], { cwd: input.src });
  }

  if (process.env.BOOP_DESKTOP !== "1") {
    await setStatus(buildId, { status: "shipped" });
    await notify(input.conversationId, `Merged build ${buildId}. Restart Boop to load it.`);
    return;
  }

  const release = join(input.src, ".claude", "worktrees", `self-build-release-${buildId}`);
  await must("git", ["fetch", "origin", "main"], { cwd: input.src });
  if (existsSync(release)) {
    await sh("git", ["worktree", "remove", "--force", release], { cwd: input.src });
  }
  await must("git", ["worktree", "add", "--detach", release, "origin/main"], { cwd: input.src });
  const sameDeps = (await sh("cmp", ["-s", join(input.src, "package-lock.json"), join(release, "package-lock.json")])).ok;
  if (sameDeps && existsSync(join(input.src, "node_modules"))) {
    await symlink(join(input.src, "node_modules"), join(release, "node_modules"), "dir");
  } else {
    await must("npm", ["ci"], { cwd: release, timeout: BUILD_TIMEOUT_MS });
  }
  await must("npm", ["run", "desktop:pack"], { cwd: release, timeout: BUILD_TIMEOUT_MS });
  const newApp = join(release, "dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Boop.app");
  if (!existsSync(newApp)) throw new Error(`The build finished but ${newApp} is missing.`);

  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const script = join(dir, `restart-${buildId}.sh`);
  await writeFile(
    script,
    restartScript({
      buildId,
      newAppPath: newApp,
      appPath: currentAppPath(),
      backupDir: join(dir, "previous"),
      resultPath: join(dir, "pending-result.json"),
      healthUrl: `http://localhost:${process.env.PORT ?? 3456}/health`,
    }),
  );
  await chmod(script, 0o755);
  await setStatus(buildId, { status: "restarting" });
  await notify(input.conversationId, `Build ${buildId} is merged and built. Restarting now, back in a minute.`);
  const child = spawn("/bin/bash", [script], {
    detached: true,
    stdio: "ignore",
    cwd: dirname(script),
  });
  child.unref();
}

/** After a restart, report how the swap went (the old process can't). */
export async function reportPendingRestart(): Promise<void> {
  const resultPath = join(stateDir(), "pending-result.json");
  if (!existsSync(resultPath)) return;
  try {
    const result = JSON.parse(await readFile(resultPath, "utf8")) as { buildId: string; status: string };
    await rename(resultPath, join(stateDir(), `reported-${result.buildId}.json`));
    const build = await convex.query(api.selfBuilds.get, { buildId: result.buildId });
    if (!build) return;
    const shipped = result.status === "shipped";
    await setStatus(result.buildId, { status: shipped ? "shipped" : "rolled_back" });
    await notify(
      build.conversationId,
      shipped
        ? `I'm back, running build ${result.buildId}: ${build.request.slice(0, 120)}`
        : `Build ${result.buildId} didn't start properly, so I rolled back to the previous version. The code is still merged; ask me to look into it.`,
    );
  } catch (err) {
    console.error("[self-build] couldn't report the restart", err);
  }
}
