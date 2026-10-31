import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { convex } from "./convex-client.js";
import type { InboundStore } from "./inbound-queue.js";

/** The inbound queue's storage: the inboundMessages table in Convex. */
export const convexInboundStore: InboundStore = {
  async enqueue(input) {
    const { enqueued } = await convex.mutation(api.inboundMessages.enqueue, input);
    return enqueued;
  },
  async claimNext(conversationId) {
    const row = await convex.mutation(api.inboundMessages.claimNext, { conversationId });
    if (!row) return null;
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
