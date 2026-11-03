import { redactContactHandle } from "./privacy.js";

/** What convex/inboundMessages.ts:queueOverview returns. */
export interface QueueOverview {
  totalQueued: number;
  conversations: Array<{
    conversationId: string;
    answeringSince: number | null;
    queued: Array<{ content: string; mediaCount: number; receivedAt: number }>;
  }>;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The queue as plain text for Boop's list_queued_messages tool. Owners see
 * every conversation (contacts redacted); anyone else only their own.
 */
export function formatQueueOverview(
  overview: QueueOverview,
  opts: { now?: number; conversationId?: string; owner: boolean },
): string {
  const now = opts.now ?? Date.now();
  const visible = overview.conversations.filter((c) => opts.owner || c.conversationId === opts.conversationId);
  if (visible.length === 0) return "Nothing is queued and no message is being answered right now.";
  return visible
    .map((c) => {
      const mine = c.conversationId === opts.conversationId;
      const label = mine ? "This conversation" : redactContactHandle(c.conversationId.replace(/^sms:/, ""));
      const head =
        c.answeringSince !== null
          ? `${label}: answering a message (started ${ago(now - c.answeringSince)} ago), ${c.queued.length} queued behind it`
          : `${label}: ${c.queued.length} queued, about to be answered`;
      const lines = c.queued.map((q, i) => {
        const images = q.mediaCount > 0 ? ` [${q.mediaCount === 1 ? "1 image" : `${q.mediaCount} images`}]` : "";
        return `  ${i + 1}. ${JSON.stringify(q.content || "(no text)")}${images}, sent ${ago(now - q.receivedAt)} ago`;
      });
      return [head, ...lines].join("\n");
    })
    .join("\n\n");
}
