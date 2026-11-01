import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { convex } from "./convex-client.js";
import type { InboundItem, InboundStore } from "./inbound-queue.js";

function toItem(row: Omit<InboundItem, "_id"> & { _id: string }): InboundItem {
  return {
    _id: row._id,
    handle: row.handle,
    conversationId: row.conversationId,
    fromNumber: row.fromNumber,
    content: row.content,
    mediaUrls: row.mediaUrls,
    source: row.source,
    receivedAt: row.receivedAt,
    attempts: row.attempts,
  };
}

/** The inbound queue's storage: the inboundMessages table in Convex. */
export const convexInboundStore: InboundStore = {
  async enqueue(input) {
    const { enqueued } = await convex.mutation(api.inboundMessages.enqueue, input);
    return enqueued;
  },
  async claimNext(conversationId) {
    const row = await convex.mutation(api.inboundMessages.claimNext, { conversationId });
    return row ? toItem(row) : null;
  },
  async claimQueued(conversationId) {
    const rows = await convex.mutation(api.inboundMessages.claimQueued, { conversationId });
    return rows.map(toItem);
  },
  async finish(id, status, error) {
    await convex.mutation(api.inboundMessages.finish, {
      id: id as Id<"inboundMessages">,
      status,
      ...(error ? { error } : {}),
    });
  },
  recoverInterrupted() {
    return convex.mutation(api.inboundMessages.recoverInterrupted, {});
  },
  pendingConversations() {
    return convex.query(api.inboundMessages.pendingConversations, {});
  },
};
