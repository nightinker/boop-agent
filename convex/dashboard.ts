import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  DEMO_SCAN_LIMIT,
  isDemoAutomationRun,
  isDemoId,
  isDemoMessage,
  isDemoModeEnabled,
  isDemoUsageRecord,
} from "./demoMode";

// Cap per-table scans so a long-lived install doesn't hit Convex's 16,384
// .collect() ceiling and break the dashboard. Metrics reflect the most
// recent N rows per table; `truncated` surfaces when we've hit the cap.
const METRICS_SCAN_LIMIT = 5000;

async function computeMetrics(ctx: QueryCtx, demoMode: boolean) {
    let [messages, memories, agents, automationRuns, usageRecords] = await Promise.all([
      ctx.db.query("messages").order("desc").take(METRICS_SCAN_LIMIT),
      ctx.db.query("memoryRecords").order("desc").take(METRICS_SCAN_LIMIT),
      ctx.db.query("executionAgents").order("desc").take(METRICS_SCAN_LIMIT),
      ctx.db.query("automationRuns").order("desc").take(METRICS_SCAN_LIMIT),
      ctx.db.query("usageRecords").order("desc").take(METRICS_SCAN_LIMIT),
    ]);
    const scanned = {
      messages: messages.length,
      memories: memories.length,
      agents: agents.length,
      automationRuns: automationRuns.length,
      usageRecords: usageRecords.length,
    };
    messages = messages.filter((message) => isDemoMessage(message) === demoMode);
    memories = memories.filter((memory) => isDemoId(memory.memoryId) === demoMode);
    agents = agents.filter((agent) => isDemoId(agent.agentId) === demoMode);
    automationRuns = automationRuns.filter((run) => isDemoAutomationRun(run) === demoMode);
    usageRecords = usageRecords.filter((record) => isDemoUsageRecord(record) === demoMode);
    const truncated =
      scanned.messages === METRICS_SCAN_LIMIT ||
      scanned.memories === METRICS_SCAN_LIMIT ||
      scanned.agents === METRICS_SCAN_LIMIT ||
      scanned.automationRuns === METRICS_SCAN_LIMIT ||
      scanned.usageRecords === METRICS_SCAN_LIMIT;

    const activeMem = memories.filter((m) => m.lifecycle === "active");

    // Build daily buckets across all time so the chart has something to draw.
    const buckets = new Map<
      string,
      {
        day: string;
        agentCost: number;
        inputTokens: number;
        outputTokens: number;
        agentsSpawned: number;
        agentsCompleted: number;
        agentsFailed: number;
        agentsCancelled: number;
        automationRuns: number;
      }
    >();

    function keyFor(ts: number) {
      return new Date(ts).toISOString().slice(0, 10);
    }
    function bucketFor(day: string) {
      let b = buckets.get(day);
      if (!b) {
        b = {
          day,
          agentCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          agentsSpawned: 0,
          agentsCompleted: 0,
          agentsFailed: 0,
          agentsCancelled: 0,
          automationRuns: 0,
        };
        buckets.set(day, b);
      }
      return b;
    }

    const usageAgentIds = new Set<string>();

    for (const r of usageRecords) {
      const b = bucketFor(keyFor(r.createdAt));
      b.agentCost += r.costUsd ?? 0;
      b.inputTokens += r.inputTokens ?? 0;
      b.outputTokens += r.outputTokens ?? 0;
      if (r.agentId) usageAgentIds.add(r.agentId);
    }

    for (const a of agents) {
      const b = bucketFor(keyFor(a.startedAt));
      b.agentsSpawned += 1;
      if (!usageAgentIds.has(a.agentId)) {
        b.agentCost += a.costUsd ?? 0;
        b.inputTokens += a.inputTokens ?? 0;
        b.outputTokens += a.outputTokens ?? 0;
      }
      if (a.status === "completed") b.agentsCompleted += 1;
      else if (a.status === "failed") b.agentsFailed += 1;
      else if (a.status === "cancelled") b.agentsCancelled += 1;
    }
    for (const r of automationRuns) {
      const b = bucketFor(keyFor(r.startedAt));
      b.automationRuns += 1;
    }

    const dailyBuckets = [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));

    return {
      messages: messages.length,
      memories: {
        total: activeMem.length,
        shortTerm: activeMem.filter((m) => m.tier === "short").length,
        longTerm: activeMem.filter((m) => m.tier === "long").length,
        permanent: activeMem.filter((m) => m.tier === "permanent").length,
      },
      agents: {
        total: agents.length,
        completed: agents.filter((a) => a.status === "completed").length,
        failed: agents.filter((a) => a.status === "failed").length,
        cancelled: agents.filter((a) => a.status === "cancelled").length,
        running: agents.filter(
          (a) => a.status === "running" || a.status === "spawned",
        ).length,
      },
      cost: {
        total: dailyBuckets.reduce((s, b) => s + b.agentCost, 0),
      },
      tokens: {
        input: dailyBuckets.reduce((s, b) => s + b.inputTokens, 0),
        output: dailyBuckets.reduce((s, b) => s + b.outputTokens, 0),
      },
      dailyBuckets,
      truncated,
      scanLimit: METRICS_SCAN_LIMIT,
    };
}

