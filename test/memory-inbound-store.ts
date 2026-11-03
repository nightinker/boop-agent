import type { InboundInput, InboundItem, InboundStore } from "../server/inbound-queue.js";

type Row = InboundItem & { status: "queued" | "processing" | "done" | "failed" | "cancelled"; error?: string };

const processingCount = (mine: Row[]) => mine.filter((r) => r.status === "processing").length;

/** In-memory stand-in for convex/inboundMessages.ts with the same rules. */
export function memoryInboundStore() {
  const rows: Row[] = [];
  let next = 1;
  const store: InboundStore = {
    async enqueue(input: InboundInput) {
      if (rows.some((r) => r.handle === input.handle)) return false;
      rows.push({ ...input, _id: `row${next++}`, attempts: 0, status: "queued" });
      return true;
    },
    async claimNext(conversationId, opts) {
      const mine = rows.filter((r) => r.conversationId === conversationId);
      if (processingCount(mine) >= (opts?.maxConcurrent ?? 1)) return null;
      const row = mine.find((r) => r.status === "queued");
      if (!row) return null;
      row.status = "processing";
      row.attempts++;
      return { ...row };
    },
    async claimQueued(conversationId, opts) {
      const mine = rows.filter((r) => r.conversationId === conversationId);
      if (processingCount(mine) >= (opts?.maxConcurrent ?? 1)) return [];
      const queued = mine.filter((r) => r.status === "queued");
      const claimed = [];
      for (const [i, row] of queued.entries()) {
        if (opts?.maxGapMs !== undefined && i > 0 && Math.abs(row.receivedAt - queued[i - 1].receivedAt) > opts.maxGapMs) break;
        claimed.push(row);
      }
      for (const row of claimed) {
        row.status = "processing";
        row.attempts++;
      }
      return claimed.map((row) => ({ ...row }));
    },
    async finish(id, status, error) {
      const row = rows.find((r) => r._id === id)!;
      row.status = status;
      row.error = error;
    },
    async recoverInterrupted() {
      let requeued = 0;
      for (const row of rows) {
        if (row.status === "processing") {
          row.status = "queued";
          requeued++;
        }
      }
      return { requeued, failed: 0 };
    },
    async pendingConversations() {
      return [...new Set(rows.filter((r) => r.status === "queued").map((r) => r.conversationId))];
    },
    async waiting(conversationId) {
      const mine = rows.filter((r) => r.conversationId === conversationId);
      return {
        busy: processingCount(mine) > 0,
        processing: processingCount(mine),
        queued: mine.filter((r) => r.status === "queued").map((r) => ({ _id: r._id, handle: r.handle })),
      };
    },
    async cancel(ids, reason) {
      let cancelled = 0;
      for (const row of rows) {
        if (ids.includes(row._id) && row.status === "queued") {
          row.status = "cancelled";
          row.error = reason;
          cancelled++;
        }
      }
      return cancelled;
    },
  };
  return { store, rows };
}

export function text(
  conversation: string,
  content: string,
  handle = `h-${conversation}-${content}`,
  mediaUrls: string[] = [],
): InboundInput {
  return {
    handle,
    conversationId: `sms:${conversation}`,
    fromNumber: conversation,
    content,
    mediaUrls,
    source: "webhook",
    receivedAt: Date.now(),
  };
}
