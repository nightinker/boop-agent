import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { notifyConversation } from "../notify.js";
import { getRuntimeConfig, type RuntimeConfig } from "../runtime-config.js";
import { runAgentRuntime } from "../runtimes/index.js";
import { redactBuildText, runCodingWithRetries, SECRET_ENV_NAME } from "./coding-run.js";
import {
  appendActivity,
  branchName,
  codingPrompt,
  describeToolUse,
  healthTimeoutSeconds,
  isOwnerConversation,
  logsToPrune,
  worktreesToPrune,
  newBuildId,
  parseGitHubRepo,
  prBody,
  readyMessage,
  restartScript,
  catchUpMessage,
  checksSummary,
  missingDependencies,
  ROLLBACK_LOG_LINES,
  rollbackMessage,
  startupLogName,
  tail,
} from "./plan.js";
import { CANCELLABLE, formatBuildList, queuedMessage, RETRYABLE, shipBlocker } from "./queue.js";
import { restartCommand } from "../keep-awake.js";
import { syncBuildWakeLock } from "../keep-awake-routes.js";
import { currentInstance, instanceIdentity, isActiveInstance, type InstanceSummary } from "../instance.js";
import { isUnknownArgError, withOptionalArgs } from "../convex-compat.js";
import { requestSelfUpdateSoon } from "../self-update.js";
import { runsOn } from "../../convex/selfBuildRules.js";
import { sourceDir } from "./source-dir.js";

const execFileAsync = promisify(execFile);

const CODING_TIMEOUT_MS = 45 * 60_000;
const CHECK_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_MODEL = "claude-opus-5-5";

const running = new Map<string, AbortController>();
// Builds this process is coding, checking or shipping right now.
const localBuilds = new Set<string>();
// After the server ships, queued builds wait this long for its self-update
// (a build would hold the update back until it finished).
const QUEUE_HOLD_AFTER_SHIP_MS = 10 * 60_000;
let queueHeldUntil = 0;

/**
 * Which copy of Boop this is (its instances.instanceId). Recorded on every
 * build it starts or ships, so a restart only fails its own builds.
 */
export function thisRunner(): string {
  return currentInstance()?.identity.instanceId ?? instanceIdentity().instanceId;
}

/**
 * Whether this copy may record a build without its runner when the deployed
 * Convex functions are too old to take one. Only the Mac: a runner-less build
 * counts as the Mac's, so the Mac would fail a server's build on restart.
 */
function runnerOptional(): boolean {
  return process.platform === "darwin";
}

/** Builds with no runner predate runners: they ran on the Mac. */
function runsHere(build: { runner?: string }): boolean {
  return runsOn(build, thisRunner(), process.platform === "darwin");
}

/**
 * True while this copy is coding, checking, shipping or installing a build,
 * so a server's self-update waits instead of restarting in the middle of it.
 */
export function selfBuildBusy(): boolean {
  return localBuilds.size > 0 || catchingUp;
}

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

/**
 * Gives the worktree dependencies that match its own package.json. Borrows
 * the running app's node_modules (a symlink) when that has every declared
 * package; otherwise it's stale, so the worktree gets its own `npm ci`
 * instead. Never installs through the symlink: that would change the
 * dependencies of the Boop that's running.
 */
async function ensureDependencies(worktree: string, src: string): Promise<void> {
  const pkg = JSON.parse(await readFile(join(worktree, "package.json"), "utf8"));
  const installedIn = (dir: string) => (name: string) => existsSync(join(dir, name, "package.json"));
  const local = join(worktree, "node_modules");
  if (existsSync(local) && !missingDependencies(pkg, installedIn(local)).length) return;
  const shared = join(src, "node_modules");
  const linked = await lstat(local).then((s) => s.isSymbolicLink(), () => false);
  if (linked) await unlink(local);
  else if (!existsSync(local) && existsSync(shared) && !missingDependencies(pkg, installedIn(shared)).length) {
    await symlink(shared, local, "dir");
    return;
  }
  const missing = missingDependencies(pkg, installedIn(existsSync(local) ? local : shared));
  console.log(`[self-build] installing dependencies in ${worktree} (missing: ${missing.slice(0, 5).join(", ")})`);
  await must("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: worktree,
    timeout: 15 * 60_000,
    env: { ...realNodeEnv(), ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
  });
}

export { sourceDir };

function stateDir(): string {
  return join(homedir(), "Library", "Application Support", "Boop", "self-build");
}

/**
 * Which commit the Mac app runs. Saved when an install starts (installing)
 * and confirmed when the restarted app reports in (installed), so the Mac can
 * tell, when it comes back online, whether main moved on while it was off.
 */
interface Installing {
  id: string;
  commit: string;
  conversationId: string | null;
}

async function writeInstalling(info: Installing): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(join(stateDir(), "installing.json"), JSON.stringify(info));
}

async function readInstalling(): Promise<Installing | null> {
  try {
    return JSON.parse(await readFile(join(stateDir(), "installing.json"), "utf8")) as Installing;
  } catch {
    return null;
  }
}