/** Live computation; scans up to 5000 rows per table. Prefer cachedMetrics. */
export const metrics = query({
  args: {},
  handler: async (ctx) => computeMetrics(ctx, await isDemoModeEnabled(ctx)),
});

// ── Cached copy ──────────────────────────────────────────────────────────────
// computeMetrics reads thousands of rows. Run live, it re-ran on every
// message, memory and usage write while a dashboard was open. Instead it is
// computed into one dashboardStats record, at most every STATS_MAX_AGE_MS and
// only when an open dashboard asks (refreshMetrics). Viewers subscribe to
// that one small record, which Convex can serve from cache until it changes.

const STATS_MAX_AGE_MS = 30 * 60_000;
const statsKey = (demoMode: boolean) => (demoMode ? "metrics:demo" : "metrics");

export const cachedMetrics = query({
  args: {},
  handler: async (ctx) => {
    const key = statsKey(await isDemoModeEnabled(ctx));
    const row = await ctx.db
      .query("dashboardStats")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!row) return null;
    const data = JSON.parse(row.payload) as Awaited<ReturnType<typeof computeMetrics>>;
    return { ...data, computedAt: row.computedAt };
  },
});

/**
 * Recomputes the cached metrics if they're older than maxAgeMs (default 30
 * minutes). Cheap when fresh: one small read. Called by open dashboards.
 */
export const refreshMetrics = mutation({
  args: { maxAgeMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const demoMode = await isDemoModeEnabled(ctx);
    const key = statsKey(demoMode);
    const row = await ctx.db
      .query("dashboardStats")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    const now = Date.now();
    const maxAge = Math.max(60_000, args.maxAgeMs ?? STATS_MAX_AGE_MS);
    if (row && now - row.computedAt < maxAge) return { refreshed: false, computedAt: row.computedAt };
    const payload = JSON.stringify(await computeMetrics(ctx, demoMode));
    if (row) await ctx.db.patch(row._id, { payload, computedAt: now });
    else await ctx.db.insert("dashboardStats", { key, payload, computedAt: now });
    return { refreshed: true, computedAt: now };
  },
});

export const imageStorageStats = query({
  args: {},
  handler: async (ctx) => {
    const demoMode = await isDemoModeEnabled(ctx);
    // Capped scan like the other dashboard queries — unbounded .collect()
    // throws TransactionTooLargeError when the bandwidth limit is exceeded.
    const msgs = await ctx.db
      .query("messages")
      .order("desc")
      .take(demoMode ? DEMO_SCAN_LIMIT : METRICS_SCAN_LIMIT);
    const seen = new Set<string>();
    let count = 0;
    for (const m of msgs.filter((message) => isDemoMessage(message) === demoMode)) {
      for (const id of m.imageStorageIds ?? []) {
        if (seen.has(id as unknown as string)) continue;
        seen.add(id as unknown as string);
        count++;
      }
    }
    return { count, truncated: msgs.length === METRICS_SCAN_LIMIT };
  },
});
