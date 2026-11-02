/**
 * Is this machine's network good enough to be the copy that answers texts?
 *
 * On flaky Wi-Fi enough Convex check-ins get through that the Mac stays the
 * active copy, while the calls that matter (sending iMessages, the model)
 * keep failing with "fetch failed" and replies are lost. So every network
 * failure is noted here; a burst of them marks the network degraded, and the
 * instance coordinator then checks in below the server's priority so the
 * server takes over.
 *
 * While degraded the Mac keeps probing what it needs to answer texts (its
 * ngrok tunnel, Sendblue, the model API). Once every probe passes
 * RECOVERY_PROBES times in a row, at least RECOVERY_MIN_MS after the last
 * failure, it's healthy again and the Mac takes back over. Without probes it
 * recovers after RECOVERY_QUIET_MS with no failures.
 */

/** This many failures inside FAILURE_WINDOW_MS marks the network degraded. */
export const FAILURE_THRESHOLD = 3;
export const FAILURE_WINDOW_MS = 3 * 60_000;
/** Degraded until this long passes without a failure. */
export const RECOVERY_QUIET_MS = 10 * 60_000;
/** Passing probe rounds in a row that prove the network is good again. */
export const RECOVERY_PROBES = 3;
/** ...and no sooner than this after the last failure. */
export const RECOVERY_MIN_MS = 45_000;

export interface NetworkStatus {
  degraded: boolean;
  degradedSince: number | null;
  recentFailures: number;
  lastFailureAt: number | null;
  lastSource: string | null;
  /** Passing probe rounds in a row since the last failure. */
  probesPassed: number;
  lastProbeAt: number | null;
  /** What failed in the last probe round, if anything. */
  lastProbeFailures: string[];
}

export interface NetworkHealth {
  noteFailure(source: string, now?: number): void;
  /** One round of health probes: names of the checks that failed (empty = all passed). */
  noteProbe(failed: string[], now?: number): void;
  isDegraded(now?: number): boolean;
  /** Why it's degraded, for logs and the dashboard. */
  status(now?: number): NetworkStatus;
}

export function createNetworkHealth(opts: {
  threshold?: number;
  windowMs?: number;
  recoveryQuietMs?: number;
  recoveryProbes?: number;
  recoveryMinMs?: number;
  log?: Pick<Console, "log" | "warn">;
} = {}): NetworkHealth {
  const threshold = opts.threshold ?? FAILURE_THRESHOLD;
  const windowMs = opts.windowMs ?? FAILURE_WINDOW_MS;
  const quietMs = opts.recoveryQuietMs ?? RECOVERY_QUIET_MS;
  const probesNeeded = opts.recoveryProbes ?? RECOVERY_PROBES;
  const minMs = opts.recoveryMinMs ?? RECOVERY_MIN_MS;
  const log = opts.log ?? console;
  let failures: number[] = [];
  let degradedSince: number | null = null;
  let lastFailureAt: number | null = null;
  let lastSource: string | null = null;
  let probesPassed = 0;
  let lastProbeAt: number | null = null;
  let lastProbeFailures: string[] = [];

  const recover = (why: string) => {
    degradedSince = null;
    failures = [];
    log.log(`[network] healthy again: ${why}`);
  };

  const update = (now: number) => {
    failures = failures.filter((at) => now - at < windowMs);
    if (degradedSince !== null && lastFailureAt !== null && now - lastFailureAt >= quietMs) {
      recover(`${Math.round(quietMs / 60_000)} min without a network failure`);
    }
  };

  const health: NetworkHealth = {
    noteFailure(source, now = Date.now()) {
      update(now);
      failures.push(now);
      lastFailureAt = now;
      lastSource = source;
      probesPassed = 0;
      if (degradedSince === null && failures.length >= threshold) {
        degradedSince = now;
        log.warn(
          `[network] degraded: ${failures.length} network failures in ${Math.round(windowMs / 60_000)} min (latest: ${source})`,
        );
      }
    },
    noteProbe(failed, now = Date.now()) {
      lastProbeAt = now;
      lastProbeFailures = failed;
      if (failed.length) {
        health.noteFailure(`probe: ${failed.join(", ")}`, now);
        return;
      }
      update(now);
      probesPassed++;
      if (
        degradedSince !== null &&
        probesPassed >= probesNeeded &&
        (lastFailureAt === null || now - lastFailureAt >= minMs)
      ) {
        recover(`${probesPassed} health checks in a row passed`);
      }
    },
    isDegraded(now = Date.now()) {
      update(now);
      return degradedSince !== null;
    },
    status(now = Date.now()) {
      update(now);
      return {
        degraded: degradedSince !== null,
        degradedSince,
        recentFailures: failures.length,
        lastFailureAt,
        lastSource,
        probesPassed,
        lastProbeAt,
        lastProbeFailures,
      };
    },
  };
  return health;
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

/**
 * Can this machine reach what answering a text needs? Any HTTP answer counts
 * as reachable (even 401/404): the point is the network, not the service.
 * Returns the names of the checks that got no answer.
 */
export async function probeNetwork(
  targets: Array<{ name: string; url: string | undefined }>,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<string[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const results = await Promise.all(
    targets.map(async ({ name, url }) => {
      if (!url) return null;
      try {
        const res = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
        await res.body?.cancel().catch(() => undefined);
        return null;
      } catch {
        return name;
      }
    }),
  );
  return results.filter((n): n is string => n !== null);
}