export async function writeInstalledCommit(commit: string): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(join(stateDir(), "installed.json"), JSON.stringify({ commit, at: new Date().toISOString() }));
}

async function readInstalledCommit(): Promise<string | null> {
  try {
    const { commit } = JSON.parse(await readFile(join(stateDir(), "installed.json"), "utf8")) as { commit?: string };
    return commit ?? null;
  } catch {
    return null;
  }
}

/** The owner's iMessage conversation, for notices nobody asked for. */
function ownerConversation(): string | null {
  const first = (process.env.BOOP_OWNER_NUMBERS ?? "").split(",")[0]?.replace(/[^\d+]/g, "");
  if (!first) return null;
  return `sms:${first.startsWith("+") ? first : `+${first}`}`;
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
    if (SECRET_ENV_NAME.test(key) || /PUBLIC_URL/i.test(key)) continue;
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

function notify(conversationId: string, text: string): Promise<void> {
  return notifyConversation(conversationId, redactBuildText(text), "self_build");
}

async function setStatus(
  buildId: string,
  patch: Omit<Parameters<typeof convex.mutation<typeof api.selfBuilds.update>>[1], "buildId">,
) {
  const redacted = { ...patch };
  for (const key of ["summary", "error", "testOutput", "startupLogTail"] as const) {
    const value = redacted[key];
    if (typeof value === "string") redacted[key] = redactBuildText(value);
  }
  try {
    await withOptionalArgs(
      "selfBuilds.update",
      (args) => convex.mutation(api.selfBuilds.update, args),
      { buildId, ...redacted },
      ["runner"],
      { fallback: runnerOptional() },
    );
  } finally {
    // Take or release the build's wake lock right away, not at the next poll.
    syncBuildWakeLock();
  }
}

// Every save re-runs the live dashboard queries that read this build, so
// batch activity lines instead of writing one every few seconds.
const ACTIVITY_FLUSH_MS = 15_000;
const activityLogs = new Map<string, { text?: string; timer?: ReturnType<typeof setTimeout> }>();

/**
 * Notes what a build is doing so the dashboard can show it live. Writes are
 * batched (at most one every few seconds) and never fail the build.
 */
function noteActivity(buildId: string, entry: string, opts: { flush?: boolean } = {}): Promise<void> {
  const log = activityLogs.get(buildId) ?? {};
  activityLogs.set(buildId, log);
  log.text = appendActivity(log.text, redactBuildText(entry));
  const write = async () => {
    log.timer = undefined;
    await convex.mutation(api.selfBuilds.update, { buildId, activity: log.text }).catch(() => undefined);
  };
  if (opts.flush) {
    if (log.timer) clearTimeout(log.timer);
    return write();
  }
  if (!log.timer) log.timer = setTimeout(() => void write(), ACTIVITY_FLUSH_MS);
  return Promise.resolve();
}

function refuseUnlessOwner(conversationId: string): string | null {
  if (isOwnerConversation(conversationId, process.env.BOOP_OWNER_NUMBERS)) return null;
  return "Only Boop's owner can change Boop's code. Add your number to BOOP_OWNER_NUMBERS in .env.local to allow it.";
}

export async function startSelfBuild(input: {
  conversationId: string;
  request: string;
  retryOf?: string;
}): Promise<string> {
  const refused = refuseUnlessOwner(input.conversationId);
  if (refused) return refused;
  const src = sourceDir();
  if (!src && process.platform !== "darwin") {
    // A server copy can't build or ship (that needs the Mac app), so it
    // queues the request for the Mac, which starts it when it's back.
    return queueForMac(input);
  }
  if (!src) return "Self-build isn't set up: set BOOP_SOURCE_DIR in .env.local to Boop's git checkout.";
  // With a checkout, the server builds too (while the Mac is off, it's the
  // copy taking requests). Convex starts at most one build at a time across
  // every copy, so the Mac and the server never both code one.
  const buildId = newBuildId();
  let slot;
  try {
    slot = await withOptionalArgs(
      "selfBuilds.enqueue",
      (args) => convex.mutation(api.selfBuilds.enqueue, args),
      {
        buildId,
        conversationId: input.conversationId,
        request: input.request,
        ...(input.retryOf ? { retryOf: input.retryOf } : {}),
        runner: thisRunner(),
      },
      ["runner"],
      { fallback: runnerOptional() },
    );
  } catch (err) {
    // The deployed functions can't record which copy runs a build, so a
    // server build would look like the Mac's (and be failed by its restart).
    // Leave it to the Mac, which pushes newer functions when it starts.
    if (runnerOptional() || !isUnknownArgError(err)) throw err;
    return queueForMac(input);
  }
  syncBuildWakeLock();
  if (slot.status === "queued") {
    return queuedMessage({ buildId, position: slot.position, blockedBy: slot.blockedBy });
  }
  launchBuild({ conversationId: input.conversationId, request: input.request, buildId, src });
  return `Started build ${buildId}. I'm coding it on its own branch and will text you the PR when it's ready (usually 5–30 minutes).`;
}

async function queueForMac(input: { conversationId: string; request: string; retryOf?: string }): Promise<string> {
  const buildId = newBuildId();
  const slot = await convex.mutation(api.selfBuilds.enqueue, {
    buildId,
    conversationId: input.conversationId,
    request: input.request,
    ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    forceQueue: true,
  });
  return `I'm running on the server right now, and builds happen on your Mac. I queued this as build ${buildId} (#${slot.position} in line); your Mac starts it as soon as it's back online, and I'll text you then.`;
}

type BuildInput = { conversationId: string; request: string; buildId: string; src: string };
let runBuildImpl: (input: BuildInput) => Promise<void> = (input) => runBuild(input);

/** Test hook: replace the coding run (worktree, agent, checks, PR). */
export function setBuildRunnerForTests(fn: ((input: BuildInput) => Promise<void>) | null): void {
  runBuildImpl = fn ?? ((input) => runBuild(input));
}

/** Runs a build in the background, then starts the next queued one. */
function launchBuild(input: BuildInput): void {
  const { buildId } = input;
  localBuilds.add(buildId);
  void runBuildImpl(input)
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[self-build ${buildId}] failed`, err);
      await noteActivity(buildId, `Failed: ${message.split("\n")[0]}`, { flush: true });
      await setStatus(buildId, { status: "failed", error: message.slice(0, 4000) }).catch(() => undefined);
      await notify(input.conversationId, `Build ${buildId} failed: ${message.split("\n")[0]}`);
    })
    .finally(async () => {
      localBuilds.delete(buildId);
      activityLogs.delete(buildId);
      await pruneWorktrees(input.src);
      void startNextQueuedBuild();
    });
}

/**
 * Starts the oldest queued build, if nothing else is building. Only the
 * active copy picks up queued builds; the claim itself is one Convex
 * transaction, so two copies asking at once can't both get the same build.
 */
export async function startNextQueuedBuild(): Promise<void> {
  const src = sourceDir();
  // A catch-up install is about to restart Boop, or waits for running work
  // to finish first; queued builds wait for it (they resume after the restart).
  if (!src || catchingUp || catchUpRetry || !isActiveInstance()) return;
  // Just shipped on the server: let it update itself first (it waits while
  // building). The queue resumes after the restart, or once this runs out.
  if (Date.now() < queueHeldUntil) return;
  try {
    const next = await withOptionalArgs(
      "selfBuilds.claimNextQueued",
      (args) => convex.mutation(api.selfBuilds.claimNextQueued, args),
      { runner: thisRunner() },
      ["runner"],
      { fallback: runnerOptional() },
    ).catch((err) => {
      // Too old to record the runner: the server leaves the queue to the Mac.
      if (!runnerOptional() && isUnknownArgError(err)) return null;
      throw err;
    });
    if (!next) return;
    console.log(`[self-build ${next.buildId}] starting from the queue`);
    await notify(next.conversationId, `Starting queued build ${next.buildId}: ${next.request.slice(0, 120)}`);
    launchBuild({ ...next, src });
  } catch (err) {
    console.error("[self-build] couldn't start the next queued build", err);
  }
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
  activityLogs.delete(buildId);
  await noteActivity(buildId, `Setting up worktree on ${branch}`, { flush: true });

  await must("git", ["fetch", "origin", "main"], { cwd: src });
  await must("git", ["worktree", "add", "-b", branch, worktree, "origin/main"], { cwd: src });
  await ensureDependencies(worktree, src);
  await refreshGeneratedTypes(worktree, src);
  // Cancelled while its worktree was being set up: don't bring it back.
  if ((await convex.query(api.selfBuilds.get, { buildId }))?.status === "cancelled") return;
  await setStatus(buildId, { status: "coding", branch, worktreePath: worktree });
  await noteActivity(buildId, "Coding agent started", { flush: true });

  const abort = new AbortController();
  running.set(buildId, abort);
  const timer = setTimeout(() => abort.abort(), CODING_TIMEOUT_MS);
  const runtimeConfig = await codingRuntime();
  const started = Date.now();
  let summary = "";
  try {
    ({ summary } = await runCodingWithRetries(
      {
        prompt: codingPrompt(input.request),
        systemPrompt:
          "You are a careful senior engineer extending Boop, a personal agent, in its own repository. Work only inside the current directory.",
        tools: [],
        mode: "execution",
        cwd: worktree,
        env: codingEnv(),
        abortController: abort,
        onToolUse: (toolName, toolInput) => noteActivity(buildId, describeToolUse(toolName, toolInput, worktree)),
      },
      {
        run: (request) => runAgentRuntime(runtimeConfig, request),
        onRetry: (notice) => noteActivity(buildId, notice, { flush: true }),
        recordUsage: async (usage) => {
          await convex.mutation(api.usageRecords.record, {
            source: "self-build",
            conversationId: input.conversationId,
            buildId,
            runtime: runtimeConfig.runtime,
            billingMode: runtimeConfig.billingMode,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheCreationTokens: usage.cacheCreationTokens,
            costUsd: usage.costUsd,
            durationMs: Date.now() - started,
          });
        },
      },
    ));
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
  await noteActivity(buildId, "Coding finished; committing and running checks", { flush: true });
  const dirty = await must("git", ["status", "--porcelain"], { cwd: worktree });
  if (dirty.trim()) {
    await must("git", ["add", "-A", "--", ".", ":!node_modules", ":!.env*"], { cwd: worktree });
    await must("git", ["commit", "-m", redactBuildText(`feat: ${input.request.slice(0, 72)}`)], { cwd: worktree });
  }
  const ahead = Number((await must("git", ["rev-list", "--count", "origin/main..HEAD"], { cwd: worktree })).trim());
  if (!ahead) throw new Error("The coding run finished without changing anything.");

  // The coding run may have added packages since setup.
  await ensureDependencies(worktree, src);
  await refreshGeneratedTypes(worktree, src);
  await noteActivity(buildId, "Running npx tsc --noEmit", { flush: true });
  const typecheck = await sh("npx", ["tsc", "--noEmit"], { cwd: worktree, timeout: CHECK_TIMEOUT_MS });
  await noteActivity(buildId, `Typecheck ${typecheck.ok ? "passed" : "failed"}; running npx vitest run`, { flush: true });
  const tests = await sh("npx", ["vitest", "run"], { cwd: worktree, timeout: CHECK_TIMEOUT_MS });
  const testsPassed = typecheck.ok && tests.ok;
  const checks = checksSummary({ typecheckOk: typecheck.ok, testsOk: tests.ok, testsOutput: tests.output });
  const testOutput = `${checks}\n\n$ npx tsc --noEmit\n${tail(typecheck.output, 20) || "(clean)"}\n\n$ npx vitest run\n${tail(tests.output, 20)}`;

  const repo = parseGitHubRepo(await must("git", ["remote", "get-url", "origin"], { cwd: src }));
  if (!repo) throw new Error("Couldn't tell which GitHub repo origin points at.");
  await noteActivity(buildId, `${checks} Pushing ${branch} and opening a PR`, { flush: true });
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
        redactBuildText(`Boop self-build: ${input.request.slice(0, 60)}`),
        "--body",
        redactBuildText(prBody({ request: input.request, summary, testsPassed, testOutput, checks })),
      ],
      { cwd: worktree },
    )
  )
    .trim()
    .split("\n")
    .pop()!;

  await noteActivity(buildId, `PR open: ${prUrl}`, { flush: true });
  await setStatus(buildId, { status: "pr_open", prUrl, testsPassed, testOutput: testOutput.slice(0, 8000) });
  await notify(input.conversationId, readyMessage({ buildId, summary, prUrl, testsPassed, checks }));
}

/**
 * Starts a failed, cancelled or rolled-back build again: same request, a new
 * build id and a fresh worktree off the latest main (queued if another build
 * is running). The new build records which one it re-runs.
 */
export async function retrySelfBuild(input: { conversationId: string; buildId?: string }): Promise<string> {
  const refused = refuseUnlessOwner(input.conversationId);
  if (refused) return refused;
  const build = input.buildId
    ? await convex.query(api.selfBuilds.get, { buildId: input.buildId })
    : (await convex.query(api.selfBuilds.recent, { limit: 10 })).find((b) => RETRYABLE.includes(b.status));
  if (!build) return input.buildId ? `There's no build ${input.buildId}.` : "There's no failed or cancelled build to retry.";
  if (!RETRYABLE.includes(build.status)) {
    return `Build ${build.buildId} is ${build.status}; only failed, cancelled or rolled-back builds can be retried.`;
  }
  const started = await startSelfBuild({
    conversationId: input.conversationId,
    request: build.request,
    retryOf: build.buildId,
  });
  return `Retrying build ${build.buildId}. ${started}`;
}

export async function cancelSelfBuild(input: { conversationId: string; buildId?: string }): Promise<string> {
  const refused = refuseUnlessOwner(input.conversationId);
  if (refused) return refused;
  const recent = await convex.query(api.selfBuilds.recent, { limit: 10 });
  const build = input.buildId
    ? (recent.find((b) => b.buildId === input.buildId) ??
      (await convex.query(api.selfBuilds.get, { buildId: input.buildId })))
    : (recent.find((b) => ["coding", "testing", "pr_open"].includes(b.status)) ??
      recent.find((b) => b.status === "queued"));
  if (!build) return "There's no build to cancel.";
  if (!CANCELLABLE.includes(build.status)) {
    return `Build ${build.buildId} is ${build.status} and can't be cancelled now.`;
  }
  await setStatus(build.buildId, { status: "cancelled" });
  if (build.status === "queued") return `Removed build ${build.buildId} from the queue.`;
  running.get(build.buildId)?.abort();
  if (build.prUrl) {
    const repo = parseGitHubRepo(build.prUrl.replace(/\/pull\/\d+$/, ""));
    await sh("gh", ["pr", "close", build.prUrl, ...(repo ? ["--repo", repo] : [])]);
  }
  return `Cancelled build ${build.buildId}.${build.prUrl ? " I closed its PR." : ""}`;
}

export async function listSelfBuilds(): Promise<string> {
  const [recent, queued] = await Promise.all([
    convex.query(api.selfBuilds.recent, { limit: 5 }),
    convex.query(api.selfBuilds.queued, {}),
  ]);
  return formatBuildList(recent, queued);
}

export async function shipSelfBuild(input: {
  conversationId: string;
  buildId?: string;
  allowFailingChecks?: boolean;
  healthTimeoutSeconds?: number;
}): Promise<string> {
  const refused = refuseUnlessOwner(input.conversationId);
  if (refused) return refused;
  const src = sourceDir();
  if (!src && process.platform !== "darwin") {
    return "Shipping a build restarts the Mac app, so it has to happen on your Mac, which is offline right now. Ask me again once it's back.";
  }
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
  const blocker = shipBlocker(recent, build.buildId, process.env.BOOP_DESKTOP === "1", runsHere);
  if (blocker) return blocker;
  try {
    await setStatus(build.buildId, { status: "shipping", runner: thisRunner() });
  } catch (err) {
    if (runnerOptional() || !isUnknownArgError(err)) throw err;
    return "The Convex functions deployed are older than this server's code, so I can't ship from here safely. Ask me again once your Mac is back; it pushes the newer functions when it starts.";
  }
  localBuilds.add(build.buildId);
  activityLogs.set(build.buildId, { text: build.activity });
  await noteActivity(build.buildId, "Shipping: merging the PR and rebuilding", { flush: true });
  void shipBuild({
    build: { buildId: build.buildId, prUrl: build.prUrl },
    conversationId: build.conversationId,
    src,
    healthTimeoutSec: healthTimeoutSeconds(input.healthTimeoutSeconds),
  }).catch(
    async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[self-build ${build.buildId}] ship failed`, err);
      await noteActivity(build.buildId, `Ship failed: ${message.split("\n")[0]}`, { flush: true });
      activityLogs.delete(build.buildId);
      await setStatus(build.buildId, { status: "failed", error: message.slice(0, 4000) }).catch(() => undefined);
      await notify(build.conversationId, `Shipping failed: ${message.split("\n")[0]}`);
      localBuilds.delete(build.buildId);
      await startNextQueuedBuild();
    },
  );
  return `Shipping it: merging, rebuilding and restarting. Back in a minute or two.`;
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
  healthTimeoutSec: number;
}): Promise<void> {
  const { buildId, prUrl } = input.build;
  const repo = parseGitHubRepo(prUrl.replace(/\/pull\/\d+$/, ""));
  if (!(await prIsMerged(prUrl))) {
    await must("gh", ["pr", "merge", prUrl, "--merge", ...(repo ? ["--repo", repo] : [])], { cwd: input.src });
  }

  if (process.env.BOOP_DESKTOP !== "1") {
    // A server copy: main has the build now. Its self-update loop (when on)
    // pulls it and restarts; the Mac installs it once it's back online.
    const server = process.platform !== "darwin";
    const updating = server && requestSelfUpdateSoon();
    if (updating) queueHeldUntil = Date.now() + QUEUE_HOLD_AFTER_SHIP_MS;
    await noteActivity(buildId, updating ? "Merged; updating this server" : "Merged; restart Boop to load it", {
      flush: true,
    });
    activityLogs.delete(buildId);
    await setStatus(buildId, { status: "shipped" });
    localBuilds.delete(buildId);
    await notify(input.conversationId, shippedFromServerMessage({ server, updating }));
    await startNextQueuedBuild();
    return;
  }

  await noteActivity(buildId, "PR merged; building the Mac app", { flush: true });
  await buildAndRestart({
    id: buildId,
    src: input.src,
    healthTimeoutSec: input.healthTimeoutSec,
    conversationId: input.conversationId,
    beforeRestart: async () => {
      await noteActivity(buildId, "Built the new app; restarting into it", { flush: true });
      activityLogs.delete(buildId);
      await setStatus(buildId, { status: "restarting" });
      await notify(input.conversationId, `Build merged. Restarting now, back in a minute.`);
    },
  });
}

export function shippedFromServerMessage(input: { server: boolean; updating: boolean }): string {
  if (!input.server) return "Build merged. Restart Boop to load it.";
  return `Build merged into main. ${
    input.updating ? "Updating the server now; back in a minute." : "Restart Boop on the server to load it."
  } Your Mac installs it on its own once it's back online, and I'll text you when it has.`;
}

/**
 * Builds the Mac app from origin/main and swaps it in with a detached restart
 * script (which rolls back if the new app doesn't come up). Shared by "ship
 * it" and by catching up on builds merged while the Mac was off.
 */
async function buildAndRestart(input: {
  id: string;
  src: string;
  healthTimeoutSec: number;
  conversationId: string | null;
  beforeRestart: () => Promise<void>;
}): Promise<void> {
  const buildId = input.id;
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
  const commit = (await must("git", ["rev-parse", "HEAD"], { cwd: release })).trim();
  // desktop:pack stamps the commit into the app (scripts/stamp-build-info.cjs).
  await must("npm", ["run", "desktop:pack"], { cwd: release, timeout: BUILD_TIMEOUT_MS });
  const newApp = join(release, "dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Boop.app");
  if (!existsSync(newApp)) throw new Error(`The build finished but ${newApp} is missing.`);

  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  await pruneBuildLogs(dir);
  const startupLogPath = join(dir, startupLogName(buildId, await readdir(dir)));
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
      logPath: join(dir, `restart-${buildId}.log`),
      ports: [Number(process.env.PORT ?? 3456), 5173, 4040],
      startupLogPath,
      startupMarkerPath: join(dir, "startup-log-request"),
      healthTimeoutSec: input.healthTimeoutSec,
    }),
  );
  await chmod(script, 0o755);
  await writeInstalling({ id: buildId, commit, conversationId: input.conversationId });
  await input.beforeRestart();
  // `open` hands its environment to the app it launches, so ELECTRON_RUN_AS_NODE
  // must not reach the helper or the relaunched Boop starts as plain Node and exits.
  // Wrapped in caffeinate on macOS: the Mac stays awake until the restart is done.
  const restart = restartCommand(script);
  const child = spawn(restart.command, restart.args, {
    detached: true,
    stdio: "ignore",
    cwd: dirname(script),
    env: realNodeEnv(),
  });
  child.unref();
}

const RESTART_RESULT_WAIT_MS = 3 * 60_000;

/**
 * On startup: report how a ship-and-restart went, mark builds the restart cut
 * off as failed (so they stop blocking the queue), then start the next queued
 * build.
 */
export async function resumeSelfBuilds(opts: { startQueued?: boolean } = {}): Promise<void> {
  // A copy that can't build (a server without a checkout) never ran the
  // builds marked coding, so restarting it interrupted nothing: leave them be.
  if (!sourceDir()) return;
  const mac = process.platform === "darwin";
  try {
    const recent = await convex.query(api.selfBuilds.recent, { limit: 10 });
    // The restart script writes its result only after this server answers
    // its health check, so wait for it rather than treating it as stuck.
    if (mac && recent.some((b) => b.status === "restarting" && runsHere(b))) await waitForRestartResult();
    if (mac) await reportPendingRestart();
    await pruneWorktrees(sourceDir()!);

    // Only this copy's builds: the server restarting (e.g. to update itself)
    // must not fail a build the Mac is coding, nor the other way round.
    const interrupted = await convex
      .mutation(api.selfBuilds.failInterrupted, { runner: thisRunner(), claimsUnowned: mac })
      .catch((err) => {
        if (!isUnknownArgError(err)) throw err;
        // Convex functions from before runners: failing every build is only
        // right on the Mac, which ran them all.
        return mac ? convex.mutation(api.selfBuilds.failInterrupted, {}) : [];
      });
    if (interrupted.length > 0) syncBuildWakeLock();
    for (const build of interrupted) {
      console.warn(`[self-build ${build.buildId}] interrupted while ${build.status}`);
      await notify(
        build.conversationId,
        build.status === "restarting"
          ? `Build merged, but I couldn't tell if it started after the restart. Ask me to check.`
          : `Build ${build.buildId} stopped because I restarted while it was ${build.status}. Ask me to start it again if you still want it: ${build.request.slice(0, 120)}`,
      );
    }
  } catch (err) {
    console.error("[self-build] couldn't resume after restart", err);
  }
  if (opts.startQueued !== false) await startNextQueuedBuild();
}

