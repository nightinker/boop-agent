import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { v } from "convex/values";

const statusV = v.union(
  v.literal("queued"),
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

// While a build is in one of these, the next queued build waits.
const ACTIVE = ["coding", "testing", "shipping", "restarting"] as const;

async function firstActive(ctx: MutationCtx) {
  for (const status of ACTIVE) {
    const build = await ctx.db
      .query("selfBuilds")
      .withIndex("by_status_and_createdAt", (q) => q.eq("status", status))
      .first();
    if (build) return build;
  }
  return null;
}

export const create = mutation({
  args: { buildId: v.string(), conversationId: v.string(), request: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("selfBuilds", { ...args, status: "coding", createdAt: now, updatedAt: now });
  },
});

/**
 * Starts the build now if nothing else is building, otherwise puts it in line.
 * One transaction, so two requests at once can't both start.
 */
export const enqueue = mutation({
  args: {
    buildId: v.string(),
    conversationId: v.string(),
    request: v.string(),
    // The build this one re-runs (Retry).
    retryOf: v.optional(v.string()),
    // Always queue, even if nothing is building: used when the copy taking
    // the request can't build (a server), so the Mac starts it later.
    forceQueue: v.optional(v.boolean()),
  },
  handler: async (ctx, { forceQueue, ...args }) => {
    const now = Date.now();
    const active = await firstActive(ctx);
    if (!active && !forceQueue) {
      await ctx.db.insert("selfBuilds", { ...args, status: "coding", createdAt: now, updatedAt: now });
      return { status: "coding" as const, position: 0, blockedBy: null };
    }
    const ahead = await ctx.db
      .query("selfBuilds")
      .withIndex("by_status_and_createdAt", (q) => q.eq("status", "queued"))
      .take(100);
    await ctx.db.insert("selfBuilds", { ...args, status: "queued", createdAt: now, updatedAt: now });
    return {
      status: "queued" as const,
      position: ahead.length + 1,
      blockedBy: active ? { buildId: active.buildId, status: active.status } : null,
    };
  },
});

/** Moves the oldest queued build to "coding", if nothing else is building. */
export const claimNextQueued = mutation({
  args: {},
  handler: async (ctx) => {
    if (await firstActive(ctx)) return null;
    const next = await ctx.db
      .query("selfBuilds")
      .withIndex("by_status_and_createdAt", (q) => q.eq("status", "queued"))
      .first();
    if (!next) return null;
    await ctx.db.patch("selfBuilds", next._id, { status: "coding", updatedAt: Date.now() });
    return { buildId: next.buildId, conversationId: next.conversationId, request: next.request };
  },
});

/**
 * Called on startup, after any pending restart result has been reported.
 * Builds still coding, testing or shipping lost their process when Boop
 * restarted, and one still "restarting" never got its result back. They're
 * marked failed so the queue can move on.
 */
export const failInterrupted = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const interrupted: { buildId: string; conversationId: string; request: string; status: string }[] = [];
    for (const status of ACTIVE) {
      const rows = await ctx.db
        .query("selfBuilds")
        .withIndex("by_status_and_createdAt", (q) => q.eq("status", status))
        .take(20);
      for (const build of rows) {
        await ctx.db.patch("selfBuilds", build._id, {
          status: "failed",
          error:
            status === "restarting"
              ? "The restart never reported whether the new version started."
              : `Boop restarted while this build was ${status}.`,
          updatedAt: now,
        });
        interrupted.push({
          buildId: build.buildId,
          conversationId: build.conversationId,
          request: build.request,
          status,
        });
      }
    }
    return interrupted;
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
    startupLogPath: v.optional(v.string()),
    startupLogTail: v.optional(v.string()),
    activity: v.optional(v.string()),
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

/** Builds waiting their turn, oldest (next up) first. */
export const queued = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("selfBuilds")
      .withIndex("by_status_and_createdAt", (q) => q.eq("status", "queued"))
      .take(50);
  },
});

/**
 * The dashboard's Self-builds page: the same rows list_self_builds reads
 * (recent builds plus the queue, oldest queued first), with more history.
 */
export const forDashboard = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const [recent, queued] = await Promise.all([
      ctx.db
        .query("selfBuilds")
        .withIndex("by_createdAt")
        .order("desc")
        .take(Math.min(Math.max(args.limit ?? 25, 1), 100)),
      ctx.db
        .query("selfBuilds")
        .withIndex("by_status_and_createdAt", (q) => q.eq("status", "queued"))
        .take(50),
    ]);
    return { recent, queued };
  },
});

/**
 * Builds queued or running, with only what a badge or the keep-awake check
 * needs. Reads just those rows through the status index instead of the recent
 * builds' full text (requests, summaries, logs), so polling it stays cheap.
 */
export const inProgress = query({
  args: {},
  handler: async (ctx) => {
    const rows = [];
    for (const status of [...ACTIVE, "queued"] as const) {
      const builds = await ctx.db
        .query("selfBuilds")
        .withIndex("by_status_and_createdAt", (q) => q.eq("status", status))
        .take(50);
      for (const b of builds) rows.push({ buildId: b.buildId, status: b.status, createdAt: b.createdAt });
    }
    return rows;
  },
});
