import type { MutationCtx, QueryCtx } from "./_generated/server";

export const DEMO_PREFIX = "demo:";
export const DEMO_SETTING_KEY = "debug_demo_mode";
export const DEMO_SCAN_LIMIT = 5000;

/**
 * The first `limit` rows that pass `keep`, reading the query lazily and
 * stopping as soon as it has them (or after `maxScan` rows).
 *
 * Dashboard lists are live queries: Convex re-runs them on every write to a
 * table they read. `.take(DEMO_SCAN_LIMIT)` then filtering read 5000 rows to
 * show 50, on every agent log line, message or memory, and that was most of
 * the database bill. This reads about `limit` rows when demo rows are absent.
 */
export async function takeMatching<T>(
  rows: AsyncIterable<T>,
  keep: (row: T) => boolean,
  limit: number,
  maxScan = DEMO_SCAN_LIMIT,
): Promise<T[]> {
  const out: T[] = [];
  if (limit <= 0) return out;
  let scanned = 0;
  for await (const row of rows) {
    if (keep(row)) {
      out.push(row);
      if (out.length >= limit) break;
    }
    if (++scanned >= maxScan) break;
  }
  return out;
}

export function isDemoId(value?: string | null): boolean {
  return typeof value === "string" && value.startsWith(DEMO_PREFIX);
}

export async function isDemoModeEnabled(ctx: QueryCtx | MutationCtx): Promise<boolean> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", DEMO_SETTING_KEY))
    .unique();
  return row?.value === "true";
}

export function isDemoMessage(row: { conversationId?: string | null; agentId?: string | null }) {
  return isDemoId(row.conversationId) || isDemoId(row.agentId);
}

export function isDemoMemoryEvent(row: {
  conversationId?: string | null;
  memoryId?: string | null;
  agentId?: string | null;
}) {
  return isDemoId(row.conversationId) || isDemoId(row.memoryId) || isDemoId(row.agentId);
}

export function isDemoAutomationRun(row: {
  runId?: string | null;
  automationId?: string | null;
  agentId?: string | null;
}) {
  return isDemoId(row.runId) || isDemoId(row.automationId) || isDemoId(row.agentId);
}

export function isDemoUsageRecord(row: {
  conversationId?: string | null;
  agentId?: string | null;
  runId?: string | null;
}) {
  return isDemoId(row.conversationId) || isDemoId(row.agentId) || isDemoId(row.runId);
}
