// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
const newTest = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof newTest>;
const DIMS = 1024;
const vec = (seed: number) => Array.from({ length: DIMS }, (_, i) => (i === seed ? 1 : 0));
const memory = (memoryId: string, extra: Record<string, unknown> = {}) => ({
  memoryId,
  content: `about ${memoryId}`,
  tier: "long" as const,
  segment: "knowledge" as const,
  importance: 0.5,
  decayRate: 0.01,
  ...extra,
});

async function embeddingRow(t: TestConvex, memoryId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("memoryEmbeddings")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", memoryId))
      .unique(),
  );
}
async function recordRow(t: TestConvex, memoryId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", memoryId))
      .unique(),
  );
}

describe("memory embeddings live in their own table", () => {
  it("stores a new memory's vector apart from the record", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, { ...memory("m1"), embedding: vec(1) });
    const record = await recordRow(t, "m1");
    expect(record?.embedding).toBeUndefined();
    expect(record?.hasEmbedding).toBe(true);
    expect((await embeddingRow(t, "m1"))?.searchKey).toBe("live");
  });

  it("follows the memory's lifecycle and goes away when it's deleted", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, { ...memory("m1"), embedding: vec(1) });
    await t.mutation(api.memoryRecords.setLifecycle, { memoryId: "m1", lifecycle: "archived" });
    expect((await embeddingRow(t, "m1"))?.searchKey).toBe("archived");
    // Superseding archives the old memory, and its vector with it.
    await t.mutation(api.memoryRecords.upsert, { ...memory("m2"), embedding: vec(2) });
    await t.mutation(api.memoryRecords.upsert, { ...memory("m3"), supersedes: ["m2"] });
    expect((await embeddingRow(t, "m2"))?.searchKey).toBe("archived");
    await t.mutation(api.memoryRecords.remove, { memoryId: "m1" });
    expect(await embeddingRow(t, "m1")).toBeNull();
  });

  it("backfills through setEmbedding and counts embedded memories", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.upsert, memory("m1"));
    expect((await t.query(api.memoryRecords.listUnembeddedPage, {})).page).toHaveLength(1);
    await t.mutation(api.memoryRecords.setEmbedding, { memoryId: "m1", embedding: vec(3) });
    expect((await t.query(api.memoryRecords.listUnembeddedPage, {})).page).toHaveLength(0);
    expect(await t.query(api.memoryRecords.embeddingStats, {})).toMatchObject({ withEmbedding: 1, withoutEmbedding: 0 });
  });
});

describe("moving existing embeddings", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("moves every legacy vector in batches, then stops for good", async () => {
    const t = convexTest(schema, modules);
    // 45 memories written the old way, vector on the record (3 batches).
    await t.run(async (ctx) => {
      for (let i = 0; i < 45; i++) {
        await ctx.db.insert("memoryRecords", {
          ...memory(`old${i}`),
          embedding: vec(i),
          accessCount: 0,
          lastAccessedAt: 0,
          lifecycle: i === 0 ? "archived" : "active",
          createdAt: i,
        });
      }
    });
    expect(await t.mutation(api.memoryRecords.startEmbeddingMigration, {})).toEqual({ started: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const { legacy, moved } = await t.run(async (ctx) => ({
      legacy: (await ctx.db.query("memoryRecords").collect()).filter((r) => r.embedding),
      moved: await ctx.db.query("memoryEmbeddings").collect(),
    }));
    expect(legacy).toHaveLength(0);
    expect(moved).toHaveLength(45);
    expect(moved.find((m) => m.memoryId === "old0")?.searchKey).toBe("archived");
    expect(await t.mutation(api.memoryRecords.startEmbeddingMigration, {})).toEqual({ started: false });
  });
});

// convex-test scores every row in the table, even ones without the vector
// field (real Convex leaves those out of the index). So each case below keeps
// memoryRecords either all-legacy or searched only through the new table.
describe("recall", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("after the migration, searches only the new table: active, real memories", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.memoryRecords.startEmbeddingMigration, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.mutation(api.memoryRecords.upsert, { ...memory("new"), embedding: vec(5) });
    await t.mutation(api.memoryRecords.upsert, { ...memory("other"), embedding: vec(9) });
    await t.mutation(api.memoryRecords.upsert, { ...memory("gone"), embedding: vec(5) });
    await t.mutation(api.memoryRecords.setLifecycle, { memoryId: "gone", lifecycle: "archived" });
    await t.mutation(api.memoryRecords.upsert, { ...memory("demo:mem:001"), embedding: vec(5) });
    const hits = await t.action(api.memoryRecords.vectorSearch, { embedding: vec(5), limit: 2 });
    expect(hits.map((h) => h.record.memoryId)).toEqual(["new", "other"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("before the migration, also finds vectors still on the records, once each", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const legacy = (id: string, lifecycle: "active" | "archived" = "active") =>
        ctx.db.insert("memoryRecords", {
          ...memory(id),
          embedding: vec(5),
          accessCount: 0,
          lastAccessedAt: 0,
          lifecycle,
          createdAt: 0,
        });
      await legacy("legacy");
      await legacy("old-archived", "archived");
      // Mid-migration: already copied to the new table, field not cleared yet.
      const both = await legacy("both");
      await ctx.db.insert("memoryEmbeddings", {
        memoryId: "both",
        memoryRecordId: both,
        searchKey: "live",
        embedding: vec(5),
      });
    });
    const hits = await t.action(api.memoryRecords.vectorSearch, { embedding: vec(5), limit: 10 });
    expect(hits.map((h) => h.record.memoryId).sort()).toEqual(["both", "legacy"]);
  });
});

describe("cached dashboard stats", () => {
  it("computes once, then serves the cached copy until it's stale", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.dashboard.cachedMetrics, {})).toBeNull();
    await t.mutation(api.memoryRecords.upsert, { ...memory("m1"), embedding: vec(1) });
    expect(await t.mutation(api.dashboard.refreshMetrics, {})).toMatchObject({ refreshed: true });
    const first = await t.query(api.dashboard.cachedMetrics, {});
    expect(first?.memories).toMatchObject({ total: 1, longTerm: 1 });

    await t.mutation(api.memoryRecords.upsert, { ...memory("m2", { tier: "short" }) });
    expect(await t.mutation(api.dashboard.refreshMetrics, {})).toMatchObject({ refreshed: false });
    expect((await t.query(api.dashboard.cachedMetrics, {}))?.memories.total).toBe(1);

    // With a short max age it recomputes and picks up the new memory.
    vi.useFakeTimers({ now: Date.now() + 2 * 60_000 });
    try {
      expect(await t.mutation(api.dashboard.refreshMetrics, { maxAgeMs: 60_000 })).toMatchObject({ refreshed: true });
    } finally {
      vi.useRealTimers();
    }
    expect((await t.query(api.dashboard.cachedMetrics, {}))?.memories).toMatchObject({ total: 2, shortTerm: 1 });
  });
});
