/**
 * Spend/usage-limit detection for model runtimes.
 *
 * When the Claude runtime (or Codex) runs out of budget it doesn't always
 * throw: the Claude Agent SDK emits the error as ordinary assistant text
 * ("You've hit your monthly spend limit. Switch to another model to
 * continue.") with an `error` code on the message. Left alone, that text
 * flows into automation results and proactive notices and gets texted to the
 * owner on every background run. These helpers spot it so background paths
 * can log it instead, and direct replies can swap in one short message.
 */

/** Runtime error codes that mean "out of budget", not "something broke". */
const LIMIT_ERROR_CODES = new Set([
  // Claude Agent SDK assistant-message `error` values.
  "billing_error",
  "rate_limit",
  // Codex app-server RateLimitReachedType values.
  "rate_limit_reached",
  "usage_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

const LIMIT_TEXT_PATTERNS: RegExp[] = [
  /\b(?:monthly|weekly|daily)\s+spend(?:ing)?\s+limit\b/i,
  /\bspend(?:ing)?\s+limit\b.*\b(?:reached|hit|exceeded)\b/i,
  /\byou(?:'|’)?ve\s+(?:hit|reached)\s+your\s+[\w\s-]{0,30}?\blimit\b/i,
  /\bswitch\s+to\s+another\s+model\s+to\s+continue\b/i,
  /\busage\s+limit\s+(?:reached|exceeded|hit)\b/i,
  /\bcredit\s+balance\s+is\s+too\s+low\b/i,
  /\b(?:workspace_(?:owner|member)_)?(?:usage_limit_reached|credits_depleted)\b/,
  /\bbilling_error\b/,
];

/**
 * Text-only matching is limited to short messages: a runtime limit error is a
 * sentence or two (plus maybe a stderr tail), while a real automation report
 * that happens to mention "spend limit" in passing is much longer.
 */
const MAX_TEXT_MATCH_LENGTH = 1_500;

export function isUsageLimitCode(code: unknown): boolean {
  return typeof code === "string" && LIMIT_ERROR_CODES.has(code.trim().toLowerCase());
}

export function isUsageLimitText(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_TEXT_MATCH_LENGTH) return false;
  return LIMIT_TEXT_PATTERNS.some((re) => re.test(trimmed));
}

/** True when an error, error code, or result text is a spend/usage-limit error. */
export function isUsageLimitError(value: unknown, code?: unknown): boolean {
  if (isUsageLimitCode(code)) return true;
  if (typeof value === "string") return isUsageLimitText(value);
  if (value instanceof Error) {
    const withCode = value as Error & { code?: unknown; cause?: unknown };
    return (
      isUsageLimitCode(withCode.code) ||
      isUsageLimitText(value.message) ||
      (withCode.cause !== undefined && isUsageLimitError(withCode.cause))
    );
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      isUsageLimitCode(record.code) ||
      isUsageLimitCode(record.type) ||
      isUsageLimitCode(record.error) ||
      isUsageLimitText(record.message) ||
      isUsageLimitText(record.error)
    );
  }
  return false;
}

/** The one short reply a user gets when their own message hits the limit. */
export const USAGE_LIMIT_DIRECT_REPLY =
  "I've hit the model's usage/spend limit, so I can't handle that right now. Switch models or try again later.";

/** Background limit logs are collapsed to one line per source per window. */
export const USAGE_LIMIT_LOG_WINDOW_MS = 60 * 60 * 1000;

const lastLogged = new Map<string, { at: number; suppressed: number }>();

/**
 * Record a suppressed background limit error in the server log, at most once
 * per `source` per window. Never sends anything to the user. Returns whether
 * a log line was written (useful for tests).
 */
export function logSuppressedUsageLimit(
  source: string,
  detail: unknown,
  now = Date.now(),
): boolean {
  const entry = lastLogged.get(source);
  if (entry && now - entry.at < USAGE_LIMIT_LOG_WINDOW_MS) {
    entry.suppressed += 1;
    return false;
  }
  const skipped = entry?.suppressed ?? 0;
  lastLogged.set(source, { at: now, suppressed: 0 });
  const text = (detail instanceof Error ? detail.message : String(detail ?? "")).slice(0, 200);
  console.warn(
    `[usage-limit] ${source}: model spend/usage limit hit — not notifying user` +
      (skipped > 0 ? ` (${skipped} more suppressed since last log)` : "") +
      (text ? `: ${JSON.stringify(text)}` : ""),
  );
  return true;
}

/** Test hook. */
export function resetUsageLimitLogState(): void {
  lastLogged.clear();
}
