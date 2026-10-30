import { mutation, query, type MutationCtx } from "./_generated/server.js";
import { v } from "convex/values";

const originV = v.union(
  v.literal("execution"),
  v.literal("review"),
  v.literal("correction"),
  v.literal("user"),
  v.literal("learn"),
  v.literal("curator"),
);
type Origin = "execution" | "review" | "correction" | "user" | "learn" | "curator";

async function findSkill(ctx: MutationCtx, name: string) {
  return await ctx.db
    .query("skills")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

async function applyCreate(
  ctx: MutationCtx,
  args: {
    name: string;
    description: string;
    body: string;
    origin: Origin;
    reason?: string;
    agentId?: string;
  },
) {
  if (await findSkill(ctx, args.name)) throw new Error(`A skill named "${args.name}" already exists`);
  const now = Date.now();
  await ctx.db.insert("skills", {
    name: args.name,
    description: args.description,
    body: args.body,
    status: "active",
    pinned: false,
    createdBy: args.origin === "user" ? "user" : "agent",
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
}

async function applyUpdate(
  ctx: MutationCtx,
  args: {
    name: string;
    description?: string;
    body: string;
    action: "patch" | "rewrite";
    origin: Origin;
    reason?: string;
    agentId?: string;
  },
) {
  const skill = await findSkill(ctx, args.name);
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
    stale: false,
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
}

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
    createdBy: v.optional(v.union(v.literal("agent"), v.literal("user"))),
    origin: originV,
    reason: v.optional(v.string()),
    agentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await applyCreate(ctx, args);
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
    await applyUpdate(ctx, args);
  },
});

export const recordView = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const skill = await findSkill(ctx, args.name);
    if (!skill) return;
    await ctx.db.patch(skill._id, {
      viewCount: skill.viewCount + 1,
      lastUsedAt: Date.now(),
      stale: false,
    });
  },
});

export const setPinned = mutation({
  args: { name: v.string(), pinned: v.boolean() },
  handler: async (ctx, args) => {
    const skill = await findSkill(ctx, args.name);
    if (!skill) throw new Error(`No skill named "${args.name}"`);
    await ctx.db.patch(skill._id, { pinned: args.pinned, updatedAt: Date.now() });
  },
});

/** Archived skills leave the agents' index but keep their body and history. */
export const setArchived = mutation({
  args: { name: v.string(), archived: v.boolean() },
  handler: async (ctx, args) => {
    const skill = await findSkill(ctx, args.name);
    if (!skill) throw new Error(`No skill named "${args.name}"`);
    const now = Date.now();
    await ctx.db.patch(skill._id, {
      status: args.archived ? "archived" : "active",
      updatedAt: now,
    });
    await ctx.db.insert("skillRevisions", {
      name: skill.name,
      action: args.archived ? "archive" : "restore",
      description: skill.description,
      body: skill.body,
      origin: "user",
      createdAt: now,
    });
  },
});

export const listPending = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("skillPendingChanges")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .collect();
  },
});

export const stage = mutation({
  args: {
    name: v.string(),
    action: v.union(v.literal("create"), v.literal("patch"), v.literal("rewrite")),
    description: v.string(),
    body: v.string(),
    reason: v.optional(v.string()),
    origin: originV,
    agentId: v.optional(v.string()),
    batchId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.batchId) {
      const pending = await ctx.db
        .query("skillPendingChanges")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .collect();
      const sameRun = pending.find((c) => c.batchId === args.batchId && c.name === args.name);
      if (sameRun) {
        await ctx.db.patch(sameRun._id, {
          description: args.description,
          body: args.body,
          reason: [sameRun.reason, args.reason].filter(Boolean).join(" · ") || undefined,
          action: sameRun.action === "create" ? "create" : args.action,
        });
        return;
      }
    }
    const current = await findSkill(ctx, args.name);
    await ctx.db.insert("skillPendingChanges", {
      ...args,
      previousBody: current?.body,
      previousDescription: current?.description,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const resolvePending = mutation({
  args: { id: v.id("skillPendingChanges"), approve: v.boolean() },
  handler: async (ctx, args) => {
    const change = await ctx.db.get(args.id);
    if (!change || change.status !== "pending") throw new Error("That change is no longer pending");
    if (args.approve) {
      const input = {
        name: change.name,
        description: change.description,
        body: change.body,
        origin: change.origin,
        reason: change.reason,
        agentId: change.agentId,
      };
      if (change.action === "create") {
        await applyCreate(ctx, input);
      } else {
        const current = await findSkill(ctx, change.name);
        if (current && change.previousBody !== undefined && current.body !== change.previousBody) {
          throw new Error(
            `"${change.name}" changed after this edit was proposed. Reject it; the next review will propose a fresh one.`,
          );
        }
        await applyUpdate(ctx, { ...input, action: change.action });
      }
    }
    await ctx.db.patch(change._id, {
      status: args.approve ? "approved" : "rejected",
      resolvedAt: Date.now(),
    });
  },
});

/**
 * Applies the curator's decisions. Archiving keeps the body and history
 * (restore brings it back); nothing is ever deleted.
 */
export const applyCuration = mutation({
  args: {
    markStale: v.array(v.string()),
    archive: v.array(v.string()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const name of args.markStale) {
      const skill = await findSkill(ctx, name);
      if (skill && skill.status === "active" && !skill.pinned) {
        await ctx.db.patch(skill._id, { stale: true });
      }
    }
    for (const name of args.archive) {
      const skill = await findSkill(ctx, name);
      if (!skill || skill.status !== "active" || skill.pinned) continue;
      await ctx.db.patch(skill._id, { status: "archived", stale: false, updatedAt: now });
      await ctx.db.insert("skillRevisions", {
        name: skill.name,
        action: "archive",
        description: skill.description,
        body: skill.body,
        reason: args.reason,
        origin: "curator",
        createdAt: now,
      });
    }
  },
});

/** Archive one skill on behalf of an agent (the curator's merge pass). */
export const archiveByAgent = mutation({
  args: { name: v.string(), reason: v.string(), origin: originV },
  handler: async (ctx, args) => {
    const skill = await findSkill(ctx, args.name);
    if (!skill) throw new Error(`No skill named "${args.name}"`);
    if (skill.pinned) throw new Error(`"${args.name}" is pinned`);
    const now = Date.now();
    await ctx.db.patch(skill._id, { status: "archived", stale: false, updatedAt: now });
    await ctx.db.insert("skillRevisions", {
      name: skill.name,
      action: "archive",
      description: skill.description,
      body: skill.body,
      reason: args.reason,
      origin: args.origin,
      createdAt: now,
    });
  },
});
