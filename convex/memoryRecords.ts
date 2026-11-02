import { action, internalMutation, internalQuery, mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { deleteEmbedding, isEmbedded, saveEmbedding, syncEmbeddingLifecycle } from "./embeddingStore";
import type { Doc, Id } from "./_generated/dataModel";
import { DEMO_SCAN_LIMIT, isDemoId, isDemoModeEnabled } from "./demoMode";

const tierV = v.union(v.literal("short"), v.literal("long"), v.literal("permanent"));
const segmentV = v.union(
  v.literal("identity"),
  v.literal("preference"),
  v.literal("correction"),
  v.literal("relationship"),
  v.literal("project"),
  v.literal("knowledge"),
  v.literal("context"),
);
const lifecycleV = v.union(v.literal("active"), v.literal("archived"), v.literal("pruned"));

type MemoryTier = "short" | "long" | "permanent";
type MemorySegment =
  | "identity"
  | "preference"
  | "correction"
  | "relationship"
  | "project"
  | "knowledge"
  | "context";
type MemoryLifecycle = "active" | "archived" | "pruned";

export const upsert = mutation({
  args: {
    memoryId: v.string(),
    content: v.string(),
    tier: tierV,
    segment: segmentV,
    importance: v.number(),
    decayRate: v.number(),
    sourceTurn: v.optional(v.string()),
    supersedes: v.optional(v.array(v.string())),
    embedding: v.optional(v.array(v.float64())),
    metadata: v.optional(v.string()),
    imageStorageIds: v.optional(v.union(v.array(v.id("_storage")), v.null())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Archive any memories this one supersedes. Must run on BOTH the insert
    // and update paths — consolidation merges typically update an existing
    // "keep" memory while archiving the ones it absorbed.
    if (args.supersedes?.length) {
      for (const sid of args.supersedes) {
        if (sid === args.memoryId) continue; // never archive self
        const target = await ctx.db
          .query("memoryRecords")
          .withIndex("by_memory_id", (q) => q.eq("memoryId", sid))
          .unique();
        if (target && target.lifecycle === "active") {
          await ctx.db.patch(target._id, { lifecycle: "archived" });
          await syncEmbeddingLifecycle(ctx, target.memoryId, "archived");
        }
      }
    }

    const existing = await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: args.content,
        tier: args.tier,
        segment: args.segment,
        importance: args.importance,
        decayRate: args.decayRate,
        supersedes: args.supersedes,
        metadata: args.metadata ?? existing.metadata,
        imageStorageIds:
          args.imageStorageIds === null
            ? undefined
            : args.imageStorageIds && args.imageStorageIds.length > 0
              ? args.imageStorageIds
              : existing.imageStorageIds,
        lastAccessedAt: now,
      });
      // A new vector replaces the old one; otherwise move a legacy one over.
      const vector = args.embedding ?? existing.embedding;
      if (vector && vector.length > 0) await saveEmbedding(ctx, existing, vector);
      return existing._id;
    }

    const { imageStorageIds, embedding, ...rest } = args;
    const id = await ctx.db.insert("memoryRecords", {
      ...rest,
      ...(imageStorageIds && imageStorageIds.length > 0
        ? { imageStorageIds }
        : {}),
      accessCount: 0,
      lastAccessedAt: now,
      lifecycle: "active",
      createdAt: now,
    });
    if (embedding && embedding.length > 0) {
      await saveEmbedding(ctx, { _id: id, memoryId: args.memoryId, lifecycle: "active" }, embedding);
    }
    return id;
  },
});

export const getByIds = query({
  args: { ids: v.array(v.id("memoryRecords")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const r = await ctx.db.get(id);
      if (r && !isDemoId(r.memoryId)) out.push(r);
    }
    return out;
  },
});

