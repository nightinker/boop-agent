import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { takeMatching, isDemoId, isDemoModeEnabled } from "./demoMode";

type AgentStatus = "spawned" | "running" | "completed" | "failed" | "cancelled";

const statusV = v.union(
  v.literal("spawned"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const create = mutation({
  args: {
    agentId: v.string(),
    conversationId: v.optional(v.string()),
    name: v.string(),
    task: v.string(),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    mcpServers: v.array(v.string()),
    retryOf: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("executionAgents", {
      ...args,
      status: "spawned",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      startedAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    agentId: v.string(),
    status: v.optional(statusV),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    cacheCreationTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { agentId, ...patch } = args;
    const agent = await ctx.db
      .query("executionAgents")
      .withIndex("by_agent_id", (q) => q.eq("agentId", agentId))
      .unique();
    if (!agent) return null;
    const completed = patch.status && ["completed", "failed", "cancelled"].includes(patch.status);
    await ctx.db.patch(agent._id, { ...patch, ...(completed ? { completedAt: Date.now() } : {}) });
    return agent._id;
  },
});

export const addLog = mutation({
  args: {
    agentId: v.string(),
    logType: v.union(
      v.literal("thinking"),
      v.literal("tool_use"),
      v.literal("tool_result"),
      v.literal("text"),
      v.literal("error"),
    ),
    toolName: v.optional(v.string()),
    accounts: v.optional(v.array(v.string())),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("agentLogs", { ...args, createdAt: Date.now() });
  },
});

async function readAgents(
  ctx: QueryCtx,
  args: { status?: AgentStatus; limit?: number },
  demoOnly: boolean,
) {
  const limit = args.limit ?? 50;
  // Stop once `limit` rows match, not after a fixed scan: a live dashboard
  // query re-runs on every agent write.
  const rows = args.status
    ? ctx.db
        .query("executionAgents")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .order("desc")
    : ctx.db.query("executionAgents").order("desc");
  return takeMatching(rows, (agent) => isDemoId(agent.agentId) === demoOnly, limit);
}

export const list = query({
  args: {
    status: v.optional(statusV),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => readAgents(ctx, args, false),
});

export const listForDashboard = query({
  args: {
    status: v.optional(statusV),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return readAgents(ctx, args, await isDemoModeEnabled(ctx));
  },
});

export const get = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    if (isDemoId(args.agentId)) return null;
    return await ctx.db
      .query("executionAgents")
      .withIndex("by_agent_id", (q) => q.eq("agentId", args.agentId))
      .unique();
  },
});

export const getLogs = query({
  args: { agentId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (isDemoId(args.agentId)) return [];
    return await ctx.db
      .query("agentLogs")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("asc")
      .take(args.limit ?? 500);
  },
});

export const getForDashboard = query({
  args: { agentId: v.string() },
  handler: async (ctx, args) => {
    if (isDemoId(args.agentId) !== (await isDemoModeEnabled(ctx))) return null;
    return await ctx.db
      .query("executionAgents")
      .withIndex("by_agent_id", (q) => q.eq("agentId", args.agentId))
      .unique();
  },
});

export const getLogsForDashboard = query({
  args: { agentId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (isDemoId(args.agentId) !== (await isDemoModeEnabled(ctx))) return [];
    return await ctx.db
      .query("agentLogs")
      .withIndex("by_agent", (q) => q.eq("agentId", args.agentId))
      .order("asc")
      .take(args.limit ?? 500);
  },
});

/**
 * How many agents are running, for the dashboard's sidebar badge. Reads only
 * running and spawned agents through the status index, not the whole table.
 */
export const activeCount = query({
  args: {},
  handler: async (ctx) => {
    const demoOnly = await isDemoModeEnabled(ctx);
    let count = 0;
    for (const status of ["running", "spawned"] as const) {
      const rows = await ctx.db
        .query("executionAgents")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(200);
      count += rows.filter((agent) => isDemoId(agent.agentId) === demoOnly).length;
    }
    return count;
  },
});
