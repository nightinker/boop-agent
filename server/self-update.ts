import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Keeps a server copy of Boop on the latest code. When a build ships from the
 * Mac (its PR is merged into main), the server notices within a few minutes,
 * fast-forwards, installs dependencies and rebuilds the dashboard only if they
 * changed, then restarts; its service manager (systemd) starts it again.
 * If any step fails, the code is put back and the old version keeps running.
 *
 * Opt-in with BOOP_AUTO_UPDATE=true; meant for a server, not the Mac app
 * (which updates itself by shipping).
 */

const execFileAsync = promisify(execFile);

export type Run = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>;

export const defaultRun: Run = async (cmd, args, opts = {}) => {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: process.cwd(),
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 20 * 1024 * 1024,
    // Electron's binary is only needed by the Mac app.
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
  });
  return stdout.trim();
};

export interface UpdateDeps {
  run?: Run;
  branch?: string;
  /** True while a text is being answered; the update waits for a quiet moment. */
  isBusy?: () => boolean;
  /** Restart into the new code (the default exits and lets systemd restart). */
  restart?: (from: string, to: string) => void;
  log?: Pick<Console, "log" | "warn">;
}

export type UpdateResult =
  | { status: "current" }
  | { status: "busy" }
  | { status: "dirty" }
  | { status: "updated"; from: string; to: string }
  | { status: "failed"; error: string };

/** Which follow-up work an update needs, from the files it changes. */
export function updatePlan(changedFiles: string[]): { install: boolean; dashboard: boolean } {
  const install = changedFiles.some((f) => f === "package.json" || f === "package-lock.json");
  const dashboard = install || changedFiles.some((f) => f.startsWith("debug/"));
  return { install, dashboard };
}

export async function checkForUpdate(deps: UpdateDeps = {}): Promise<UpdateResult> {
  const run = deps.run ?? defaultRun;
  const branch = deps.branch ?? "main";
  const log = deps.log ?? console;

  await run("git", ["fetch", "--quiet", "origin", branch]);
  const head = await run("git", ["rev-parse", "HEAD"]);
  const target = await run("git", ["rev-parse", `origin/${branch}`]);
  if (head === target) return { status: "current" };
  // Only move forward; never throw away commits that aren't on main.
  const isAncestor = await run("git", ["merge-base", "--is-ancestor", "HEAD", `origin/${branch}`]).then(
    () => true,
    () => false,
  );
  if (!isAncestor) return { status: "dirty" };
  if ((await run("git", ["status", "--porcelain", "--untracked-files=no"])) !== "") return { status: "dirty" };
  if (deps.isBusy?.()) return { status: "busy" };

  const changed = (await run("git", ["diff", "--name-only", head, target])).split("\n").filter(Boolean);
  const plan = updatePlan(changed);
  log.log(`[self-update] updating ${head.slice(0, 7)} → ${target.slice(0, 7)} (${changed.length} files)`);
  try {
    await run("git", ["checkout", "--quiet", "--detach", target]);
    if (plan.install) await run("npm", ["install", "--no-audit", "--no-fund"], { timeoutMs: 15 * 60_000 });
    if (plan.dashboard) await run("npm", ["run", "dashboard:build"], { timeoutMs: 10 * 60_000 });
  } catch (err) {
    const error = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    log.warn(`[self-update] update failed, staying on ${head.slice(0, 7)}: ${error}`);
    await run("git", ["checkout", "--quiet", "--detach", head]).catch(() => undefined);
    if (plan.install) {
      await run("npm", ["install", "--no-audit", "--no-fund"], { timeoutMs: 15 * 60_000 }).catch(() => undefined);
    }
    return { status: "failed", error };
  }
  (deps.restart ?? defaultRestart)(head, target);
  return { status: "updated", from: head, to: target };
}

function defaultRestart(from: string, to: string): void {
  console.log(`[self-update] now on ${to.slice(0, 7)} (was ${from.slice(0, 7)}); restarting`);
  // The SIGTERM handler hands over to another copy and exits; systemd's
  // Restart=always starts the new code.
  process.kill(process.pid, "SIGTERM");
}

export function startSelfUpdateLoop(deps: UpdateDeps = {}): () => void {
  if (process.env.BOOP_AUTO_UPDATE !== "true") return () => undefined;
  const intervalMs = Number(process.env.BOOP_AUTO_UPDATE_INTERVAL_MS ?? 5 * 60_000);
  const branch = process.env.BOOP_AUTO_UPDATE_BRANCH?.trim() || "main";
  console.log(`[self-update] following origin/${branch} every ${Math.round(intervalMs / 1000)}s`);
  let running = false;
  let lastProblem = "";
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await checkForUpdate({ ...deps, branch });
      const problem = result.status === "dirty" ? "local changes or commits not on main; not updating" : "";
      if (problem && problem !== lastProblem) console.warn(`[self-update] ${problem}`);
      lastProblem = problem;
    } catch (err) {
      console.warn("[self-update] check failed", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 60_000);
  const timer = setInterval(() => void tick(), intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
