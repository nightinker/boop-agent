import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { scanForSecrets } from "../secrets/redact.js";
import {
  SEGMENT_DEFAULTS,
  makeMemoryId,
  type MemorySegment,
  type MemoryTier,
} from "../memory/types.js";

export const DEFAULT_CONVERSATION_ID = "mcp:claude-code";
export const DEFAULT_BOOP_URL = "http://localhost:3456";
const MESSAGE_PREVIEW_LIMIT = 4000;

export interface BoopMcpContext {
  convex: ConvexHttpClient;
  convexUrl: string;
  boopUrl: string;
  /** Returns null when no embedding could be produced. */
  embed: (text: string) => Promise<number[] | null>;
  allowRemoteWrites: boolean;
  fetchImpl?: typeof fetch;
}

export function isLocalConvexUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Writes are only allowed against a local backend unless the operator opted in
 * with BOOP_MCP_ALLOW_REMOTE_WRITES=1. Reads are never blocked.
 */
export function assertWritable(ctx: BoopMcpContext): void {
  if (isLocalConvexUrl(ctx.convexUrl) || ctx.allowRemoteWrites) return;
  throw new Error(
    "Refusing to write: CONVEX_URL is not a local backend. Set BOOP_MCP_ALLOW_REMOTE_WRITES=1 on the MCP server to allow writes to the real deployment.",
  );
}

export interface MemoryView {
  memoryId: string;
  content: string;
  tier: MemoryTier;
  segment: MemorySegment;
  importance: number;
  lifecycle: string;
  accessCount: number;
  createdAt?: number;
  lastAccessedAt: number;
}

function toView(r: MemoryView & Record<string, unknown>): MemoryView {
  return {
    memoryId: r.memoryId,
    content: r.content,
    tier: r.tier,
    segment: r.segment,
    importance: r.importance,
    lifecycle: r.lifecycle,
    accessCount: r.accessCount,
    createdAt: r.createdAt,
    lastAccessedAt: r.lastAccessedAt,
  };
}

function rejectSecret(content: string): void {
  if (scanForSecrets(content).found) {
    throw new Error("Not stored: that looks like it contains a secret. Secrets never go into memory.");
  }
}

export async function listMemories(
  ctx: BoopMcpContext,
  args: {
    tier?: MemoryTier;
    segment?: MemorySegment;
    lifecycle?: "active" | "archived" | "pruned";
    limit?: number;
  },
): Promise<MemoryView[]> {
  const rows = await ctx.convex.query(api.memoryRecords.list, args);
  return rows.map((r) => toView(r as never));
}

export async function searchMemories(
  ctx: BoopMcpContext,
  args: { query: string; limit?: number },
): Promise<MemoryView[]> {
  const rows = await ctx.convex.query(api.memoryRecords.search, args);
  return rows.map((r) => toView(r as never));
}

