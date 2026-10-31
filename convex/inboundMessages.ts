import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// A text left "processing" this many times (Boop crashed or restarted while
// answering it) is given up on instead of retried again.
const MAX_ATTEMPTS = 3;

// A text "processing" longer than this lost its worker without the server
// restarting (a dropped status update). It stops blocking its conversation.
const STALE_PROCESSING_MS = 30 * 60_000;

/**
 * Saves an inbound text unless one with the same Sendblue handle was already
 * saved, or already answered by the older dedup table (texts handled before
 * this queue existed). Runs in one transaction, so the webhook and the
 * poller can race on the same text and only one of them wins.
 */
export const enqueue = mutation({
  args: {
    handle: v.string(),
    conversationId: v.string(),
    fromNumber: v.string(),
    content: v.string(),
    mediaUrls: v.array(v.string()),
    source: v.union(v.literal("webhook"), v.literal("poll")),
    receivedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("inboundMessages")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .first();
    if (existing) return { enqueued: false };
    const legacy = await ctx.db
      .query("sendblueDedup")
      .withIndex("by_handle", (q) => q.eq("handle", args.handle))
      .first();
    if (legacy) return { enqueued: false };

    await ctx.db.insert("inboundMessages", {
      ...args,
      status: "queued",
      attempts: 0,
      enqueuedAt: Date.now(),
    });
    return { enqueued: true };
  },
});

/**
 * Hands out the oldest queued text in a conversation, but only when nothing
 * else in that conversation is being answered, so texts are handled one at
 * a time and in order.
 */
export const claimNext = mutation({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    const busy = await ctx.db
      .query("inboundMessages")
      .withIndex("by_conversationId_and_status_and_enqueuedAt", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "processing"),
      )
      .first();
    if (busy) {
      if (Date.now() - (busy.startedAt ?? busy.enqueuedAt) < STALE_PROCESSING_MS) return null;
      await ctx.db.patch("inboundMessages", busy._id, {
        status: "failed",
        finishedAt: Date.now(),
        error: "Answering it never finished.",
      });
    }

    const next = await ctx.db
      .query("inboundMessages")
      .withIndex("by_conversationId_and_status_and_enqueuedAt", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "queued"),
      )
      .first();
    if (!next) return null;

    const now = Date.now();
    await ctx.db.patch("inboundMessages", next._id, {
      status: "processing",
      attempts: next.attempts + 1,
      startedAt: now,
    });
    return { ...next, status: "processing" as const, attempts: next.attempts + 1, startedAt: now };
  },
});

export const finish = mutation({
  args: {
    id: v.id("inboundMessages"),
    status: v.union(v.literal("done"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("inboundMessages", args.id);
    if (!row) return null;
    await ctx.db.patch("inboundMessages", args.id, {
      status: args.status,
      finishedAt: Date.now(),
      ...(args.error ? { error: args.error.slice(0, 2000) } : {}),
    });
    return null;
  },
});

/**
 * Called once when the server starts: anything still "processing" was cut off
 * by a crash or restart. Put it back in line, or give up after MAX_ATTEMPTS.
 */
export const recoverInterrupted = mutation({
  args: {},
  handler: async (ctx) => {
    const stuck = await ctx.db
      .query("inboundMessages")
      .withIndex("by_status_and_enqueuedAt", (q) => q.eq("status", "processing"))
      .take(100);
    let requeued = 0;
    let failed = 0;
    for (const row of stuck) {
      if (row.attempts >= MAX_ATTEMPTS) {
        await ctx.db.patch("inboundMessages", row._id, {
          status: "failed",
          finishedAt: Date.now(),
          error: "Interrupted too many times while being answered.",
        });
        failed++;
      } else {
        await ctx.db.patch("inboundMessages", row._id, { status: "queued" });
        requeued++;
      }
    }
    return { requeued, failed };
  },
});

/** Conversations that have texts waiting, oldest first. */
export const pendingConversations = query({
  args: {},
  handler: async (ctx) => {
    const queued = await ctx.db
      .query("inboundMessages")
      .withIndex("by_status_and_enqueuedAt", (q) => q.eq("status", "queued"))
      .take(200);
    return [...new Set(queued.map((row) => row.conversationId))];
  },
});

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("inboundMessages")
      .order("desc")
      .take(Math.min(args.limit ?? 20, 100));
  },
});