let catchingUp = false;

export interface CatchUpOptions {
  /**
   * True while something a restart would cut off is running, such as an
   * execution agent. The install waits for it, rechecking locally (no
   * Convex reads) every `retryMs`.
   */
  isBusy?: () => boolean;
  retryMs?: number;
  /** Test hook: the build-and-swap step. */
  install?: (input: Parameters<typeof buildAndRestart>[0]) => Promise<void>;
}

/** started: an install is under way; deferred: waiting for running work; error: the check itself failed. */
type CatchUpOutcome = "started" | "none" | "deferred" | "error";

let catchUpInflight: Promise<CatchUpOutcome> | null = null;
let catchUpRetry: ReturnType<typeof setTimeout> | null = null;

/**
 * When the Mac comes back online: if main moved on while it was off (builds
 * the server shipped, PRs merged on GitHub), build and install it, the same
 * way "ship it" does. Returns true when an install started; the restart
 * reports back and texts the owner. Waits for a running execution agent or
 * a build on this Mac to finish first.
 */
export async function installMissedUpdates(opts: CatchUpOptions = {}): Promise<boolean> {
  return (await checkOnce(opts)) === "started";
}

function checkOnce(opts: CatchUpOptions): Promise<CatchUpOutcome> {
  catchUpInflight ??= checkMissedUpdates(opts).finally(() => {
    catchUpInflight = null;
  });
  return catchUpInflight;
}

