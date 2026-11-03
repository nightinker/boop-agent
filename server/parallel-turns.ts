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
 * Prompt note naming the messages another turn is answering right now, so
 * this turn neither answers them twice nor treats them as unanswered.
 * Empty when nothing else is running.
 */
export function parallelTurnsNote(contents: string[]): string {
  if (contents.length === 0) return "";
  const lines = contents.map((c) => `- ${JSON.stringify(snippet(c, 300) || "(no text)")}`);
  return [
    "Being answered in parallel right now by a separate reply (don't answer or repeat these here; answer only the current message, and don't assume their outcome):",
    ...lines,
  ].join("\n");
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
