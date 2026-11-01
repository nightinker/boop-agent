import { randomUUID } from "node:crypto";
import { scanForSecrets } from "./secrets/redact.js";

/**
 * Inbound iMessage queue. Every text is saved (by the store) before Boop
 * answers it; each conversation is then drained one text at a time, oldest
 * first, so a second text sent while Boop is still answering the first waits
 * for that reply and sees it in the history. Different conversations still
 * run side by side.
 *
 * With a quiet period (debounceMs > 0) Boop doesn't answer straight away:
 * each new text restarts a per-conversation timer, and only once the sender
 * has been silent that long (and isn't typing) are all waiting texts claimed
 * together and answered as one turn. Texts that arrive while Boop is still
 * answering wait for the next batch. The texts themselves are saved before
 * the timer starts, so a restart mid-wait loses nothing: they're answered
 * when the queue recovers.
 */

export interface InboundInput {
  handle: string;
  conversationId: string;
  fromNumber: string;
  content: string;
  mediaUrls: string[];
  source: "webhook" | "poll";
  receivedAt: number;
}

export interface InboundItem extends InboundInput {
  _id: string;
  attempts: number;
}

export interface InboundStore {
  /** False when a text with this handle was already saved or answered. */
  enqueue(input: InboundInput): Promise<boolean>;
  /** The oldest queued text, or null if none or one is already being answered. */
  claimNext(conversationId: string): Promise<InboundItem | null>;
  /** Every queued text, oldest first; empty if none or one is already being answered. */
  claimQueued(conversationId: string): Promise<InboundItem[]>;
  finish(id: string, status: "done" | "failed", error?: string): Promise<void>;
  recoverInterrupted(): Promise<{ requeued: number; failed: number }>;
  pendingConversations(): Promise<string[]>;
}

/** Extra facts about a text that aren't saved with it. */
export interface InboundMeta {
  /**
   * How the text arrived ("iMessage", "SMS", "RCS"). Only iMessage has typing
   * indicators, so after an SMS/RCS text the conversation ignores them and
   * keeps the plain quiet period. Unknown counts as iMessage.
   */
  service?: string;
}

/** What a typing signal did: held or restarted an open quiet period, or nothing. */
export type TypingOutcome = "held" | "restarted" | "ignored";

export interface InboundQueue {
  enqueue(input: InboundInput, meta?: InboundMeta): Promise<boolean>;
  /** Answers every queued text in one conversation; resolves when it's empty. */
  drain(conversationId: string): Promise<void>;
  /** Safety net: drain every conversation that has texts waiting. */
  drainAll(): Promise<void>;
  /** On startup: requeue texts a crash cut off, then answer everything waiting. */
  recover(): Promise<{ requeued: number; failed: number }>;
  /**
   * The sender started or stopped typing. While they type, an open quiet
   * period is held open (at most maxTypingWaitMs after typing first started
   * since their last text); when they stop, the quiet period restarts.
   * Ignored when no text is waiting (unknown numbers, idle conversations) and
   * after an SMS/RCS text. Never throws.
   */
  noteTyping(conversationId: string, isTyping: boolean): TypingOutcome;
  /** True while this copy is answering texts or waiting out a quiet period. */
  isBusy(): boolean;
  /**
   * On shutdown: cancel the quiet-period timers. The waiting texts stay
   * saved as queued and are answered after the restart (or by the copy that
   * takes over). Returns how many conversations were still waiting.
   */
  stop(): number;
}

const FINISH_RETRIES = 3;

export const DEFAULT_DEBOUNCE_MS = 5_000;
export const DEFAULT_MAX_TYPING_WAIT_MS = 60_000;

/** BOOP_MESSAGE_DEBOUNCE_MS: quiet period before answering; 0 turns it off. */
export function debounceMsFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DEBOUNCE_MS;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_DEBOUNCE_MS;
}

/** BOOP_MAX_TYPING_HOLD_MS: longest "typing…" can hold replies back; 0 = ignore typing. */
export function maxTypingHoldMsFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_TYPING_WAIT_MS;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_MAX_TYPING_WAIT_MS;
}

/** True unless the service is known and isn't iMessage (SMS, RCS, …). */
export function supportsTyping(service: string | undefined): boolean {
  if (!service || !service.trim()) return true;
  return service.trim().toLowerCase() === "imessage";
}

/** Folds a burst of texts into one: contents joined by newlines, in order, with every image. */
export function combineInbound(items: InboundItem[]): InboundItem {
  if (items.length === 1) return items[0];
  const last = items[items.length - 1];
  return {
    ...last,
    _id: items[0]._id,
    content: items
      .map((item) => item.content)
      .filter((content) => content.length > 0)
      .join("\n"),
    mediaUrls: items.flatMap((item) => item.mediaUrls),
    source: items.some((item) => item.source === "webhook") ? "webhook" : "poll",
    receivedAt: items[0].receivedAt,
    attempts: Math.max(...items.map((item) => item.attempts)),
  };
}