function deferCatchUp(opts: CatchUpOptions): void {
  if (catchUpRetry) return;
  const retryMs = opts.retryMs ?? 60_000;
  const again = () => {
    catchUpRetry = null;
    if (opts.isBusy?.() || localBuilds.size > 0) {
      catchUpRetry = setTimeout(again, retryMs);
      catchUpRetry.unref?.();
      return;
    }
    // Queued builds waited for this install. If it didn't start after all
    // (nothing to install, or the check failed), let them go.
    void checkOnce(opts).then((outcome) => {
      if (outcome !== "started") void startNextQueuedBuild();
    });
  };
  catchUpRetry = setTimeout(again, retryMs);
  catchUpRetry.unref?.();
}

async function checkMissedUpdates(opts: CatchUpOptions): Promise<CatchUpOutcome> {
  if (catchingUp || process.env.BOOP_DESKTOP !== "1") return "none";
  const src = sourceDir();
  if (!src) return "none";
  try {
    const installed = await readInstalledCommit();
    if (!installed) {
      console.log("[self-build] no record of the installed version yet; skipping the catch-up check");
      return "none";
    }
    // Git first: it costs nothing, and usually there's nothing to install.
    await must("git", ["fetch", "origin", "main"], { cwd: src });
    const target = (await must("git", ["rev-parse", "origin/main"], { cwd: src })).trim();
    if (target === installed) return "none";
    // Only move forward: a local build ahead of main is left alone.
    if (!(await sh("git", ["merge-base", "--is-ancestor", installed, target], { cwd: src })).ok) return "none";
    if (localBuilds.size > 0 || opts.isBusy?.()) {
      console.log(`[self-build] main is at ${target.slice(0, 7)}; installing once the running work finishes`);
      deferCatchUp(opts);
      return "deferred";
    }
    // A build coding or shipping on this Mac would be cut off by the restart.
    // One running on the server isn't: the Mac restarting doesn't touch it.
    const recent = await convex.query(api.selfBuilds.recent, { limit: 10 });
    if (recent.some((b) => ["coding", "testing", "shipping", "restarting"].includes(b.status) && runsHere(b))) {
      return "none";
    }
    const subjects = (await must("git", ["log", "--first-parent", "--format=%s", `${installed}..${target}`], { cwd: src }))
      .split("\n")
      .filter(Boolean);
    const conversationId = ownerConversation();
    const id = `update-${target.slice(0, 7)}`;
    catchingUp = true;
    console.log(`[self-build] main moved ${installed.slice(0, 7)} → ${target.slice(0, 7)} while offline; installing`);
    if (conversationId) await notify(conversationId, catchUpMessage(subjects));
    const install = opts.install ?? buildAndRestart;
    void install({
      id,
      src,
      healthTimeoutSec: healthTimeoutSeconds(),
      conversationId,
      beforeRestart: async () => undefined,
    }).catch(async (err) => {
      catchingUp = false;
      await pruneWorktrees(src);
      const message = err instanceof Error ? err.message : String(err);
      console.error("[self-build] catch-up install failed", err);
      if (conversationId) await notify(conversationId, `Installing the latest main failed: ${message.split("\n")[0]}`);
    });
    return "started";
  } catch (err) {
    console.warn("[self-build] catch-up check failed", err instanceof Error ? err.message : err);
    return "error";
  }
}

