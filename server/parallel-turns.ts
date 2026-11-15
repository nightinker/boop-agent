/**
 * Helpers for answering more than one message in a conversation at once
 * (maxConcurrentRuns > 1): each turn's history stops at its own message,
 * knows which messages another turn is answering right now, and a reply
 * that overlapped another one says which message it answers.
 */

export interface HistoryMessage {
  role: string;
  content: string;
  turnId?: string;
}

/**
 * The messages before this turn's own inbound message. A message saved
 * after it (another text being answered in parallel) isn't this turn's
 * history. Falls back to everything but the newest message when the turn's
 * own message isn't in the window.
 */
export function historyBeforeTurn<T extends HistoryMessage>(messages: T[], turnId: string): T[] {
  const own = messages.findIndex((m) => m.turnId === turnId && m.role !== "assistant");
  return own >= 0 ? messages.slice(0, own) : messages.slice(0, -1);
}

function snippet(content: string, max: number): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Prompt note naming the messages another turn has already claimed and is
 * answering right now, so this turn neither answers them twice nor treats
 * them as unanswered (they can show up in the prior turns with no reply yet).
 * Empty when nothing else is running.
 */
export function parallelTurnsNote(contents: string[]): string {
  if (contents.length === 0) return "";
  const lines = contents.map((c) => `- ${JSON.stringify(snippet(c, 300) || "(no text)")}`);
  return [
    "Being answered in parallel right now by a separate reply, which already claimed these messages (don't answer or repeat these here, even if they look unanswered in the prior turns; answer only the current message, and don't assume their outcome):",
    ...lines,
  ].join("\n");
}

/** What a saved text says, for a prompt note: its words, or what it attached. */
export function messageLabel(item: { content: string; mediaUrls: string[] }): string {
  if (item.content.trim()) return item.content;
  if (item.mediaUrls.length === 0) return "";
  return item.mediaUrls.length === 1 ? "(an image)" : `(${item.mediaUrls.length} images)`;
}

/**
 * Prompt note for a current message that is several texts the sender fired
 * off in a row (joined oldest first by the quiet period): one thread of
 * intent, one coherent reply. Empty for a single text.
 */
export function burstNote(count: number): string {
  if (count < 2) return "";
  return (
    `The current message is ${count} texts the same person sent in a row in this conversation, joined oldest first, one per line. ` +
    "Treat them as one thread of intent, not separate requests: a later text that corrects, narrows or overrides an earlier one wins, " +
    "and overlapping or repeated asks are one ask. Send one coherent reply that covers the whole thread, without repeating yourself."
  );
}

/**
 * Prompt note for a turn redone because more texts arrived while its reply
 * was being written: the held-back drafts (never sent) and what they were
 * answering, so the new reply builds on work already done (sub-agent results,
 * sent acks, actions taken) instead of repeating it. Empty on a first try.
 */
export function heldReplyNote(held: Array<{ reply: string; answered: number }>): string {
  if (held.length === 0) return "";
  const drafts = held.map((h) => {
    const which = h.answered === 1 ? "message 1" : `messages 1-${h.answered}`;
    return `Draft that answered ${which} (NOT sent):\n${snippet(h.reply, 1500) || "(empty)"}`;
  });
  return [
    "You already started answering the earlier messages, but newer ones arrived before that reply went out, so it was held back and the user never saw it. " +
      "Anything that turn already did is done: tools and sub-agents it ran, drafts it made, and any short acks it sent (those show in the prior turns). " +
      "Don't redo that work or spawn the same task again; reuse its results below. Don't repeat an ack. " +
      "Write the single reply the user will actually see, covering every current message, with later messages winning where they change or cancel earlier ones.",
    ...drafts,
  ].join("\n\n");
}

/**
 * The user prompt for one turn: prior turns, the messages another turn is
 * answering, how the current message was put together, any held-back draft,
 * then the message. Just the message when there's nothing else to say.
 */
export function turnPrompt(parts: {
  history: string;
  parallelNote: string;
  batchNote: string;
  message: string;
  heldNote?: string;
}): string {
  const { history, parallelNote, batchNote, message } = parts;
  const heldNote = parts.heldNote ?? "";
  if (!history && !parallelNote && !batchNote && !heldNote) return message;
  return [history ? `Prior turns:\n${history}` : "", parallelNote, batchNote, heldNote, `Current message:\n${message}`]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The line that starts a reply sent while another answer in the same
 * conversation was running, so the sender can tell which message it answers.
 */
export function replyHeading(batch: Array<{ content: string; mediaUrls: string[] }>): string {
  if (batch.length > 1) return `↪ Re your ${batch.length} messages:`;
  const [only] = batch;
  if (!only) return "";
  const text = snippet(only.content, 60);
  if (text) return `↪ Re "${text}":`;
  return only.mediaUrls.length > 1 ? "↪ Re your images:" : "↪ Re your image:";
}

export function withReplyHeading(reply: string, heading: string): string {
  return heading ? `${heading}\n${reply}` : reply;
}

/**
 * Runs work one at a time per key (e.g. per recipient), in call order, so
 * two replies split into several texts never interleave. A failure doesn't
 * block the next caller.
 */
export function createKeyedLock() {
  const tails = new Map<string, Promise<unknown>>();
  return function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}