export function createInboundQueue(deps: {
  store: InboundStore;
  process: (item: InboundItem) => Promise<void>;
  log?: Pick<Console, "error" | "warn">;
  retryDelayMs?: number;
  /**
   * Whether this copy of Boop answers texts. A standby copy still saves every
   * text (so nothing is lost if it takes over) but leaves answering to the
   * active one.
   */
  isActive?: () => boolean;
  /** Quiet period before a conversation's texts are answered together. 0 = answer each at once. */
  debounceMs?: number;
  /**
   * Longest a "typing…" signal can hold a quiet period open without a new
   * text, counted from when typing first started. 0 = ignore typing.
   */
  maxTypingWaitMs?: number;
}): InboundQueue {
  const { store, process } = deps;
  const isActive = deps.isActive ?? (() => true);
  const log = deps.log ?? console;
  const retryDelayMs = deps.retryDelayMs ?? 1_000;
  const draining = new Map<string, Promise<void>>();
  // Set when a text arrives while its conversation is draining, so the
  // running loop checks once more before it stops.
  const again = new Set<string>();
  const debounceMs = Math.max(0, deps.debounceMs ?? 0);
  const maxTypingWaitMs = Math.max(0, deps.maxTypingWaitMs ?? DEFAULT_MAX_TYPING_WAIT_MS);
  // Open quiet periods: a conversation in here isn't answered until it fires.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const typing = new Set<string>();
  // When typing first held each open quiet period; the hard cap counts from here.
  const holdStartedAt = new Map<string, number>();
  // Conversations whose latest text came over SMS/RCS: no typing indicators there.
  const noTyping = new Set<string>();

  function startQuietPeriod(conversationId: string): void {
    const pending = timers.get(conversationId);
    if (pending) clearTimeout(pending);
    let wait = debounceMs;
    if (typing.has(conversationId)) {
      // Hold until they stop typing, but never past the cap: a lost
      // is_typing=false (or a stream of is_typing=true) can't stall replies.
      const started = holdStartedAt.get(conversationId) ?? Date.now();
      holdStartedAt.set(conversationId, started);
      wait = Math.max(0, started + maxTypingWaitMs - Date.now());
    }
    const timer = setTimeout(() => {
      timers.delete(conversationId);
      if (typing.delete(conversationId)) {
        log.warn(`[inbound] still "typing" after ${maxTypingWaitMs}ms; answering anyway`);
      }
      holdStartedAt.delete(conversationId);
      void drain(conversationId);
    }, wait);
    timer.unref?.();
    timers.set(conversationId, timer);
  }

  function cancelQuietPeriod(conversationId: string): void {
    const pending = timers.get(conversationId);
    if (pending) clearTimeout(pending);
    timers.delete(conversationId);
    typing.delete(conversationId);
    holdStartedAt.delete(conversationId);
  }

  async function claim(conversationId: string): Promise<InboundItem[]> {
    if (debounceMs > 0) return store.claimQueued(conversationId);
    const item = await store.claimNext(conversationId);
    return item ? [item] : [];
  }

  async function finish(item: InboundItem, status: "done" | "failed", error?: string) {
    for (let attempt = 1; attempt <= FINISH_RETRIES; attempt++) {
      try {
        await store.finish(item._id, status, error);
        return;
      } catch (err) {
        if (attempt === FINISH_RETRIES) {
          log.error(`[inbound] couldn't mark ${item._id} ${status}`, err);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

  async function loop(conversationId: string): Promise<void> {
    do {
      again.delete(conversationId);
      for (;;) {
        // Stop claiming new texts once this copy stands down; the active
        // copy picks up the rest.
        if (!isActive()) break;
        // The sender is still mid-burst; the quiet-period timer drains later.
        if (timers.has(conversationId)) break;
        const batch = await claim(conversationId);
        if (batch.length === 0) break;
        const item = combineInbound(batch);
        try {
          await process(item);
          for (const claimed of batch) await finish(claimed, "done");
        } catch (err) {
          log.error(`[inbound] answering ${item._id} failed`, err);
          const message = err instanceof Error ? err.message : String(err);
          for (const claimed of batch) await finish(claimed, "failed", message);
        }
      }
    } while (again.has(conversationId));
  }

  function drain(conversationId: string): Promise<void> {
    if (!isActive()) return Promise.resolve();
    const running = draining.get(conversationId);
    if (running) {
      again.add(conversationId);
      return running;
    }
    const run = loop(conversationId)
      .catch((err) => log.error(`[inbound] queue for a conversation stopped`, err))
      .finally(() => {
        draining.delete(conversationId);
        // A text that arrived after the loop's last check but before this
        // point would otherwise wait for the next poll.
        if (again.delete(conversationId)) void drain(conversationId);
      });
    draining.set(conversationId, run);
    return run;
  }

  async function drainAll(): Promise<void> {
    const conversations = await store.pendingConversations();
    await Promise.all(conversations.map((id) => drain(id)));
  }

  return {
    async enqueue(input, meta) {
      const { conversationId } = input;
      if (supportsTyping(meta?.service)) noTyping.delete(conversationId);
      else noTyping.add(conversationId);
      if (debounceMs <= 0) {
        const enqueued = await store.enqueue(input);
        if (enqueued) void drain(conversationId);
        return enqueued;
      }
      // Open (or restart) the quiet period before saving, so a drain already
      // in flight can't claim this text and answer it before the burst ends.
      const wasWaiting = timers.has(conversationId);
      // A text arriving means they stopped typing; a later "typing…" starts
      // a fresh hold.
      typing.delete(conversationId);
      holdStartedAt.delete(conversationId);
      startQuietPeriod(conversationId);
      const timer = timers.get(conversationId);
      let enqueued = false;
      try {
        enqueued = await store.enqueue(input);
        return enqueued;
      } finally {
        // A duplicate (or a failed save) for an idle conversation shouldn't
        // hold it up; the timer would only drain nothing new anyway.
        if (!enqueued && !wasWaiting && timers.get(conversationId) === timer) cancelQuietPeriod(conversationId);
      }
    },
    drain,
    drainAll,
    noteTyping(conversationId, isTyping) {
      try {
        if (debounceMs <= 0 || maxTypingWaitMs <= 0) return "ignored";
        // Typing only matters while texts are waiting to be answered; that also
        // drops signals from numbers that never texted (or were already answered).
        if (!timers.has(conversationId)) return "ignored";
        // SMS/RCS keep the plain quiet period.
        if (noTyping.has(conversationId)) return "ignored";
        if (isTyping) {
          // Already holding: a repeat "typing…" doesn't extend the cap.
          if (typing.has(conversationId)) return "held";
          typing.add(conversationId);
          startQuietPeriod(conversationId);
          return "held";
        }
        typing.delete(conversationId);
        startQuietPeriod(conversationId);
        return "restarted";
      } catch (err) {
        log.warn("[inbound] couldn't apply a typing signal", err);
        return "ignored";
      }
    },
    isBusy: () => draining.size > 0 || timers.size > 0,
    stop() {
      const waiting = timers.size;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      typing.clear();
      holdStartedAt.clear();
      noTyping.clear();
      return waiting;
    },
    async recover() {
      const result = await store.recoverInterrupted();
      void drainAll().catch((err) => log.error("[inbound] drain after restart failed", err));
      return result;
    },
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function extractSendblueMediaUrls(mediaUrl: unknown, mediaUrls: unknown): string[] {
  const urls = new Set<string>();
  if (Array.isArray(mediaUrls)) {
    for (const value of mediaUrls) {
      if (typeof value === "string" && value.trim()) urls.add(value.trim());
    }
  }
  if (typeof mediaUrl === "string" && mediaUrl.trim()) urls.add(mediaUrl.trim());
  return [...urls];
}

/**
 * Turns a Sendblue message (webhook body or an item from the messages API)
 * into a queue entry. Null for outbound messages and empty ones.
 */
export function inboundFromSendblue(
  payload: unknown,
  source: InboundInput["source"],
  now = Date.now(),
): InboundInput | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  if (body.is_outbound) return null;
  const fromNumber = str(body.from_number) || str(body.number);
  const content = str(body.content);
  const mediaUrls = extractSendblueMediaUrls(body.media_url, body.media_urls);
  if (!fromNumber || (!content && mediaUrls.length === 0)) return null;
  const sentAt = Date.parse(str(body.date_sent) || str(body.date_created) || str(body.date_updated));
  return {
    // Without a handle there's nothing to dedupe on, so it's always new.
    handle: str(body.message_handle) || `local:${randomUUID()}`,
    conversationId: `sms:${fromNumber}`,
    fromNumber,
    // Anything that looks like a credential is cut out before the text is
    // saved; the turn then warns the owner to rotate it.
    content: scanForSecrets(content).redacted,
    mediaUrls,
    source,
    receivedAt: Number.isFinite(sentAt) ? sentAt : now,
  };
}

/** The service a Sendblue message came over ("iMessage", "SMS", "RCS"), if it says. */
export function serviceFromSendblue(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  return str((payload as Record<string, unknown>).service) || undefined;
}

/**
 * Reads a Sendblue typing-indicator webhook ({ number, is_typing, ... }).
 * There `number` is the contact and `from_number` is Boop's own line.
 */
export function typingFromSendblue(payload: unknown): { conversationId: string; isTyping: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.is_typing !== "boolean") return null;
  const number = str(body.number);
  if (!number) return null;
  return { conversationId: `sms:${number}`, isTyping: body.is_typing };
}
