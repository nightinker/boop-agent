import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

const originV = v.union(
  v.literal("execution"),
  v.literal("review"),
  v.literal("correction"),
  v.literal("user"),
);

export const list = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const rows = args.includeArchived
      ? await ctx.db.query("skills").collect()
      : await ctx.db
          .query("skills")
          .withIndex("by_status", (q) => q.eq("status", "active"))
          .collect();
    return rows.sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt));
  },
});

export const get = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
  },
});

export const revisions = query({
  args: { name: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("skillRevisions")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .order("desc")
      .take(args.limit ?? 20);
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    body: v.string(),
    createdBy: v.union(v.literal("agent"), v.literal("user")),
    origin: originV,
    reason: v.optional(v.string()),
    agentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (existing) throw new Error(`A skill named "${args.name}" already exists`);
    const now = Date.now();
    await ctx.db.insert("skills", {
      name: args.name,
      description: args.description,
      body: args.body,
      status: "active",
      pinned: false,
      createdBy: args.createdBy,
      viewCount: 0,
      patchCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("skillRevisions", {
      name: args.name,
      action: "create",
      description: args.description,
      body: args.body,
      reason: args.reason,
      origin: args.origin,
      agentId: args.agentId,
      createdAt: now,
    });
  },
});

export const update = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    body: v.string(),
    action: v.union(v.literal("patch"), v.literal("rewrite")),
    origin: originV,
    reason: v.optional(v.string()),
    agentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const skill = await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (!skill) throw new Error(`No skill named "${args.name}"`);
    if (skill.pinned && args.origin !== "user") {
      throw new Error(`"${args.name}" is pinned; only the user can change it`);
    }
    const now = Date.now();
    const description = args.description ?? skill.description;
    await ctx.db.patch(skill._id, {
      description,
      body: args.body,
      status: "active",
      patchCount: skill.patchCount + 1,
      updatedAt: now,
    });
    await ctx.db.insert("skillRevisions", {
      name: args.name,
      action: args.action,
      description,
      body: args.body,
      reason: args.reason,
      origin: args.origin,
      agentId: args.agentId,
      createdAt: now,
    });
  },
});

export const recordView = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const skill = await ctx.db
      .query("skills")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (!skill) return;
    const now = Date.now();
    await ctx.db.patch(skill._id, { viewCount: skill.viewCount + 1, lastUsedAt: now });
  },
});