// The last peer commit a catch-up check completed for, and when a failed
// check (say, git fetch offline) for a commit may be tried again.
let lastPeerCommit: string | null = null;
let peerRetry: { commit: string; at: number } | null = null;
const PEER_RETRY_MS = 60_000;

/**
 * Runs on the Mac with every instance check-in it already does (no extra
 * Convex reads): a server copy reports the commit it runs, so when the
 * server shipped a build while the Mac was away, or while the Mac stood by,
 * the Mac sees a commit it doesn't have and installs main.
 */
export async function catchUpWithPeers(summary: InstanceSummary, opts: CatchUpOptions = {}): Promise<boolean> {
  if (process.env.BOOP_DESKTOP !== "1") return false;
  const me = thisRunner();
  const peer = summary.instances.find((i) => i.instanceId !== me && i.commit)?.commit;
  if (!peer || peer === lastPeerCommit) return false;
  if (peerRetry?.commit === peer && Date.now() < peerRetry.at) return false;
  const installed = await readInstalledCommit();
  if (!installed || installed === peer) {
    lastPeerCommit = peer;
    return false;
  }
  const outcome = await checkOnce(opts);
  // Only a check that completed counts; a failed one is retried a minute on.
  if (outcome === "error") peerRetry = { commit: peer, at: Date.now() + PEER_RETRY_MS };
  else lastPeerCommit = peer;
  return outcome === "started";
}

