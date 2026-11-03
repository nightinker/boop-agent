/**
 * Automatic retries for agent runs, the way Claude Desktop handles a dropped
 * connection: wait, then carry on with the same conversation, a few times
 * before giving up. Only errors that are likely to pass on their own (network
 * drops, 5xx, overloaded) are retried; a cancel, a usage limit or a bad
 * request fails at once. After the last retry the run fails and the dashboard's
 * Retry button (or asking Boop to retry it) starts it again by hand.
 */
import { isUsageLimitError } from "./usage-limit.js";
import type { UsageTotals } from "./usage.js";

/** Wait before each automatic retry: 3 retries after the first failure. */
export const AUTO_RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;

const TRANSIENT_PATTERNS: RegExp[] = [
  /fetch failed/i,
  /network ?error/i,
  /socket hang up/i,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bEPIPE\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bENETUNREACH\b/,
  /\bUND_ERR_[A-Z_]+\b/,
  /other side closed/i,
  /overloaded/i,
  /\b(500|502|503|504|529)\b/,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway time-?out/i,
  /request timed out/i,
  /connection (?:error|reset|closed)/i,
  /stream (?:ended|closed) unexpectedly/i,
];

/** Runtime error codes (Claude SDK assistant `error`) worth another try. */
const TRANSIENT_ERROR_CODES = new Set(["server_error", "overloaded_error", "api_error"]);

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause ? `${err.message}\n${messageOf(cause)}` : err.message;
  }
  return String(err ?? "");
}

/** Whether a failed run is worth retrying automatically. */
export function isTransientAgentError(err: unknown, errorCode?: string): boolean {
  if (isUsageLimitError(err, errorCode)) return false;
  if (errorCode && TRANSIENT_ERROR_CODES.has(errorCode)) return true;
  const text = messageOf(err);
  if (!text) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * What a resumed run is told. The session already holds the task and every
 * tool call so far, so finished steps (a sent message, a written file) are not
 * repeated.
 */
export const RESUME_PROMPT =
  "The connection dropped before you finished. Carry on from where you stopped: " +
  "do not repeat steps that already succeeded (check before redoing anything that " +
  "sends, posts, buys or deletes), then give your final answer.";

export function retryNotice(attempt: number, delayMs: number, reason: string): string {
  const seconds = Math.round(delayMs / 1000);
  return `Attempt ${attempt} failed (${reason.split("\n")[0].slice(0, 200)}). Retrying in ${seconds}s (retry ${attempt} of ${AUTO_RETRY_DELAYS_MS.length}).`;
}

/** Resolves after `ms`, or early (false) when the run is cancelled. */
export function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Usage of several attempts of one run, added up. */
export function addUsage(total: UsageTotals, next: UsageTotals): UsageTotals {
  return {
    model: next.model && next.model !== "unknown" ? next.model : total.model,
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheCreationTokens: total.cacheCreationTokens + next.cacheCreationTokens,
    costUsd: total.costUsd + next.costUsd,
  };
}