export const vectorSearch = action({
  args: { embedding: v.array(v.float64()), limit: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{ _id: Id<"memoryRecords">; score: number; record: Doc<"memoryRecords"> }>
  > => {
    const limit = Math.max(1, Math.min(args.limit ?? 20, 256));
    const migrated: boolean = await ctx.runQuery(internal.memoryRecords.embeddingsMigrated, {});
    const [hits, legacyHits] = await Promise.all([
      // Only active, non-demo memories carry searchKey "live", so no
      // oversampling is needed to filter demo or archived ones out.
      ctx.vectorSearch("memoryEmbeddings", "by_embedding", {
        vector: args.embedding,
        limit,
        filter: (q) => q.eq("searchKey", "live"),
      }),
      // Vectors not yet moved off memoryRecords, until the migration is done.
      migrated
        ? Promise.resolve([] as Array<{ _id: Id<"memoryRecords">; _score: number }>)
        : ctx.vectorSearch("memoryRecords", "by_embedding", {
            vector: args.embedding,
            limit: Math.min(256, limit + 100),
            filter: (q) => q.eq("lifecycle", "active"),
          }),
    ]);
    const hydrated: { embeddingHits: Array<Doc<"memoryRecords"> | null>; legacy: Doc<"memoryRecords">[] } =
      await ctx.runQuery(internal.memoryRecords.hydrateSearchHits, {
        embeddingIds: hits.map((r) => r._id),
        recordIds: legacyHits.map((r) => r._id),
      });
    const best = new Map<Id<"memoryRecords">, { score: number; record: Doc<"memoryRecords"> }>();
    const consider = (record: Doc<"memoryRecords"> | null | undefined, score: number) => {
      if (!record) return;
      const prev = best.get(record._id);
      if (!prev || prev.score < score) best.set(record._id, { score, record });
    };
    hits.forEach((hit, i) => consider(hydrated.embeddingHits[i], hit._score));
    const legacyById = new Map(hydrated.legacy.map((record) => [record._id, record]));
    for (const hit of legacyHits) consider(legacyById.get(hit._id), hit._score);
    return [...best.entries()]
      .map(([_id, { score, record }]) => ({ _id, score, record }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  },
});

/** Looks up the memories behind vector hits, in hit order. Real, active ones only. */
export const hydrateSearchHits = internalQuery({
  args: {
    embeddingIds: v.array(v.id("memoryEmbeddings")),
    recordIds: v.array(v.id("memoryRecords")),
  },
  handler: async (ctx, args) => {
    const usable = (r: Doc<"memoryRecords"> | null) =>
      r && r.lifecycle === "active" && !isDemoId(r.memoryId) ? r : null;
    const embeddingHits = [];
    for (const id of args.embeddingIds) {
      const row = await ctx.db.get(id);
      embeddingHits.push(row ? usable(await ctx.db.get(row.memoryRecordId)) : null);
    }
    const legacy = [];
    for (const id of args.recordIds) {
      const r = usable(await ctx.db.get(id));
      if (r) legacy.push(r);
    }
    return { embeddingHits, legacy };
  },
});

type MemoryListArgs = {
  tier?: MemoryTier;
  segment?: MemorySegment;
  lifecycle?: MemoryLifecycle;
  limit?: number;
};

async function readMemories(ctx: QueryCtx, args: MemoryListArgs, demoOnly: boolean) {
  const limit = args.limit ?? 100;
  const results = args.tier
    ? await ctx.db
        .query("memoryRecords")
        .withIndex("by_tier", (q) => q.eq("tier", args.tier!))
        .order("desc")
        .take(DEMO_SCAN_LIMIT)
    : args.segment
      ? await ctx.db
          .query("memoryRecords")
          .withIndex("by_segment", (q) => q.eq("segment", args.segment!))
          .order("desc")
          .take(DEMO_SCAN_LIMIT)
      : await ctx.db.query("memoryRecords").order("desc").take(DEMO_SCAN_LIMIT);
  const lifecycle = args.lifecycle ?? "active";
  return results
    .filter((record) => isDemoId(record.memoryId) === demoOnly && record.lifecycle === lifecycle)
    .slice(0, limit);
}

const listArgs = {
  tier: v.optional(tierV),
  segment: v.optional(segmentV),
  lifecycle: v.optional(lifecycleV),
  limit: v.optional(v.number()),
};

export const list = query({
  args: listArgs,
  handler: async (ctx, args) => readMemories(ctx, args, false),
});

export const listForDashboard = query({
  args: listArgs,
  handler: async (ctx, args) => {
    return readMemories(ctx, args, await isDemoModeEnabled(ctx));
  },
});

export const search = query({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const q = args.query.toLowerCase();
    // Filter on the index BEFORE the 500 cap — otherwise archived/pruned
    // records eat the budget and silently truncate the active set.
    // order("desc") so the 500-cap favors recent records. Without it the
    // index iterates oldest-first and a brand-new high-importance record
    // past position 500 would never be seen.
    const active = await ctx.db
      .query("memoryRecords")
      .withIndex("by_lifecycle", (idx) => idx.eq("lifecycle", "active"))
      .order("desc")
      .take(500);
    return active
      .filter((m) => !isDemoId(m.memoryId) && m.content.toLowerCase().includes(q))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  },
});

export const markAccessed = mutation({
  args: { memoryId: v.string() },
  handler: async (ctx, args) => {
    const mem = await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();
    if (!mem) return null;
    await ctx.db.patch(mem._id, {
      accessCount: mem.accessCount + 1,
      lastAccessedAt: Date.now(),
    });
    return mem._id;
  },
});

export const setLifecycle = mutation({
  args: { memoryId: v.string(), lifecycle: lifecycleV },
  handler: async (ctx, args) => {
    const mem = await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();
    if (!mem) return null;
    await ctx.db.patch(mem._id, { lifecycle: args.lifecycle });
    await syncEmbeddingLifecycle(ctx, mem.memoryId, args.lifecycle);
    return mem._id;
  },
});

export const remove = mutation({
  args: { memoryId: v.string() },
  handler: async (ctx, args) => {
    const mem = await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();
    if (!mem) return null;
    await ctx.db.delete(mem._id);
    await deleteEmbedding(ctx, mem.memoryId);
    await ctx.db.insert("memoryEvents", {
      eventType: "memory.deleted",
      memoryId: args.memoryId,
      data: JSON.stringify({
        tier: mem.tier,
        segment: mem.segment,
        lifecycle: mem.lifecycle,
      }),
      createdAt: Date.now(),
    });
    return mem._id;
  },
});

const COUNTS_SCAN_LIMIT = 5000;

export const embeddingStats = query({
  args: {},
  handler: async (ctx) => {
    let all = await ctx.db
      .query("memoryRecords")
      .withIndex("by_lifecycle", (q) => q.eq("lifecycle", "active"))
      .order("desc")
      .take(COUNTS_SCAN_LIMIT);
    const scanned = all.length;
    all = all.filter((memory) => !isDemoId(memory.memoryId));
    let withEmbedding = 0;
    let withoutEmbedding = 0;
    for (const m of all) {
      if (isEmbedded(m)) withEmbedding++;
      else withoutEmbedding++;
    }
    return {
      total: all.length,
      withEmbedding,
      withoutEmbedding,
      truncated: scanned === COUNTS_SCAN_LIMIT,
    };
  },
});

// Cursor-based scan over active memories that yields the unembedded ones.
// Returns at most `pageSize` rows from the underlying index, and the caller
// is expected to walk pages via `continueCursor` until `isDone`. A given
// page may contain fewer unembedded rows than were scanned (the rest had
// embeddings and were filtered out).
//
// Why a cursor rather than a top-N sort by importance: the previous
// implementation took 5,000 rows per call and filtered in-process, so each
// pagination step was O(total memories). With the cursor each step is
// O(pageSize). Re-embed throughput is unchanged (we still process every
// unembedded row exactly once) but Convex query cost stays bounded as the
// memory corpus grows.
export const listUnembeddedPage = query({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("memoryRecords")
      .withIndex("by_lifecycle", (q) => q.eq("lifecycle", "active"))
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: args.pageSize ?? 50,
      });
    return {
      page: result.page
        .filter((m) => !isDemoId(m.memoryId) && !isEmbedded(m))
        .map((m) => ({ memoryId: m.memoryId, content: m.content })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

// Patch just the embedding on an existing memory. Avoids re-running upsert
// (which would touch lastAccessedAt + run supersedes processing) just to
// back-fill a vector.
export const setEmbedding = mutation({
  args: {
    memoryId: v.string(),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const mem = await ctx.db
      .query("memoryRecords")
      .withIndex("by_memory_id", (q) => q.eq("memoryId", args.memoryId))
      .unique();
    if (!mem) return null;
    await saveEmbedding(ctx, mem, args.embedding);
    return mem._id;
  },
});

export const countsByTier = query({
  args: {},
  handler: async (ctx) => {
    const demoMode = await isDemoModeEnabled(ctx);
    const rows = await ctx.db.query("memoryRecords").order("desc").take(COUNTS_SCAN_LIMIT);
    const all = rows.filter((m) => isDemoId(m.memoryId) === demoMode);
    const active = all.filter((m) => m.lifecycle === "active");
    return {
      short: active.filter((m) => m.tier === "short").length,
      long: active.filter((m) => m.tier === "long").length,
      permanent: active.filter((m) => m.tier === "permanent").length,
      archived: all.filter((m) => m.lifecycle === "archived").length,
      pruned: all.filter((m) => m.lifecycle === "pruned").length,
      truncated: rows.length === COUNTS_SCAN_LIMIT,
      scanLimit: COUNTS_SCAN_LIMIT,
    };
  },
});

export const findImageRefsPage = query({
  args: {
    storageIds: v.array(v.id("_storage")),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.storageIds.length === 0) {
      return { foundStorageIds: [], isDone: true, continueCursor: null };
    }
    const wanted = new Set(args.storageIds);
    const result = await ctx.db
      .query("memoryRecords")
      .order("desc")
      .paginate({
        cursor: args.cursor ?? null,
        numItems: args.pageSize ?? 50,
      });
    const found = new Set<string>();
    for (const record of result.page) {
      for (const storageId of record.imageStorageIds ?? []) {
        if (wanted.has(storageId)) found.add(storageId);
      }
    }
    return {
      foundStorageIds: [...found],
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

// ── Moving legacy embeddings off memoryRecords ───────────────────────────────
// Each batch reads ~20 records (~8 KB each with their vector), moves any
// vector to memoryEmbeddings and schedules the next batch until done.

const MIGRATION_KEY = "embeddings_migrated";
const MIGRATION_BATCH = 20;

export const embeddingsMigrated = internalQuery({
  args: {},
  handler: async (ctx) =>
    Boolean(
      await ctx.db
        .query("settings")
        .withIndex("by_key", (q) => q.eq("key", MIGRATION_KEY))
        .unique(),
    ),
});

export const migrateEmbeddingsBatch = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("memoryRecords")
      .paginate({ cursor: args.cursor, numItems: MIGRATION_BATCH });
    for (const memory of page.page) {
      if (memory.embedding && memory.embedding.length > 0) {
        await saveEmbedding(ctx, memory, memory.embedding);
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.memoryRecords.migrateEmbeddingsBatch, {
        cursor: page.continueCursor,
      });
      return null;
    }
    const flag = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", MIGRATION_KEY))
      .unique();
    const value = String(Date.now());
    if (flag) await ctx.db.patch(flag._id, { value, updatedAt: Date.now() });
    else await ctx.db.insert("settings", { key: MIGRATION_KEY, value, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Starts moving legacy embeddings unless that's already done. Boop calls it
 * at startup; it's a single small read once the migration has finished.
 */
export const startEmbeddingMigration = mutation({
  args: {},
  handler: async (ctx) => {
    const done = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", MIGRATION_KEY))
      .unique();
    if (done) return { started: false };
    await ctx.scheduler.runAfter(0, internal.memoryRecords.migrateEmbeddingsBatch, { cursor: null });
    return { started: true };
  },
});
