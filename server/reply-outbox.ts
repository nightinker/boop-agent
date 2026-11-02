/**
 * Replies Boop wrote but couldn't send because the network dropped. They're
 * saved to Convex (replyOutbox) and the active copy (the Mac, or the server
 * once it has taken over) resends them. Only the text is resent: no model
 * call, no agent re-run, so nothing is done twice.
 */

export const OUTBOX_FLUSH_INTERVAL_MS = 60_000;
/** A reply older than this is dropped instead of sent: it's stale by then. */
export const OUTBOX_MAX_AGE_MS = 2 * 60 * 60_000;

export interface OutboxRow {
  _id: string;
  conversationId: string;
  toNumber: string;
  content: string;
  createdAt: number;
  attempts: number;
}

export interface OutboxDeps {
  pending: () => Promise<OutboxRow[]>;
  send: (toNumber: string, text: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  noteAttempt: (id: string, error: string) => Promise<void>;
  isActive: () => boolean;
  now?: () => number;
  log?: Pick<Console, "log" | "warn">;
}

/** Sends every waiting reply, oldest first. Stops at the first failure: the network is still down. */
export async function flushReplyOutbox(deps: OutboxDeps): Promise<{ sent: number; dropped: number; failed: boolean }> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  let sent = 0;
  let dropped = 0;
  if (!deps.isActive()) return { sent, dropped, failed: false };
  for (const row of await deps.pending()) {
    if (!deps.isActive()) break;
    if (now() - row.createdAt > OUTBOX_MAX_AGE_MS) {
      log.warn(`[outbox] dropping a reply that's ${Math.round((now() - row.createdAt) / 60_000)} min old`);
      await deps.remove(row._id);
      dropped++;
      continue;
    }
    try {
      await deps.send(row.toNumber, row.content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[outbox] resend failed (${message}); trying again later`);
      await deps.noteAttempt(row._id, message).catch(() => undefined);
      return { sent, dropped, failed: true };
    }
    await deps.remove(row._id);
    sent++;
    log.log(`[outbox] resent a reply that didn't go out the first time`);
  }
  return { sent, dropped, failed: false };
}

/** Flushes now and then every interval; overlapping runs are skipped. */
export function startReplyOutbox(deps: OutboxDeps, intervalMs = OUTBOX_FLUSH_INTERVAL_MS): { flush: () => Promise<void>; stop: () => void } {
  let running: Promise<void> | null = null;
  const flush = () => {
    running ??= flushReplyOutbox(deps)
      .then(() => undefined)
      .catch((err) => (deps.log ?? console).warn("[outbox] flush failed", err instanceof Error ? err.message : err))
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => void flush(), intervalMs);
  timer.unref?.();
  return { flush, stop: () => clearInterval(timer) };
}
