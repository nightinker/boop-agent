import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { isOnline, pickActive, type InstanceRow } from "./instanceRules";

function summarize(rows: InstanceRow[], now: number) {
  const active = pickActive(rows, now);
  return {
    activeInstanceId: active?.instanceId ?? null,
    instances: rows
      .map((row) => ({
        instanceId: row.instanceId,
        label: row.label,
        platform: row.platform,
        priority: row.priority,
        publicUrl: row.publicUrl ?? null,
        lastSeenAt: row.lastSeenAt,
        online: isOnline(row, now),
      }))
      .sort((a, b) => b.priority - a.priority),
  };
}

/**
 * Records that a copy of Boop is alive and returns which copy is active.
 * Every copy runs this on the same table in one transaction, so they always
 * agree on the answer.
 */
export const checkIn = mutation({
  args: {
    instanceId: v.string(),
    label: v.string(),
    platform: v.string(),
    priority: v.number(),
    publicUrl: v.optional(v.string()),
    startedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("instances")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", args.instanceId))
      .unique();
    if (existing) {
      await ctx.db.patch("instances", existing._id, { ...args, lastSeenAt: now });
    } else {
      await ctx.db.insert("instances", { ...args, lastSeenAt: now });
    }
    const rows = await ctx.db.query("instances").take(20);
    return summarize(rows, now);
  },
});

/** A clean shutdown: hand over right away instead of waiting to time out. */
export const leave = mutation({
  args: { instanceId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("instances")
      .withIndex("by_instanceId", (q) => q.eq("instanceId", args.instanceId))
      .unique();
    if (existing) await ctx.db.patch("instances", existing._id, { lastSeenAt: 0 });
    return null;
  },
});

export const list = query({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("instances").take(20);
    return summarize(rows, args.now);
  },
});
