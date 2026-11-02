// Helpers for memory embeddings, stored in their own table (memoryEmbeddings)
// rather than on memoryRecords. Every write that touches a memory's vector or
// its lifecycle goes through here so the vector index's searchKey stays right.

import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isDemoId } from "./demoMode";

type Lifecycle = Doc<"memoryRecords">["lifecycle"];

/** The vector-index filter value: recall searches only "live". */
export function searchKeyFor(memoryId: string, lifecycle: Lifecycle): string {
  if (lifecycle !== "active") return lifecycle;
  return isDemoId(memoryId) ? "demo" : "live";
}

async function findEmbedding(ctx: MutationCtx, memoryId: string) {
  return await ctx.db
    .query("memoryEmbeddings")
    .withIndex("by_memory_id", (q) => q.eq("memoryId", memoryId))
    .unique();
}

/** Stores a memory's vector and marks the memory as embedded. */
export async function saveEmbedding(
  ctx: MutationCtx,
  memory: { _id: Id<"memoryRecords">; memoryId: string; lifecycle: Lifecycle },
  embedding: number[],
): Promise<void> {
  const searchKey = searchKeyFor(memory.memoryId, memory.lifecycle);
  const existing = await findEmbedding(ctx, memory.memoryId);
  if (existing) {
    await ctx.db.patch(existing._id, { embedding, searchKey, memoryRecordId: memory._id });
  } else {
    await ctx.db.insert("memoryEmbeddings", {
      memoryId: memory.memoryId,
      memoryRecordId: memory._id,
      searchKey,
      embedding,
    });
  }
  // Drop any legacy copy on the record itself.
  await ctx.db.patch(memory._id, { hasEmbedding: true, embedding: undefined });
}

/** Keeps the vector's searchKey in step with the memory's lifecycle. */
export async function syncEmbeddingLifecycle(
  ctx: MutationCtx,
  memoryId: string,
  lifecycle: Lifecycle,
): Promise<void> {
  const existing = await findEmbedding(ctx, memoryId);
  const searchKey = searchKeyFor(memoryId, lifecycle);
  if (existing && existing.searchKey !== searchKey) await ctx.db.patch(existing._id, { searchKey });
}

export async function deleteEmbedding(ctx: MutationCtx, memoryId: string): Promise<void> {
  const existing = await findEmbedding(ctx, memoryId);
  if (existing) await ctx.db.delete(existing._id);
}

/** True when the memory has a vector, in either the new table or the legacy field. */
export function isEmbedded(memory: Pick<Doc<"memoryRecords">, "hasEmbedding" | "embedding">): boolean {
  return Boolean(memory.hasEmbedding) || Boolean(memory.embedding && memory.embedding.length > 0);
}