async function embedOrNull(ctx: BoopMcpContext, content: string): Promise<number[] | undefined> {
  try {
    return (await ctx.embed(content)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function findMemory(ctx: BoopMcpContext, memoryId: string): Promise<MemoryView | null> {
  for (const lifecycle of ["active", "archived", "pruned"] as const) {
    const rows = await ctx.convex.query(api.memoryRecords.list, { lifecycle, limit: 1000 });
    const hit = rows.find((r) => r.memoryId === memoryId);
    if (hit) return toView(hit as never);
  }
  return null;
}

export async function addMemory(
  ctx: BoopMcpContext,
  args: {
    content: string;
    segment: MemorySegment;
    importance?: number;
    tier?: MemoryTier;
    supersedes?: string[];
  },
): Promise<{ memoryId: string; tier: MemoryTier; embedded: boolean }> {
  assertWritable(ctx);
  rejectSecret(args.content);
  const defaults = SEGMENT_DEFAULTS[args.segment];
  const tier = args.tier ?? defaults.tier;
  const memoryId = makeMemoryId();
  const embedding = await embedOrNull(ctx, args.content);
  await ctx.convex.mutation(api.memoryRecords.upsert, {
    memoryId,
    content: args.content,
    tier,
    segment: args.segment,
    importance: args.importance ?? defaults.importance,
    decayRate: defaults.decayRate,
    supersedes: args.supersedes,
    embedding,
  });
  await ctx.convex.mutation(api.memoryEvents.emit, {
    eventType: "memory.written",
    memoryId,
    data: JSON.stringify({ tier, segment: args.segment, source: "mcp" }),
  });
  return { memoryId, tier, embedded: Boolean(embedding) };
}

export async function updateMemory(
  ctx: BoopMcpContext,
  args: {
    memoryId: string;
    content?: string;
    segment?: MemorySegment;
    importance?: number;
    tier?: MemoryTier;
  },
): Promise<{ memoryId: string; embedded: boolean | "kept-old-vector" }> {
  assertWritable(ctx);
  if (args.content !== undefined) rejectSecret(args.content);
  const existing = await findMemory(ctx, args.memoryId);
  if (!existing) throw new Error(`No memory with id ${args.memoryId}.`);
  const segment = args.segment ?? existing.segment;
  const content = args.content ?? existing.content;
  const embedding =
    args.content !== undefined && args.content !== existing.content
      ? await embedOrNull(ctx, content)
      : undefined;
  await ctx.convex.mutation(api.memoryRecords.upsert, {
    memoryId: args.memoryId,
    content,
    tier: args.tier ?? existing.tier,
    segment,
    importance: args.importance ?? existing.importance,
    decayRate: SEGMENT_DEFAULTS[segment].decayRate,
    embedding,
  });
  await ctx.convex.mutation(api.memoryEvents.emit, {
    eventType: "memory.updated",
    memoryId: args.memoryId,
    data: JSON.stringify({ source: "mcp" }),
  });
  const textChanged = args.content !== undefined && args.content !== existing.content;
  return {
    memoryId: args.memoryId,
    embedded: textChanged ? (embedding ? true : "kept-old-vector") : false,
  };
}

export async function deleteMemory(
  ctx: BoopMcpContext,
  args: { memoryId: string; mode: "archive" | "delete" },
): Promise<{ memoryId: string; mode: "archive" | "delete" }> {
  assertWritable(ctx);
  const result =
    args.mode === "archive"
      ? await ctx.convex.mutation(api.memoryRecords.setLifecycle, {
          memoryId: args.memoryId,
          lifecycle: "archived",
        })
      : await ctx.convex.mutation(api.memoryRecords.remove, { memoryId: args.memoryId });
  if (!result) throw new Error(`No memory with id ${args.memoryId}.`);
  return { memoryId: args.memoryId, mode: args.mode };
}

export async function sendMessage(
  ctx: BoopMcpContext,
  args: { content: string; conversationId?: string },
): Promise<{ conversationId: string; reply: string }> {
  const conversationId = args.conversationId ?? DEFAULT_CONVERSATION_ID;
  const res = await (ctx.fetchImpl ?? fetch)(`${ctx.boopUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, content: args.content }),
  });
  const body = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
  if (!res.ok) {
    throw new Error(`Boop /chat returned ${res.status}: ${body.error ?? "no body"}`);
  }
  return { conversationId, reply: body.reply ?? "" };
}

export async function readMessages(
  ctx: BoopMcpContext,
  args: { conversationId?: string; limit?: number },
): Promise<
  Array<{ role: string; content: string; createdAt: number; truncated: boolean }>
> {
  const conversationId = args.conversationId ?? DEFAULT_CONVERSATION_ID;
  const rows = await ctx.convex.query(api.messages.recent, {
    conversationId,
    limit: args.limit ?? 20,
  });
  return rows.map((m) => ({
    role: m.role,
    content: m.content.slice(0, MESSAGE_PREVIEW_LIMIT),
    createdAt: m.createdAt,
    truncated: m.content.length > MESSAGE_PREVIEW_LIMIT,
  }));
}

export async function listConversations(
  ctx: BoopMcpContext,
): Promise<Array<{ conversationId: string; messageCount: number; lastActivityAt: number }>> {
  const rows = await ctx.convex.query(api.conversations.list, {});
  return rows.map((c) => ({
    conversationId: c.conversationId,
    messageCount: c.messageCount,
    lastActivityAt: c.lastActivityAt,
  }));
}
