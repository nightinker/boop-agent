import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";

// A text left "processing" this many times (Boop crashed or restarted while
// answering it) is given up on instead of retried again.
const MAX_ATTEMPTS = 3;

// A text "processing" longer than this lost its worker without the server
// restarting (a dropped status update). It stops blocking its conversation.
const STALE_PROCESSING_MS = 30 * 60_000;

// Most texts one batched turn takes; anything past this waits for the next.
const MAX_BATCH = 50;

// Most answers one conversation may run at once (the maxConcurrentRuns
// setting is clamped to this on the server too).
const MAX_CONCURRENT_CEILING = 5;

function clampConcurrent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(MAX_CONCURRENT_CEILING, Math.max(1, Math.floor(value)));
}

function isStale(row: { startedAt?: number; enqueuedAt: number }, now: number): boolean {
  return now - (row.startedAt ?? row.enqueuedAt) >= STALE_PROCESSING_MS;
}

/** Live (non-stale) texts being answered in a conversation right now. */
async function liveProcessing(ctx: QueryCtx, conversationId: string) {
  const rows = await ctx.db
    .query("inboundMessages")
    .withIndex("by_conversationId_and_status_and_enqueuedAt", (q) =>
      q.eq("conversationId", conversationId).eq("status", "processing"),
    )
    .take(MAX_BATCH * 2);
  const now = Date.now();
  return { live: rows.filter((row) => !isStale(row, now)), stale: rows.filter((row) => isStale(row, now)) };
}

/**
 * How many more answers this conversation may start (0 = every slot is in
 * use). A text "processing" too long lost its worker: it's marked failed so
 * it stops holding a slot. Counted inside the claiming transaction, so two
 * copies (or two workers) can never start more than maxConcurrent between them.
 */
async function freeSlots(ctx: MutationCtx, conversationId: string, maxConcurrent: number | undefined): Promise<number> {
  const { live, stale } = await liveProcessing(ctx, conversationId);
  for (const row of stale) {
    await ctx.db.patch("inboundMessages", row._id, {
      status: "failed",
      finishedAt: Date.now(),
      error: "Answering it never finished.",
    });
  }
  return Math.max(0, clampConcurrent(maxConcurrent) - live.length);
}

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
 * Hands out the oldest queued text in a conversation, but only while fewer
 * than maxConcurrent texts there are being answered (default 1: one at a
 * time, in order).
 */
export const claimNext = mutation({
  args: { conversationId: v.string(), maxConcurrent: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if ((await freeSlots(ctx, args.conversationId, args.maxConcurrent)) === 0) return null;

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

/**
 * Hands out every queued text in a conversation (oldest first, up to a cap)
 * as one batch, under the same slot rule as claimNext. Used when Boop waits
 * for a quiet period and answers a burst of texts in one turn.
 */
export const claimQueued = mutation({
  args: {
    conversationId: v.string(),
    // Stop at the first text sent more than this long after the one before
    // it, so texts that piled up far apart are answered as separate turns.
    maxGapMs: v.optional(v.number()),
    maxConcurrent: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if ((await freeSlots(ctx, args.conversationId, args.maxConcurrent)) === 0) return [];

    const queued = await ctx.db
      .query("inboundMessages")
      .withIndex("by_conversationId_and_status_and_enqueuedAt", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "queued"),
      )
      .take(MAX_BATCH);
    const now = Date.now();
    const claimed = [];
    for (const [i, row] of queued.entries()) {
      if (args.maxGapMs !== undefined && i > 0 && Math.abs(row.receivedAt - queued[i - 1].receivedAt) > args.maxGapMs) {
        break;
      }
      await ctx.db.patch("inboundMessages", row._id, {
        status: "processing",
        attempts: row.attempts + 1,
        startedAt: now,
      });
      claimed.push({ ...row, status: "processing" as const, attempts: row.attempts + 1, startedAt: now });
    }
    return claimed;
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

/** Shortens a queued text for status views; the full text stays in the row. */
function preview(content: string): string {
  return content.length > 140 ? `${content.slice(0, 140)}…` : content;
}

/**
 * Whether a conversation is being answered right now (and how many answers
 * are running), and the texts waiting for a free slot, oldest first. Used for the "queued (position N)" ack
 * and for "never mind" while texts are waiting.
 */
export const waiting = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    const { live } = await liveProcessing(ctx, args.conversationId);
    const queued = await ctx.db
      .query("inboundMessages")
      .withIndex("by_conversationId_and_status_and_enqueuedAt", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "queued"),
      )
      .take(MAX_BATCH * 2);
    return {
      busy: live.length > 0,
      processing: live.length,
      queued: queued.map((row) => ({ _id: row._id, handle: row.handle })),
    };
  },
});

/**
 * Drops texts that are still waiting (a "never mind" sent while Boop was
 * busy). Rows already being answered are left alone. Returns how many it dropped.
 */
export const cancelQueued = mutation({
  args: { ids: v.array(v.id("inboundMessages")), reason: v.string() },
  handler: async (ctx, args) => {
    let cancelled = 0;
    for (const id of args.ids.slice(0, MAX_BATCH * 2)) {
      const row = await ctx.db.get("inboundMessages", id);
      if (!row || row.status !== "queued") continue;
      await ctx.db.patch("inboundMessages", id, {
        status: "cancelled",
        finishedAt: Date.now(),
        error: args.reason.slice(0, 2000),
      });
      cancelled++;
    }
    return cancelled;
  },
});

/**
 * What is being answered and what is waiting, per conversation: for the
 * dashboard and Boop's own list_queued_messages tool.
 */
export const queueOverview = query({
  args: {},
  handler: async (ctx) => {
    const [processing, queued] = await Promise.all([
      ctx.db
        .query("inboundMessages")
        .withIndex("by_status_and_enqueuedAt", (q) => q.eq("status", "processing"))
        .take(100),
      ctx.db
        .query("inboundMessages")
        .withIndex("by_status_and_enqueuedAt", (q) => q.eq("status", "queued"))
        .take(200),
    ]);
    const now = Date.now();
    const byConversation = new Map<
      string,
      {
        conversationId: string;
        answeringSince: number | null;
        answering: number;
        queued: Array<{ _id: string; content: string; mediaCount: number; receivedAt: number; enqueuedAt: number }>;
      }
    >();
    const entry = (conversationId: string) => {
      let found = byConversation.get(conversationId);
      if (!found) {
        found = { conversationId, answeringSince: null, answering: 0, queued: [] };
        byConversation.set(conversationId, found);
      }
      return found;
    };
    for (const row of processing) {
      const since = row.startedAt ?? row.enqueuedAt;
      if (now - since >= STALE_PROCESSING_MS) continue;
      const found = entry(row.conversationId);
      found.answeringSince = found.answeringSince === null ? since : Math.min(found.answeringSince, since);
      found.answering++;
    }
    for (const row of queued) {
      entry(row.conversationId).queued.push({
        _id: row._id,
        content: preview(row.content),
        mediaCount: row.mediaUrls.length,
        receivedAt: row.receivedAt,
        enqueuedAt: row.enqueuedAt,
      });
    }
    return {
      totalQueued: queued.length,
      conversations: [...byConversation.values()].filter(
        (c) => c.queued.length > 0 || c.answeringSince !== null,
      ),
    };
  },
});
