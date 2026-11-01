import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { wakeLockHolderPhrase, wakeLockSource, wakeLockSourceLabel, type WakeLockSource } from "./keep-awake-labels.js";

/**
 * Keeps the Mac awake while Boop runs, like ChatGPT's desktop app, so it stays
 * online and keeps answering texts. It runs `caffeinate -dimsu -w <boop pid>`:
 * no display, idle, disk or (on AC) system sleep, and declare user activity.
 * `-w` makes caffeinate exit by itself if Boop dies without cleaning up, so no
 * orphans pile up.
 *
 * Two things can ask for the wake lock, and one caffeinate serves both:
 * - the owner's toggle, honoured only on the active copy (see instance.ts): a
 *   Mac standing by while the server is active lets itself sleep;
 * - a self-build in progress (queued through restarting), whatever the toggle
 *   says, so the Mac can't sleep in the middle of Boop changing itself. When
 *   the last build ends, caffeinate stops unless the toggle still wants it.
 * Off macOS it does nothing.
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
  /** The owner's toggle is asking for the wake lock (enabled on the active copy). */
  userHold: boolean;
  /** A self-build in progress is asking for the wake lock. */
  buildHold: boolean;
  /** Self-builds in progress, oldest first. */
  buildIds: string[];
  /** Who wants the wake lock right now, or null when nobody does. */
  heldBy: WakeLockSource | null;
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
  /** Applies whether this copy is active; standby releases the owner's wake lock. */
  setActiveCopy(active: boolean): void;
  /** The self-builds in progress; any of them holds the wake lock regardless of the toggle. */
  setBuilds(buildIds: string[]): void;
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
  let builds: string[] = [];
  let stopped = false;
  let child: ChildProcess | null = null;
  let since: number | null = null;
  let restartTimer: unknown = null;
  let restartDelay = MIN_RESTART_DELAY_MS;
  let restarts = 0;
  let lastError: string | null = null;

  const userHold = () => supported && enabled && activeCopy;
  const buildHold = () => supported && builds.length > 0;
  const wanted = () => !stopped && (userHold() || buildHold());

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
    setBuilds(ids) {
      const next = [...new Set(ids)];
      if (next.length === builds.length && next.every((id, i) => id === builds[i])) return;
      const had = builds.length > 0;
      builds = next;
      if (supported && !had && next.length > 0) {
        log.log(`[keep-awake] self-build ${next.join(", ")} in progress; holding the wake lock`);
        restartDelay = MIN_RESTART_DELAY_MS;
      } else if (supported && had && next.length === 0) {
        log.log(`[keep-awake] no self-build in progress${userHold() ? "; keeping the wake lock for the toggle" : ""}`);
      }
      sync();
    },
    status() {
      const running = child !== null;
      const holders = { userHold: userHold(), buildHold: buildHold(), buildIds: supported ? [...builds] : [] };
      const state: KeepAwakeState = !supported
        ? "unsupported"
        : stopped
          ? "stopped"
          : wanted()
            ? running
              ? "active"
              : "starting"
            : !enabled
              ? "disabled"
              : "standby";
      return {
        supported,
        enabled: supported && enabled,
        activeCopy,
        active: running,
        ...holders,
        heldBy: stopped ? null : wakeLockSource(holders),
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

/**
 * How to launch the ship restart script. On macOS it runs under
 * `caffeinate -dimsu`, so the Mac stays awake through the restart even though
 * this process, and the caffeinate it holds, quit partway through. caffeinate
 * exits as soon as the script does (shipped or rolled back, or failed), so
 * nothing is left behind; the relaunched Boop takes over the lock from there
 * until it marks the build done.
 */
export function restartCommand(
  script: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } {
  if (platform === "darwin" && exists(KEEP_AWAKE_CAFFEINATE)) {
    return { command: KEEP_AWAKE_CAFFEINATE, args: [KEEP_AWAKE_FLAGS, "/bin/bash", script] };
  }
  return { command: "/bin/bash", args: [script] };
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
      return `Starting caffeinate ${wakeLockHolderPhrase(status)}…`.replace(" …", "…");
    case "stopped":
      return "Released: Boop is shutting down.";
    case "active":
      return `${wakeLockSourceLabel(status) ?? "Awake"} (since ${new Date(status.since ?? Date.now()).toISOString()}).`;
  }
}
