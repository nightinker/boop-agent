import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Saves a reply that couldn't be sent, for the active copy to resend. */
export const add = mutation({
  args: { conversationId: v.string(), toNumber: v.string(), content: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return await ctx.db.insert("replyOutbox", {
      conversationId: args.conversationId,
      toNumber: args.toNumber,
      content: args.content,
      createdAt: Date.now(),
      attempts: 0,
      ...(args.error ? { lastError: args.error.slice(0, 500) } : {}),
    });
  },
});

/** The oldest waiting replies. */
export const pending = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("replyOutbox").withIndex("by_createdAt").order("asc").take(10);
  },
});

/** Sent (or too old to send): remove it. */
export const remove = mutation({
  args: { id: v.id("replyOutbox") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("replyOutbox", args.id);
    if (row) await ctx.db.delete("replyOutbox", args.id);
    return null;
  },
});

/** A resend failed; it stays for the next try. */
export const noteAttempt = mutation({
  args: { id: v.id("replyOutbox"), error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("replyOutbox", args.id);
    if (!row) return null;
    await ctx.db.patch("replyOutbox", args.id, { attempts: row.attempts + 1, lastError: args.error.slice(0, 500) });
    return null;
  },
});
