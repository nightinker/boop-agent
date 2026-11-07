import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { takeMatching, isDemoId, isDemoMemoryEvent, isDemoModeEnabled } from "./demoMode";

export const emit = mutation({
  args: {
    eventType: v.string(),
    conversationId: v.optional(v.string()),
    memoryId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    data: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("memoryEvents", { ...args, createdAt: Date.now() });
  },
});

async function readRecent(
  ctx: QueryCtx,
  limit: number,
  demoOnly: boolean,
) {
  return takeMatching(
    ctx.db.query("memoryEvents").order("desc"),
    (event) => isDemoMemoryEvent(event) === demoOnly,
    limit,
  );
}

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => readRecent(ctx, args.limit ?? 100, false),
});

export const recentForDashboard = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    return readRecent(ctx, limit, await isDemoModeEnabled(ctx));
  },
});

export const byConversation = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (isDemoId(args.conversationId)) return [];
    return await ctx.db
      .query("memoryEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(args.limit ?? 100);
  },
});

export const byConversationForDashboard = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (isDemoId(args.conversationId) !== (await isDemoModeEnabled(ctx))) return [];
    return await ctx.db
      .query("memoryEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(args.limit ?? 50);
  },
});
