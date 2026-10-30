import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

export const record = mutation({
  args: {
    key: v.string(),
    channel: v.string(),
    ts: v.string(),
    threadTs: v.optional(v.string()),
    kind: v.union(v.literal("dm"), v.literal("mention")),
    sender: v.string(),
    channelName: v.optional(v.string()),
    text: v.string(),
    summary: v.string(),
    permalink: v.string(),
    urgent: v.boolean(),
    notified: v.boolean(),
  },
  handler: async (ctx, { notified, ...args }) => {
    const existing = await ctx.db
      .query("slackMentions")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("slackMentions", {
      ...args,
      ...(notified ? { notifiedAt: Date.now() } : {}),
      createdAt: Date.now(),
    });
  },
});

/**
 * The user wrote in this conversation, so mentions they have now seen are
 * answered. `root` is the thread the user's message belongs to (its own ts
 * when it is top-level); `topLevel` says whether it was top-level.
 */
export const markAnswered = mutation({
  args: { channel: v.string(), root: v.string(), topLevel: v.boolean(), ts: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("slackMentions")
      .withIndex("by_channel", (q) => q.eq("channel", args.channel))
      .collect();
    let count = 0;
    for (const row of rows) {
      if (row.answeredAt || Number(row.ts) > Number(args.ts)) continue;
      const rowRoot = row.threadTs ?? row.ts;
      const sameThread = rowRoot === args.root;
      const sameTopLevel = args.topLevel && (row.kind === "dm" || !row.threadTs);
      if (sameThread || sameTopLevel) {
        await ctx.db.patch(row._id, { answeredAt: Date.now() });
        count += 1;
      }
    }
    return count;
  },
});

/** Unanswered mentions not yet in a digest, oldest first. */
export const pendingDigest = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("slackMentions").withIndex("by_created").order("asc").collect();
    return rows.filter((r) => !r.answeredAt && !r.digestedAt);
  },
});

export const markDigested = mutation({
  args: { ids: v.array(v.id("slackMentions")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) await ctx.db.patch(id, { digestedAt: Date.now() });
  },
});

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("slackMentions")
      .withIndex("by_created")
      .order("desc")
      .take(limit ?? 20);
  },
});
