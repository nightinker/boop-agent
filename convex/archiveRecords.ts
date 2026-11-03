import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";

/** Most records one importBatch call accepts; keeps each mutation well inside Convex limits. */
export const MAX_IMPORT_BATCH = 200;
const MAX_CONTENT_LENGTH = 32_000;

const recordV = v.object({
  sourceId: v.string(),
  source: v.string(),
  kind: v.string(),
  project: v.string(),
  title: v.string(),
  content: v.string(),
  type: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  occurredAt: v.number(),
  contentHash: v.string(),
});

async function bumpCount(ctx: MutationCtx, key: string, by: number) {
  if (by === 0) return;
  const row = await ctx.db
    .query("archiveCounts")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (row) await ctx.db.patch(row._id, { count: row.count + by });
  else await ctx.db.insert("archiveCounts", { key, count: by });
}

/**
 * Upserts imported history by sourceId. A record whose contentHash already
 * matches is left alone, so re-running an import writes nothing new.
 */
export const importBatch = mutation({
  args: { records: v.array(recordV) },
  handler: async (ctx, args) => {
    if (args.records.length > MAX_IMPORT_BATCH) {
      throw new Error(`importBatch takes at most ${MAX_IMPORT_BATCH} records, got ${args.records.length}`);
    }
    const now = Date.now();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const added = new Map<string, number>();
    const seen = new Set<string>();
    for (const record of args.records) {
      if (seen.has(record.sourceId)) {
        unchanged++;
        continue;
      }
      seen.add(record.sourceId);
      const content = record.content.slice(0, MAX_CONTENT_LENGTH);
      const existing = await ctx.db
        .query("archiveRecords")
        .withIndex("by_source_id", (q) => q.eq("sourceId", record.sourceId))
        .unique();
      if (existing) {
        if (existing.contentHash === record.contentHash) {
          unchanged++;
          continue;
        }
        await ctx.db.patch(existing._id, { ...record, content, importedAt: now });
        const oldKey = `${existing.source}:${existing.kind}`;
        const newKey = `${record.source}:${record.kind}`;
        if (oldKey !== newKey) {
          added.set(oldKey, (added.get(oldKey) ?? 0) - 1);
          added.set(newKey, (added.get(newKey) ?? 0) + 1);
        }
        updated++;
      } else {
        await ctx.db.insert("archiveRecords", { ...record, content, importedAt: now });
        const key = `${record.source}:${record.kind}`;
        added.set(key, (added.get(key) ?? 0) + 1);
        inserted++;
      }
    }
    for (const [key, by] of added) await bumpCount(ctx, key, by);
    return { inserted, updated, unchanged };
  },
});

/** Keyword search over imported history, best match first. */
export const search = query({
  args: {
    query: v.string(),
    project: v.optional(v.string()),
    kind: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const text = args.query.trim();
    if (!text) return [];
    const limit = Math.max(1, Math.min(args.limit ?? 10, 50));
    return ctx.db
      .query("archiveRecords")
      .withSearchIndex("search_content", (q) => {
        let s = q.search("content", text);
        if (args.project) s = s.eq("project", args.project);
        if (args.kind) s = s.eq("kind", args.kind);
        return s;
      })
      .take(limit);
  },
});

/** Imported row totals per "source:kind". */
export const counts = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("archiveCounts").take(100);
    return Object.fromEntries(rows.map((r) => [r.key, r.count]));
  },
});

