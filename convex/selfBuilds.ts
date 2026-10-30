import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

const statusV = v.union(
  v.literal("coding"),
  v.literal("testing"),
  v.literal("pr_open"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("shipping"),
  v.literal("restarting"),
  v.literal("shipped"),
  v.literal("rolled_back"),
);

export const create = mutation({
  args: { buildId: v.string(), conversationId: v.string(), request: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("selfBuilds", { ...args, status: "coding", createdAt: now, updatedAt: now });
  },
});

export const update = mutation({
  args: {
    buildId: v.string(),
    status: v.optional(statusV),
    branch: v.optional(v.string()),
    worktreePath: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    summary: v.optional(v.string()),
    testsPassed: v.optional(v.boolean()),
    testOutput: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { buildId, ...patch }) => {
    const build = await ctx.db
      .query("selfBuilds")
      .withIndex("by_buildId", (q) => q.eq("buildId", buildId))
      .unique();
    if (!build) throw new Error(`No self-build ${buildId}`);
    const fields = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    await ctx.db.patch(build._id, { ...fields, updatedAt: Date.now() });
  },
});

export const get = query({
  args: { buildId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("selfBuilds")
      .withIndex("by_buildId", (q) => q.eq("buildId", args.buildId))
      .unique();
  },
});

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("selfBuilds")
      .withIndex("by_createdAt")
      .order("desc")
      .take(args.limit ?? 10);
  },
});
