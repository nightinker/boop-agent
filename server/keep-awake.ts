import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

/**
 * Keeps the Mac awake while Boop runs, like ChatGPT's desktop app, so it stays
 * online and keeps answering texts. It runs `caffeinate -dimsu -w <boop pid>`:
 * no display, idle, disk or (on AC) system sleep, and declare user activity.
 * `-w` makes caffeinate exit by itself if Boop dies without cleaning up, so no
 * orphans pile up.
 *
 * Only the active copy holds the wake lock (see instance.ts): a Mac standing by
 * while the server is active lets itself sleep. Off macOS it does nothing.
 *
 * Caveat: closing a MacBook's lid still sleeps it unless it's on AC power with
 * an external display (clamshell mode). caffeinate can't override that.
 */

export const KEEP_AWAKE_CAFFEINATE = "/usr/bin/caffeinate";
export const KEEP_AWAKE_FLAGS = "-dimsu";
export const KEEP_AWAKE_LID_CAVEAT =
  "Closing a MacBook's lid still puts it to sleep unless it's on AC power with an external display connected; caffeinate can't override that.";
export const KEEP_AWAKE_UNSUPPORTED_MESSAGE = "Keep Mac awake only applies when Boop runs on macOS.";

const MIN_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 60_000;
// A caffeinate that ran this long before exiting counts as healthy, so the
// next restart starts again from the shortest delay.
const HEALTHY_RUN_MS = 60_000;

export type KeepAwakeState = "unsupported" | "disabled" | "standby" | "starting" | "active" | "stopped";

export interface KeepAwakeStatus {
  supported: boolean;
  /** The owner's setting. */
  enabled: boolean;
  /** Whether this copy is the active one (only it holds the wake lock). */
  activeCopy: boolean;
  /** True while caffeinate is running. */
  active: boolean;
  state: KeepAwakeState;
  /** When the current caffeinate started (ms since epoch), or null. */
  since: number | null;
  pid: number | null;
  /** Times caffeinate was restarted after exiting unexpectedly. */
  restarts: number;
  lastError: string | null;
  command: string;
  caveat: string;
}

type SpawnFn = (command: string, args: string[], options: { stdio: "ignore" }) => ChildProcess;

export interface KeepAwakeDeps {
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: SpawnFn;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  log?: Pick<Console, "log" | "warn">;
}

export interface KeepAwakeController {
  /** Applies the owner's setting. */
  setEnabled(enabled: boolean): void;
  /** Applies whether this copy is active; standby releases the wake lock. */
  setActiveCopy(active: boolean): void;
  status(): KeepAwakeStatus;
  /** Releases the wake lock for good (shutdown/restart). */
  stop(): void;
}

export function createKeepAwake(deps: KeepAwakeDeps = {}): KeepAwakeController {
  const platform = deps.platform ?? process.platform;
  const supported = platform === "darwin";
  const pid = deps.pid ?? process.pid;
  const spawn: SpawnFn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
  const now = deps.now ?? Date.now;
  const schedule = deps.setTimeout ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const cancel = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = deps.log ?? console;
  const args = [KEEP_AWAKE_FLAGS, "-w", String(pid)];

  let enabled = false;
  let activeCopy = false;
  let stopped = false;
  let child: ChildProcess | null = null;
  let since: number | null = null;
  let restartTimer: unknown = null;
  let restartDelay = MIN_RESTART_DELAY_MS;
  let restarts = 0;
  let lastError: string | null = null;

  const wanted = () => supported && enabled && activeCopy && !stopped;

  const clearRestart = () => {
    if (restartTimer !== null) {
      cancel(restartTimer);
      restartTimer = null;
    }
  };

  const scheduleRestart = () => {
    if (restartTimer !== null || !wanted()) return;
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY_MS);
    restarts += 1;
    restartTimer = schedule(() => {
      restartTimer = null;
      sync();
    }, delay);
  };

  const start = () => {
    let proc: ChildProcess;
    try {
      proc = spawn(KEEP_AWAKE_CAFFEINATE, args, { stdio: "ignore" });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn("[keep-awake] could not start caffeinate", lastError);
      scheduleRestart();
      return;
    }
    child = proc;
    const startedAt = now();
    since = startedAt;
    let ended = false;
    const onEnd = (reason: string) => {
      if (ended) return;
      ended = true;
      if (child !== proc) return; // Replaced or released on purpose.
      child = null;
      since = null;
      if (!wanted()) return;
      lastError = reason;
      if (now() - startedAt >= HEALTHY_RUN_MS) restartDelay = MIN_RESTART_DELAY_MS;
      log.warn(`[keep-awake] caffeinate ${reason}; restarting`);
      scheduleRestart();
    };
    proc.once("error", (err) => onEnd(`failed: ${err.message}`));
    proc.once("exit", (code, signal) => onEnd(`exited (${signal ?? `code ${code}`})`));
    log.log(`[keep-awake] holding the wake lock (caffeinate ${args.join(" ")}, pid ${proc.pid ?? "?"})`);
  };

  const release = () => {
    clearRestart();
    const proc = child;
    child = null;
    since = null;
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      log.log("[keep-awake] released the wake lock");
    }
  };

  const sync = () => {
    if (wanted()) {
      if (!child && restartTimer === null) start();
    } else {
      release();
    }
  };

  return {
    setEnabled(value) {
      if (value === enabled) return;
      enabled = value;
      if (value) {
        restartDelay = MIN_RESTART_DELAY_MS;
        lastError = null;
      }
      sync();
    },
    setActiveCopy(value) {
      if (value === activeCopy) return;
      activeCopy = value;
      sync();
    },
    status() {
      const running = child !== null;
      const state: KeepAwakeState = !supported
        ? "unsupported"
        : stopped
          ? "stopped"
          : !enabled
            ? "disabled"
            : !activeCopy
              ? "standby"
              : running
                ? "active"
                : "starting";
      return {
        supported,
        enabled: supported && enabled,
        activeCopy,
        active: running,
        state,
        since: running ? since : null,
        pid: running ? (child?.pid ?? null) : null,
        restarts,
        lastError,
        command: `caffeinate ${args.join(" ")}`,
        caveat: KEEP_AWAKE_LID_CAVEAT,
      };
    },
    stop() {
      stopped = true;
      release();
    },
  };
}

let shared: KeepAwakeController | null = null;

/** This process's keep-awake controller. */
export function keepAwake(): KeepAwakeController {
  if (!shared) {
    shared = createKeepAwake();
    // Last resort on a hard exit: a synchronous kill still runs here, and
    // `-w <pid>` covers the cases where even this doesn't.
    const controller = shared;
    process.once("exit", () => controller.stop());
  }
  return shared;
}

export function describeKeepAwake(status: KeepAwakeStatus): string {
  switch (status.state) {
    case "unsupported":
      return KEEP_AWAKE_UNSUPPORTED_MESSAGE;
    case "disabled":
      return "Off: the Mac may sleep normally.";
    case "standby":
      return "Standing by: another copy of Boop is active, so this Mac may sleep.";
    case "starting":
      return "Starting caffeinate…";
    case "stopped":
      return "Released: Boop is shutting down.";
    case "active":
      return `Keeping the Mac awake since ${new Date(status.since ?? Date.now()).toISOString()}.`;
  }
}
