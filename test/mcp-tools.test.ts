import { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import {
  addMemory,
  assertWritable,
  deleteMemory,
  isLocalConvexUrl,
  listConversations,
  listMemories,
  readMessages,
  searchMemories,
  sendMessage,
  updateMemory,
  type BoopMcpContext,
} from "../server/mcp/boop-tools.js";
import { api } from "../convex/_generated/api.js";

const localUrl = process.env.BOOP_MCP_TEST_CONVEX_URL;
const fakeVector = (seed: number) => Array.from({ length: 1024 }, (_, i) => (i === seed ? 1 : 0));

function makeCtx(overrides: Partial<BoopMcpContext> = {}): BoopMcpContext {
  const convexUrl = localUrl ?? "http://127.0.0.1:1";
  return {
    convex: new ConvexHttpClient(convexUrl),
    convexUrl,
    boopUrl: "http://boop.test",
    embed: async () => fakeVector(1),
    allowRemoteWrites: false,
    ...overrides,
  };
}

describe("write guard", () => {
  it("recognises local backends only", () => {
    expect(isLocalConvexUrl("http://127.0.0.1:3210")).toBe(true);
    expect(isLocalConvexUrl("http://localhost:3210")).toBe(true);
    expect(isLocalConvexUrl("https://happy-animal-123.convex.cloud")).toBe(false);
    expect(isLocalConvexUrl("not a url")).toBe(false);
  });

  it("blocks writes to a remote deployment unless opted in", async () => {
    const remote = makeCtx({ convexUrl: "https://happy-animal-123.convex.cloud" });
    expect(() => assertWritable(remote)).toThrow(/Refusing to write/);
    await expect(addMemory(remote, { content: "x", segment: "knowledge" })).rejects.toThrow(
      /Refusing to write/,
    );
    await expect(updateMemory(remote, { memoryId: "m", content: "x" })).rejects.toThrow(/Refusing/);
    await expect(deleteMemory(remote, { memoryId: "m", mode: "delete" })).rejects.toThrow(/Refusing/);
    expect(() => assertWritable({ ...remote, allowRemoteWrites: true })).not.toThrow();
  });

  it("does not block chat sends, which go through Boop's own /chat", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const ctx = makeCtx({
      convexUrl: "https://happy-animal-123.convex.cloud",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body) });
        return new Response(JSON.stringify({ reply: "hi" }), { status: 200 });
      }) as typeof fetch,
    });
    const out = await sendMessage(ctx, { content: "hello" });
    expect(out).toEqual({ conversationId: "mcp:default", reply: "hi" });
    expect(calls[0].url).toBe("http://boop.test/chat");
    expect(JSON.parse(calls[0].body)).toEqual({ conversationId: "mcp:default", content: "hello" });
  });

  it("tells the caller to check messages when the connection drops mid-turn", async () => {
    const ctx = makeCtx({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(sendMessage(ctx, { content: "hello" })).rejects.toThrow(/boop_read_messages/);
  });

  it("surfaces a /chat failure", async () => {
    const ctx = makeCtx({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as unknown as typeof fetch,
    });
    await expect(sendMessage(ctx, { content: "hello" })).rejects.toThrow(/500: boom/);
  });
});

