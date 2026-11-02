/**
 * Is this machine's network good enough to be the copy that answers texts?
 *
 * On flaky Wi-Fi enough Convex check-ins get through that the Mac stays the
 * active copy, while the calls that matter (sending iMessages, the model)
 * keep failing with "fetch failed" and replies are lost. So every network
 * failure is noted here; a burst of them marks the network degraded, and the
 * instance coordinator then checks in below the server's priority so the
 * server takes over. After a quiet spell with no failures it's healthy again
 * and the Mac takes back over.
 */

/** This many failures inside FAILURE_WINDOW_MS marks the network degraded. */
export const FAILURE_THRESHOLD = 3;
export const FAILURE_WINDOW_MS = 3 * 60_000;
/** Degraded until this long passes without a failure. */
export const RECOVERY_QUIET_MS = 10 * 60_000;

export interface NetworkHealth {
  noteFailure(source: string, now?: number): void;
  isDegraded(now?: number): boolean;
  /** Why it's degraded, for logs and the dashboard. */
  status(now?: number): { degraded: boolean; recentFailures: number; lastFailureAt: number | null; lastSource: string | null };
}

export function createNetworkHealth(opts: {
  threshold?: number;
  windowMs?: number;
  recoveryQuietMs?: number;
  log?: Pick<Console, "log" | "warn">;
} = {}): NetworkHealth {
  const threshold = opts.threshold ?? FAILURE_THRESHOLD;
  const windowMs = opts.windowMs ?? FAILURE_WINDOW_MS;
  const quietMs = opts.recoveryQuietMs ?? RECOVERY_QUIET_MS;
  const log = opts.log ?? console;
  let failures: number[] = [];
  let degradedSince: number | null = null;
  let lastFailureAt: number | null = null;
  let lastSource: string | null = null;

  const update = (now: number) => {
    failures = failures.filter((at) => now - at < windowMs);
    if (degradedSince !== null && lastFailureAt !== null && now - lastFailureAt >= quietMs) {
      degradedSince = null;
      log.log(`[network] healthy again after ${Math.round(quietMs / 60_000)} min without a network failure`);
    }
  };

  return {
    noteFailure(source, now = Date.now()) {
      update(now);
      failures.push(now);
      lastFailureAt = now;
      lastSource = source;
      if (degradedSince === null && failures.length >= threshold) {
        degradedSince = now;
        log.warn(
          `[network] degraded: ${failures.length} network failures in ${Math.round(windowMs / 60_000)} min (latest: ${source})`,
        );
      }
    },
    isDegraded(now = Date.now()) {
      update(now);
      return degradedSince !== null;
    },
    status(now = Date.now()) {
      update(now);
      return { degraded: degradedSince !== null, recentFailures: failures.length, lastFailureAt, lastSource };
    },
  };
}

/** The process-wide tracker the server's network calls report to. */
export const networkHealth = createNetworkHealth();

export function noteNetworkFailure(source: string): void {
  networkHealth.noteFailure(source);
}

/**
 * True for errors that mean the network itself failed (no answer at all), not
 * a service saying no: "fetch failed", connection resets, DNS, timeouts.
 */
export function isNetworkError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const text = `${String(e.name ?? "")} ${String(e.code ?? "")} ${String(e.message ?? cur)}`;
    if (
      /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_|socket hang up|network ?error|AbortError|TimeoutError|timed? ?out/i.test(
        text,
      )
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}
