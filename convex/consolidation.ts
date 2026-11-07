import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { takeMatching, isDemoId, isDemoModeEnabled } from "./demoMode";

const statusV = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);

export const createRun = mutation({
  args: { runId: v.string(), trigger: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("consolidationRuns", {
      ...args,
      status: "running",
      proposalsCount: 0,
      mergedCount: 0,
      prunedCount: 0,
      startedAt: Date.now(),
    });
  },
});

export const updateRun = mutation({
  args: {
    runId: v.string(),
    status: v.optional(statusV),
    proposalsCount: v.optional(v.number()),
    mergedCount: v.optional(v.number()),
    prunedCount: v.optional(v.number()),
    notes: v.optional(v.string()),
    details: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { runId, ...patch } = args;
    const run = await ctx.db
      .query("consolidationRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", runId))
      .unique();
    if (!run) return null;
    const done = patch.status && patch.status !== "running";
    await ctx.db.patch(run._id, { ...patch, ...(done ? { completedAt: Date.now() } : {}) });
    return run._id;
  },
});

async function readRuns(ctx: QueryCtx, limit: number, demoOnly: boolean) {
  return takeMatching(
    ctx.db.query("consolidationRuns").order("desc"),
    (run) => isDemoId(run.runId) === demoOnly,
    limit,
  );
}

export const listRuns = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => readRuns(ctx, args.limit ?? 25, false),
});

export const listRunsForDashboard = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 25;
    return readRuns(ctx, limit, await isDemoModeEnabled(ctx));
  },
});