/** Test hook. */
export function resetCatchUpState(): void {
  catchingUp = false;
  lastPeerCommit = null;
  peerRetry = null;
  queueHeldUntil = 0;
  catchUpInflight = null;
  if (catchUpRetry) clearTimeout(catchUpRetry);
  catchUpRetry = null;
  localBuilds.clear();
}

async function waitForRestartResult(): Promise<void> {
  const resultPath = join(stateDir(), "pending-result.json");
  const deadline = Date.now() + RESTART_RESULT_WAIT_MS;
  while (!existsSync(resultPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

/**
 * Deletes the self-build worktrees nothing needs any more (see
 * worktreesToPrune). Runs after every build and on startup; when Convex can't
 * say how the builds went, it deletes nothing.
 */
export async function pruneWorktrees(src: string): Promise<void> {
  const dir = join(src, ".claude", "worktrees");
  if (!existsSync(dir)) return;
  try {
    const names = (await readdir(dir)).filter((name) => name.startsWith("self-build-"));
    if (names.length === 0) return;
    const worktrees = await Promise.all(
      names.map(async (name) => ({ name, mtimeMs: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? Date.now() })),
    );
    const builds: Record<string, { status: string; prUrl?: string } | null> = {};
    for (const { name } of worktrees) {
      if (name.startsWith("self-build-release-")) continue;
      const buildId = name.slice("self-build-".length);
      builds[buildId] = await convex.query(api.selfBuilds.get, { buildId });
    }
    const recent = await convex.query(api.selfBuilds.recent, { limit: 10 });
    const installBusy = catchingUp || recent.some((b) => b.status === "shipping" || b.status === "restarting");
    const doomed = worktreesToPrune({ worktrees, builds, installBusy, now: Date.now() });
    for (const name of doomed) {
      const path = join(dir, name);
      // A release worktree borrows the main checkout's node_modules through a
      // symlink: drop the link first so nothing can follow it.
      const modules = join(path, "node_modules");
      if ((await lstat(modules).catch(() => null))?.isSymbolicLink()) await unlink(modules);
      const removed = await sh("git", ["worktree", "remove", "--force", path], { cwd: src });
      if (!removed.ok) await rm(path, { recursive: true, force: true });
    }
    if (doomed.length > 0) {
      await sh("git", ["worktree", "prune"], { cwd: src });
      console.log(`[self-build] removed ${doomed.length} finished worktree(s): ${doomed.join(", ")}`);
    }
  } catch (err) {
    console.warn("[self-build] couldn't prune old worktrees", err instanceof Error ? err.message : err);
  }
}

/** Keep only the newest few startup logs, restart logs and restart scripts. */
async function pruneBuildLogs(dir: string): Promise<void> {
  try {
    const names = await readdir(dir);
    const files = await Promise.all(
      names.map(async (name) => ({ name, mtimeMs: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    await Promise.all(logsToPrune(files).map((name) => rm(join(dir, name), { force: true })));
  } catch (err) {
    console.warn("[self-build] couldn't prune old build logs", err);
  }
}

async function readLogTail(path: string | undefined): Promise<string | undefined> {
  if (!path || !existsSync(path)) return undefined;
  try {
    return tail(await readFile(path, "utf8"), ROLLBACK_LOG_LINES);
  } catch {
    return undefined;
  }
}

/** After a restart, report how the swap went (the old process can't). */
export async function reportPendingRestart(): Promise<void> {
  const resultPath = join(stateDir(), "pending-result.json");
  if (!existsSync(resultPath)) return;
  try {
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      buildId: string;
      status: string;
      startupLog?: string;
      healthTimeoutSec?: number;
    };
    await rename(resultPath, join(stateDir(), `reported-${result.buildId}.json`));
    const installing = await readInstalling();
    const ours = installing?.id === result.buildId ? installing : null;
    if (ours && result.status === "shipped") await writeInstalledCommit(ours.commit);
    const build = await convex.query(api.selfBuilds.get, { buildId: result.buildId });
    if (!build) {
      // A catch-up install of builds merged while the Mac was off.
      if (ours?.conversationId) {
        const logPath = result.startupLog && existsSync(result.startupLog) ? result.startupLog : undefined;
        await notify(
          ours.conversationId,
          result.status === "shipped"
            ? `I'm back, running the latest main (${ours.commit.slice(0, 7)}).`
            : rollbackMessage({
                buildId: result.buildId,
                logPath,
                logTail: await readLogTail(logPath),
                healthTimeoutSec: logPath ? result.healthTimeoutSec : undefined,
              }),
        );
      }
      return;
    }
    if (result.status === "shipped") {
      await setStatus(result.buildId, { status: "shipped" });
      await notify(build.conversationId, `I'm back. Build merged and running.`);
      return;
    }
    const logPath = result.startupLog && existsSync(result.startupLog) ? result.startupLog : undefined;
    const logTail = await readLogTail(logPath);
    await setStatus(result.buildId, {
      status: "rolled_back",
      ...(logPath ? { startupLogPath: logPath, startupLogTail: (logTail ?? "").slice(-8000) } : {}),
    });
    await notify(
      build.conversationId,
      rollbackMessage({ buildId: result.buildId, logPath, logTail, healthTimeoutSec: logPath ? result.healthTimeoutSec : undefined }),
    );
  } catch (err) {
    console.error("[self-build] couldn't report the restart", err);
  }
}
