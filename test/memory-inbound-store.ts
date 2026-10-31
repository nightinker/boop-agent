import type { InboundInput, InboundItem, InboundStore } from "../server/inbound-queue.js";

type Row = InboundItem & { status: "queued" | "processing" | "done" | "failed"; error?: string };

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
    async claimNext(conversationId) {
      const mine = rows.filter((r) => r.conversationId === conversationId);
      if (mine.some((r) => r.status === "processing")) return null;
      const row = mine.find((r) => r.status === "queued");
      if (!row) return null;
      row.status = "processing";
      row.attempts++;
      return { ...row };
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
  };
  return { store, rows };
}

export function text(conversation: string, content: string, handle = `h-${conversation}-${content}`): InboundInput {
  return {
    handle,
    conversationId: `sms:${conversation}`,
    fromNumber: conversation,
    content,
    mediaUrls: [],
    source: "webhook",
    receivedAt: Date.now(),
  };
}