describe.skipIf(!localUrl)("against the local anonymous backend", () => {
  it("only ever runs against a local URL", () => {
    expect(isLocalConvexUrl(localUrl!)).toBe(true);
  });

  it("adds, lists, searches, updates and removes a memory", async () => {
    const ctx = makeCtx();
    const marker = `zebra-${Date.now()}`;
    const added = await addMemory(ctx, { content: `Harley likes ${marker}`, segment: "preference" });
    expect(added.embedded).toBe(true);
    expect(added.tier).toBe("long");

    const listed = await listMemories(ctx, { segment: "preference" });
    expect(listed.map((m) => m.memoryId)).toContain(added.memoryId);

    const found = await searchMemories(ctx, { query: marker });
    expect(found).toHaveLength(1);
    expect(found[0].memoryId).toBe(added.memoryId);

    const updated = await updateMemory(ctx, {
      memoryId: added.memoryId,
      content: `Harley prefers ${marker}-v2`,
      importance: 0.9,
    });
    expect(updated.embedding).toBe("refreshed");
    const after = await searchMemories(ctx, { query: `${marker}-v2` });
    expect(after[0].importance).toBe(0.9);
    expect(after[0].segment).toBe("preference");

    await deleteMemory(ctx, { memoryId: added.memoryId, mode: "archive" });
    expect(await searchMemories(ctx, { query: marker })).toHaveLength(0);
    const archived = await listMemories(ctx, { lifecycle: "archived" });
    expect(archived.map((m) => m.memoryId)).toContain(added.memoryId);

    await deleteMemory(ctx, { memoryId: added.memoryId, mode: "delete" });
    const gone = await listMemories(ctx, { lifecycle: "archived" });
    expect(gone.map((m) => m.memoryId)).not.toContain(added.memoryId);
  });

  it("reports when the embedding provider is unavailable", async () => {
    const ctx = makeCtx({
      embed: async () => {
        throw new Error("no provider");
      },
    });
    const added = await addMemory(ctx, { content: `no vector ${Date.now()}`, segment: "context" });
    expect(added.embedded).toBe(false);
    expect(added.tier).toBe("short");
    const updated = await updateMemory(ctx, { memoryId: added.memoryId, content: "changed text" });
    expect(updated.embedding).toBe("kept-old-vector");
    await deleteMemory(ctx, { memoryId: added.memoryId, mode: "delete" });
  });

  it("keeps supersedes and decayRate when editing only the importance", async () => {
    const ctx = makeCtx();
    const memoryId = `mem_keep_${Date.now()}`;
    await ctx.convex.mutation(api.memoryRecords.upsert, {
      memoryId,
      content: "consolidated fact",
      tier: "long",
      segment: "knowledge",
      importance: 0.5,
      decayRate: 0.123,
      supersedes: ["mem_old_a", "mem_old_b"],
    });
    const out = await updateMemory(ctx, { memoryId, importance: 0.8 });
    expect(out.embedding).toBe("unchanged");
    const row = await ctx.convex.query(api.memoryRecords.getByMemoryId, { memoryId });
    expect(row?.supersedes).toEqual(["mem_old_a", "mem_old_b"]);
    expect(row?.decayRate).toBe(0.123);
    expect(row?.importance).toBe(0.8);
    await deleteMemory(ctx, { memoryId, mode: "delete" });
  });

  it("updates an archived memory found by id", async () => {
    const ctx = makeCtx();
    const added = await addMemory(ctx, { content: "to archive", segment: "knowledge" });
    await deleteMemory(ctx, { memoryId: added.memoryId, mode: "archive" });
    await expect(updateMemory(ctx, { memoryId: added.memoryId, importance: 0.2 })).resolves.toBeTruthy();
    await deleteMemory(ctx, { memoryId: added.memoryId, mode: "delete" });
  });

  it("rejects secrets and unknown ids", async () => {
    const ctx = makeCtx();
    await expect(
      addMemory(ctx, { content: "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", segment: "knowledge" }),
    ).rejects.toThrow(/secret/);
    await expect(updateMemory(ctx, { memoryId: "mem_missing", content: "x" })).rejects.toThrow(/No memory/);
    await expect(deleteMemory(ctx, { memoryId: "mem_missing", mode: "delete" })).rejects.toThrow(/No memory/);
    await expect(deleteMemory(ctx, { memoryId: "mem_missing", mode: "archive" })).rejects.toThrow(/No memory/);
  });

  it("reads messages and conversations oldest first", async () => {
    const ctx = makeCtx();
    const conversationId = `mcp:test-${Date.now()}`;
    await ctx.convex.mutation(api.messages.send, { conversationId, role: "user", content: "first" });
    await ctx.convex.mutation(api.messages.send, { conversationId, role: "assistant", content: "second" });
    const msgs = await readMessages(ctx, { conversationId });
    expect(msgs.map((m) => m.content)).toEqual(["first", "second"]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const convs = await listConversations(ctx);
    expect(convs.find((c) => c.conversationId === conversationId)?.messageCount).toBe(2);
    expect(await readMessages(ctx, { conversationId: "mcp:empty" })).toEqual([]);
  });
});
