import { randomUUID } from "node:crypto";
import { redactContactHandle } from "./privacy.js";
import { scanForSecrets } from "./secrets/redact.js";

/**
 * Inbound iMessage queue. Every text is saved (by the store) before Boop
 * answers it; each conversation is then drained oldest first, with up to
 * maxConcurrentRuns answers running at once (1 = strictly one at a time, so
 * a second text waits for the first reply and sees it in the history). With
 * a free slot a new text starts its own answer straight away; only when every
 * slot is busy does it wait in the queue. Slots are counted by the store when
 * a text is claimed, so they hold across restarts and Mac/server copies.
 * Different conversations always run side by side.
 *
 * With a quiet period (debounceMs > 0) Boop doesn't answer straight away:
 * each new text restarts a per-conversation timer, and once the sender has
 * been silent that long all waiting texts are claimed together and answered
 * as one turn.
 *
 * iMessage typing indicators (Sendblue only sends "started" and "stopped",
 * no repeats while typing) keep the hold open: after "started typing" Boop
 * waits for "stopped typing" + one quiet period, and a "started" whose
 * "stopped" never arrives is trusted for typingIdleMs (30s) from the latest
 * signal. Every hold has a hard deadline from its first waiting text that
 * nothing can push out: 15s while only texts arrive, and the larger typing cap
 * (maxTypingWaitMs, 60s by default) once the sender has been seen typing, so
 * a lost "stopped typing" event can never stall a reply for long.
 * Texts that arrive while Boop is still answering wait for the next batch.
 * The texts themselves are saved before the timer starts, so a restart
 * mid-wait loses nothing: they're answered when the queue recovers.
 *
 * A text that arrives while every slot is busy (long turns, spawned
 * sub-agents) waits behind those answers, and the sender gets a short "Got
 * it, queued behind the current task (position N)" so it doesn't look
 * ignored; positions count waiting texts only. Once a slot frees,
 * everything that waited is answered in one turn, oldest first and
 * numbered. A bare "never mind" while texts are waiting
 * drops those texts instead.
 *
 * With mergeInFlight on, a text that arrives while a reply in its
 * conversation is still being written (a long turn, a running sub-agent)
 * doesn't get its own answer. Just before that reply would be sent, the run
 * waits out the new texts' quiet period, claims them, holds the draft back
 * unsent and answers again: every text, old and new, numbered oldest first,
 * with the held draft (and what it already did) in the prompt, so one final
 * reply covers everything. A reply with no new texts behind it goes out
 * exactly as before. Redone at most maxRedos times, then it's sent.
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
  /**
   * The oldest queued text, or null if none or maxConcurrent (default 1)
   * texts are already being answered.
   */
  claimNext(conversationId: string, opts?: { maxConcurrent?: number }): Promise<InboundItem | null>;
  /**
   * Every queued text, oldest first; empty if none or maxConcurrent (default
   * 1) texts are already being answered. With maxGapMs it stops at the first
   * text sent more than that long after the one before it. heldIds are texts
   * the caller is already answering and merging these into; they don't count
   * against maxConcurrent.
   */
  claimQueued(
    conversationId: string,
    opts?: { maxGapMs?: number; maxConcurrent?: number; heldIds?: string[] },
  ): Promise<InboundItem[]>;
  finish(id: string, status: "done" | "failed", error?: string): Promise<void>;
  recoverInterrupted(): Promise<{ requeued: number; failed: number }>;
  pendingConversations(): Promise<string[]>;
  /**
   * Whether a text in this conversation is being answered right now, how many
   * answers are running, and the texts waiting for a slot, oldest first.
   */
  waiting(
    conversationId: string,
  ): Promise<{ busy: boolean; processing: number; queued: Array<{ _id: string; handle: string }> }>;
  /** Drops texts that are still waiting (not ones being answered); returns how many it dropped. */
  cancel(ids: string[], reason: string): Promise<number>;
}

/** A reply that was written but held back unsent because more texts arrived. */
export interface HeldReply {
  reply: string;
  /** What the reply would have sent with it (images); carried to the final reply. */
  attachments: unknown[];
  /** How many of the batch's texts (oldest first) that reply was answering. */
  answered: number;
}

/** What process() hands back when it held its reply instead of sending it. */
export interface ProcessOutcome {
  held?: { reply: string; attachments?: unknown[] };
}

/** What an answer knows about the other answers running in its conversation. */
export interface RunContext {
  /**
   * The saved texts this answer covers, oldest first (before they were
   * combined). Grows when later texts are merged into this answer.
   */
  batch: InboundItem[];
  /**
   * True when these texts waited behind a busy slot (numbered in the combined
   * text); false for a single text or a quiet-period burst.
   */
  waitedBehindRun: boolean;
  /** The other answers running in this conversation right now, oldest first. */
  parallel(): InboundItem[];
  /**
   * Every saved text another answer in this conversation has already claimed
   * and is answering right now, oldest first, as sent (not combined). This
   * answer must not reply to them too.
   */
  claimedElsewhere(): InboundItem[];
  /** True once another answer in this conversation has run at the same time as this one. */
  overlapped(): boolean;
  /**
   * Call with the reply written, just before sending it. True means newer
   * texts were merged into this answer: don't send, return { held: reply }
   * from process(), and the queue answers again with every text. False
   * means send it (and later texts get their own answer). Resolves at once
   * when nothing new arrived; never rejects.
   */
  beforeSend(): Promise<boolean>;
  /** Replies already held back for this answer, oldest first (empty on the first try). */
  held: readonly HeldReply[];
}

/** Who to send a "queued" acknowledgement to. */
export interface AckTarget {
  conversationId: string;
  fromNumber: string;
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
   * The sender started or stopped typing. "Started" holds an open hold until
   * "stopped" (or typingIdleMs without another signal); "stopped" restarts
   * the quiet period. Never past the hold's hard deadline. Matched to the
   * waiting conversation by phone digits, so "+1 (555) …" and "555…" agree.
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

/** Answers a conversation runs at once unless configured otherwise (the maxConcurrentRuns setting). */
export const DEFAULT_MAX_CONCURRENT_RUNS = 2;
/** The most maxConcurrentRuns may be set to, so a typo can't fan out a dozen agent runs. */
export const MAX_CONCURRENT_RUNS_CEILING = 5;

/** Reads a maxConcurrentRuns value: a whole number from 1 to the ceiling, else the fallback. */
export function parseMaxConcurrentRuns(
  value: string | number | null | undefined,
  fallback = DEFAULT_MAX_CONCURRENT_RUNS,
): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_CONCURRENT_RUNS_CEILING);
}

export const DEFAULT_DEBOUNCE_MS = 5_000;
/** Hard cap on how long texts alone are held, counted from the first waiting text. */
export const DEFAULT_MAX_HOLD_MS = 15_000;
/** Hard cap once the sender has been seen typing, counted from the first waiting text. */
export const DEFAULT_MAX_TYPING_HOLD_MS = 60_000;
/** The most BOOP_MAX_TYPING_HOLD_MS may be set to, so a typo can't stall replies for minutes. */
export const MAX_TYPING_HOLD_CEILING_MS = 120_000;
/** How long one "started typing" is trusted when no further typing signal arrives. */
export const DEFAULT_TYPING_IDLE_MS = 30_000;
/**
 * How long a text waits behind a running answer before the sender is told
 * it's queued. Short, so the ack feels instant, but long enough that a reply
 * finishing a moment later doesn't come with a pointless "queued" text.
 */
export const DEFAULT_ACK_DELAY_MS = 2_000;
/** Most times one answer is held back and redone for newer texts before it's sent anyway. */
export const DEFAULT_MAX_REDOS = 3;
/**
 * Texts that waited behind an answer are answered together only when each
 * came within this long of the one before; a bigger gap starts a new turn.
 */
export const DEFAULT_QUEUE_BATCH_GAP_MS = 2 * 60_000;

/** BOOP_QUEUE_ACK_DELAY_MS: wait before the "queued" ack; 0 = straight away. */
export function ackDelayMsFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_ACK_DELAY_MS;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : DEFAULT_ACK_DELAY_MS;
}

/** The "queued" ack: one text, or several that arrived together. Positions count from 1. */
export function queuedAckText(positions: number[]): string {
  const sorted = [...positions].sort((a, b) => a - b);
  if (sorted.length === 1) return `Got it, queued behind the current task (position ${sorted[0]}).`;
  const contiguous = sorted.every((p, i) => i === 0 || p === sorted[i - 1] + 1);
  const where = contiguous ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(", ");
  return `Got it, ${sorted.length} messages queued behind the current task (positions ${where}).`;
}

/** The ack for texts that will be folded into the reply being written. */
export function mergeAckText(count: number): string {
  return count === 1
    ? "Got it, I'll fold that into the reply I'm working on."
    : `Got it, I'll fold those ${count} messages into the reply I'm working on.`;
}

/** The ack for a "never mind" that dropped waiting texts. */
export function cancelAckText(dropped: number): string {
  const what = dropped === 1 ? "1 queued message" : `${dropped} queued messages`;
  return `Okay, dropped ${what}. The current task is still running; I'll reply when it's done.`;
}

const CANCEL_PATTERN =
  /^(?:(?:oh|ah|ok|okay|actually|wait|hmm|sorry|no)\s+)*(?:never ?mind|nvm|cancel|forget|ignore|scratch|disregard)(?:\s+(?:that|it|this|those|them|all|all that|all of that|everything|the rest|my last messages?|what i said))?(?:\s+(?:please|pls|thanks|thx))?$/;

/**
 * True for a text that only says "never mind" (or "cancel", "forget it",
 * "scratch that", …). Anything with more to it is a real message.
 */
export function isCancelRequest(content: string): boolean {
  const normalized = content
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > 60) return false;
  return CANCEL_PATTERN.test(normalized);
}

/** BOOP_MESSAGE_DEBOUNCE_MS: quiet period before answering; 0 turns it off. */
export function debounceMsFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_DEBOUNCE_MS;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_DEBOUNCE_MS;
}

/**
 * BOOP_MESSAGE_MAX_HOLD_MS: hard cap on a hold with texts alone (default 15s),
 * counted from the first waiting text. Never below the quiet period; at most
 * the typing ceiling (120s).
 */
export function maxHoldMsFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_HOLD_MS;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_TYPING_HOLD_CEILING_MS) : DEFAULT_MAX_HOLD_MS;
}

/** BOOP_MERGE_INFLIGHT_REPLIES: hold back and redo a reply when texts arrive mid-reply (default on). */
export function mergeInFlightFromEnv(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return !/^(0|false|off|no)$/i.test(value.trim());
}

/**
 * BOOP_MAX_TYPING_HOLD_MS: hard cap on a hold while the sender is typing
 * (default 60s, at most 120s); 0 = ignore typing.
 */
export function maxTypingHoldMsFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_TYPING_HOLD_MS;
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_TYPING_HOLD_CEILING_MS) : DEFAULT_MAX_TYPING_HOLD_MS;
}

/**
 * The part of a conversation id that identifies the contact, for matching
 * typing signals to waiting texts: phone digits without a US "1" prefix, or
 * a lowercased email handle.
 */
export function contactMatchKey(conversationId: string): string {
  const handle = conversationId.replace(/^sms:/, "").trim().toLowerCase();
  if (handle.includes("@")) return handle;
  const digits = handle.replace(/\D/g, "");
  if (!digits) return handle;
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** True unless the service is known and isn't iMessage (SMS, RCS, …). */
export function supportsTyping(service: string | undefined): boolean {
  if (!service || !service.trim()) return true;
  return service.trim().toLowerCase() === "imessage";
}

/**
 * The line above a numbered batch of texts that waited behind a running
 * answer: says they're one person's messages and asks for one combined reply.
 */
export function queuedBatchHeader(count: number): string {
  return (
    `[${count} messages sent while you were busy with the previous task, all from the same person in this same conversation, numbered oldest first. ` +
    `Write ONE combined reply that addresses all ${count} in order: merge overlapping or duplicate asks, ` +
    `don't answer each one as a separate standalone message, and don't repeat yourself. ` +
    `If a later message corrects, changes or cancels an earlier one, go with the later one.]`
  );
}

/**
 * The line above a numbered batch that grew while its reply was being
 * written: the reply to the first texts was held back unsent so one answer
 * covers them all.
 */
export function mergedBatchHeader(count: number): string {
  return (
    `[${count} messages from the same person in this same conversation, numbered oldest first. ` +
    `The later ones arrived while you were still answering the earlier ones, so that reply was held back and never sent. ` +
    `Write ONE combined reply that addresses all ${count}: merge overlapping or duplicate asks, ` +
    `don't answer each one as a separate standalone message, and don't repeat yourself. ` +
    `If a later message corrects, changes or cancels an earlier one, go with the later one.]`
  );
}

/**
 * Folds a burst of texts into one: contents joined by newlines, in order, with
 * every image. Texts that waited behind a running answer are numbered instead,
 * each line noting its own images, so their order and what goes with what
 * survive the merge.
 */
export function combineInbound(
  items: InboundItem[],
  opts: { waitedBehindRun?: boolean; merged?: boolean } = {},
): InboundItem {
  if (items.length === 1) return items[0];
  const last = items[items.length - 1];
  const content = opts.waitedBehindRun || opts.merged
    ? [
        opts.merged ? mergedBatchHeader(items.length) : queuedBatchHeader(items.length),
        ...items.map((item, i) => {
          const images = item.mediaUrls.length;
          const note = images > 0 ? ` [${images === 1 ? "1 image" : `${images} images`} attached]` : "";
          return `${i + 1}. ${item.content || "(no text)"}${note}`;
        }),
      ].join("\n")
    : items
        .map((item) => item.content)
        .filter((content) => content.length > 0)
        .join("\n");
  return {
    ...last,
    _id: items[0]._id,
    content,
    mediaUrls: items.flatMap((item) => item.mediaUrls),
    source: items.some((item) => item.source === "webhook") ? "webhook" : "poll",
    receivedAt: items[0].receivedAt,
    attempts: Math.max(...items.map((item) => item.attempts)),
  };
}

export function createInboundQueue(deps: {
  store: InboundStore;
  process: (item: InboundItem, run: RunContext) => Promise<void | ProcessOutcome>;
  log?: Pick<Console, "error" | "warn"> & Partial<Pick<Console, "log">>;
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
   * Hard cap on a hold once the sender has been seen typing, counted from the
   * first waiting text: no typing signal can delay the answer past this.
   * 0 = ignore typing (texts alone keep the 15s cap).
   */
  maxTypingWaitMs?: number;
  /** How long one "started typing" holds without another signal (default 30s). */
  typingIdleMs?: number;
  /**
   * Sends the short "queued behind the current task" text. Without it texts
   * still queue and drain in order, just without the ack. Never awaited by
   * the webhook path for longer than one store read.
   */
  acknowledge?: (target: AckTarget, text: string) => Promise<void>;
  /** Wait before the ack (default 2s), so a reply that's about to land doesn't get one. */
  ackDelayMs?: number;
  /** Largest gap between queued texts answered in one turn (default 2 minutes). */
  queueBatchGapMs?: number;
  /**
   * Answers one conversation may run at once (default 1 here; Boop's server
   * passes the maxConcurrentRuns setting, default 2). Read before every
   * claim, so a changed setting applies to the next text.
   */
  maxConcurrentRuns?: number | (() => number | Promise<number>);
  /** Hard cap on a hold with texts alone, from the first waiting text (default 15s). */
  maxHoldMs?: number;
  /**
   * Texts that arrive while a reply in their conversation is still being
   * written are merged into it (the reply is held back and redone) instead of
   * getting their own answer. Off by default here; Boop's server turns it on.
   */
  mergeInFlight?: boolean;
  /** Most times one answer is redone for newer texts (default 3). */
  maxRedos?: number;
}): InboundQueue {
  const { store, process } = deps;
  const isActive = deps.isActive ?? (() => true);
  const log = deps.log ?? console;
  const retryDelayMs = deps.retryDelayMs ?? 1_000;
  // One supervisor per conversation: it claims texts into free slots and
  // waits for answers to finish.
  const draining = new Map<string, Promise<void>>();
  // Set when a text arrives while its conversation is draining, so the
  // supervisor checks for a free slot once more before it waits or stops.
  const again = new Set<string>();
  // Wakes a supervisor that is waiting for an answer to finish.
  const wakers = new Map<string, () => void>();
  // Callers waiting for the supervisor's next claim pass (see afterNextClaim).
  const claimWaiters = new Map<string, Array<() => void>>();
  const debounceMs = Math.max(0, deps.debounceMs ?? 0);
  const maxTypingWaitMs = Math.max(0, deps.maxTypingWaitMs ?? DEFAULT_MAX_TYPING_HOLD_MS);
  const typingIdleMs = Math.max(debounceMs, deps.typingIdleMs ?? DEFAULT_TYPING_IDLE_MS);
  // The hard deadline of a hold with texts only. Never shorter than one
  // quiet period, so a lone text still gets its full wait.
  const maxHoldMs = Math.max(debounceMs, deps.maxHoldMs ?? DEFAULT_MAX_HOLD_MS);
  const mergeInFlight = deps.mergeInFlight ?? false;
  const maxRedos = Math.max(0, deps.maxRedos ?? DEFAULT_MAX_REDOS);
  // The hard deadline once the sender has been seen typing; never below the text cap.
  const maxTypingHoldMs = Math.max(maxHoldMs, maxTypingWaitMs);
  // Open quiet periods: a conversation in here isn't answered until it fires.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // When each open hold started (its first waiting text); the hard cap counts from here.
  const holdStartedAt = new Map<string, number>();
  // Holds where the sender is typing right now (last signal was "started").
  const typingNow = new Set<string>();
  // Holds that have seen any typing signal, so they get the larger cap.
  const sawTyping = new Set<string>();
  // Conversations whose latest text came over SMS/RCS: no typing indicators there.
  const noTyping = new Set<string>();
  // Flushes whose drain failed (e.g. the store was unreachable), retried a few times.
  const flushRetries = new Map<string, number>();
  const FLUSH_RETRY_LIMIT = 3;
  const ackDelayMs = Math.max(0, deps.ackDelayMs ?? DEFAULT_ACK_DELAY_MS);
  const queueBatchGapMs = Math.max(0, deps.queueBatchGapMs ?? DEFAULT_QUEUE_BATCH_GAP_MS);
  // Answers running on this copy right now, per conversation, oldest first.
  // open: the reply isn't written yet, so newer texts can still be merged
  // into it; newTexts: a text arrived since, check before sending.
  const answering = new Map<
    string,
    Array<{ item: InboundItem; batch: InboundItem[]; overlapped: boolean; open: boolean; newTexts: boolean }>
  >();
  const answeringCount = (conversationId: string) => answering.get(conversationId)?.length ?? 0;
  /** True while a reply here is still being written and would take newer texts in. */
  const mergeTarget = (conversationId: string) =>
    mergeInFlight && (answering.get(conversationId) ?? []).some((r) => r.open);
  // Callers waiting for a conversation's open hold to end (see holdEnded).
  const holdWaiters = new Map<string, Array<() => void>>();
  // Texts (by handle) that arrived while their conversation was being answered.
  const behindRun = new Set<string>();
  // Conversations with texts waiting behind an answer: drained as one batch next.
  const backlog = new Set<string>();
  // Acks waiting out ackDelayMs, per conversation, so texts sent together share one.
  const pendingAcks = new Map<string, { target: AckTarget; handles: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  const info = (message: string) => (log.log ? log.log(message) : undefined);

  async function concurrencyLimit(): Promise<number> {
    const configured = deps.maxConcurrentRuns;
    if (configured === undefined) return 1;
    try {
      const value = typeof configured === "function" ? await configured() : configured;
      return parseMaxConcurrentRuns(value, 1);
    } catch (err) {
      log.warn("[inbound] couldn't read maxConcurrentRuns; answering one text at a time", err);
      return 1;
    }
  }
  const who = (conversationId: string) => redactContactHandle(conversationId.replace(/^sms:/, ""));

  /**
   * Opens a hold, or re-arms it: one quiet period, or typingIdleMs while the
   * sender is typing. Never past the hold's hard deadline.
   */
  function startQuietPeriod(conversationId: string, why: string): void {
    const now = Date.now();
    const pending = timers.get(conversationId);
    if (pending) clearTimeout(pending);
    const started = pending ? (holdStartedAt.get(conversationId) ?? now) : now;
    holdStartedAt.set(conversationId, started);
    const typing = typingNow.has(conversationId);
    const cap = sawTyping.has(conversationId) ? maxTypingHoldMs : maxHoldMs;
    const deadline = started + cap;
    const wanted = typing ? typingIdleMs : debounceMs;
    const wait = Math.max(0, Math.min(wanted, deadline - now));
    const capped = wait < wanted;
    const mode = typing ? "until stopped typing, at most " : "";
    info(
      pending
        ? `[inbound] hold extended for ${who(conversationId)} (${why}): ${mode}${wait}ms${capped ? " (max hold)" : ""}, held ${now - started}ms so far, max ${cap}ms`
        : `[inbound] hold started for ${who(conversationId)} (${why}): ${mode}${wait}ms, max ${cap}ms`,
    );
    const timer = setTimeout(() => {
      if (timers.get(conversationId) !== timer) return;
      const held = Date.now() - started;
      clearHold(conversationId);
      info(
        capped
          ? `[inbound] max-hold flush for ${who(conversationId)} after ${held}ms`
          : typing
            ? `[inbound] typing-timeout flush for ${who(conversationId)} after ${held}ms (no "stopped typing" within ${typingIdleMs}ms)`
            : `[inbound] flush for ${who(conversationId)} after ${held}ms`,
      );
      flush(conversationId);
    }, wait);
    timer.unref?.();
    timers.set(conversationId, timer);
  }

  /** Hands a conversation's waiting texts to the agent; never throws. */
  function flush(conversationId: string): void {
    try {
      void drain(conversationId);
    } catch (err) {
      log.error(`[inbound] flush for a conversation failed`, err);
    }
  }

  function clearHold(conversationId: string): void {
    timers.delete(conversationId);
    holdStartedAt.delete(conversationId);
    typingNow.delete(conversationId);
    sawTyping.delete(conversationId);
    const waiters = holdWaiters.get(conversationId);
    holdWaiters.delete(conversationId);
    if (waiters) for (const resolve of waiters) resolve();
  }

  /** Resolves once the conversation has no open hold (right away if none). */
  function holdEnded(conversationId: string): Promise<void> {
    if (!timers.has(conversationId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = holdWaiters.get(conversationId) ?? [];
      list.push(resolve);
      holdWaiters.set(conversationId, list);
    });
  }

  function cancelQuietPeriod(conversationId: string): void {
    const pending = timers.get(conversationId);
    if (pending) clearTimeout(pending);
    clearHold(conversationId);
  }

  /** The conversation with an open hold that a typing signal is about, if any. */
  function heldConversation(conversationId: string): string | null {
    if (timers.has(conversationId)) return conversationId;
    const key = contactMatchKey(conversationId);
    for (const held of timers.keys()) {
      if (contactMatchKey(held) === key) return held;
    }
    return null;
  }

  async function claim(conversationId: string, maxConcurrent: number): Promise<InboundItem[]> {
    // Texts that piled up behind an answer go together, quiet period or not.
    // Only texts sent close together share a turn; the rest wait for the next.
    if (backlog.has(conversationId)) {
      const batch = await store.claimQueued(conversationId, { maxGapMs: queueBatchGapMs, maxConcurrent });
      if (batch.length === 0) {
        // Nothing left, or no free slot: only forget the backlog once it's empty.
        const state = await store.waiting(conversationId).catch(() => null);
        if (!state || state.queued.length === 0) backlog.delete(conversationId);
      }
      return batch;
    }
    if (debounceMs > 0) return store.claimQueued(conversationId, { maxConcurrent });
    const item = await store.claimNext(conversationId, { maxConcurrent });
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

  /**
   * Just before a reply is sent: if newer texts arrived while it was being
   * written, wait out their quiet period and claim them into this answer.
   * True = they're merged, hold the reply back. Never rejects.
   */
  async function mergeNewTexts(
    conversationId: string,
    mine: { batch: InboundItem[]; open: boolean; newTexts: boolean },
    redos: number,
  ): Promise<boolean> {
    if (!mine.open) return false;
    let merged: InboundItem[] = [];
    try {
      if (!mergeInFlight || !mine.newTexts || redos >= maxRedos || !isActive()) return false;
      // The sender may still be mid-burst: take the whole burst at once.
      await holdEnded(conversationId);
      mine.newTexts = false;
      merged = await store.claimQueued(conversationId, {
        maxConcurrent: await concurrencyLimit(),
        heldIds: mine.batch.map((claimed) => claimed._id),
      });
      if (merged.length === 0) return false;
      for (const claimed of merged) behindRun.delete(claimed.handle);
      mine.batch.push(...merged);
      info(
        `[inbound] holding back a reply for ${who(conversationId)}: ${merged.length} newer text(s) arrived; answering all ${mine.batch.length} together`,
      );
      return true;
    } catch (err) {
      log.warn(`[inbound] couldn't merge newer texts into a reply; sending it as is`, err);
      return false;
    } finally {
      if (merged.length === 0) {
        // The reply is going out: newer texts get their own answer now.
        mine.open = false;
        if (mine.newTexts) void drain(conversationId);
      }
    }
  }

  /** Answers one claimed batch in its own slot; never rejects. */
  async function runBatch(conversationId: string, batch: InboundItem[]): Promise<void> {
    const waitedBehindRun = batch.some((claimed) => behindRun.has(claimed.handle));
    for (const claimed of batch) behindRun.delete(claimed.handle);
    let item = combineInbound(batch, { waitedBehindRun });
    if (waitedBehindRun) info(`[inbound] answering ${batch.length} queued text(s) for ${who(conversationId)}`);
    const runs = answering.get(conversationId) ?? [];
    const mine = { item, batch, overlapped: runs.length > 0, open: true, newTexts: false };
    for (const other of runs) other.overlapped = true;
    runs.push(mine);
    answering.set(conversationId, runs);
    if (mine.overlapped) info(`[inbound] answering ${who(conversationId)} in parallel (${runs.length} running)`);
    const others = () => (answering.get(conversationId) ?? []).filter((r) => r !== mine);
    const held: HeldReply[] = [];
    const run: RunContext = {
      batch,
      waitedBehindRun,
      parallel: () => others().map((r) => r.item),
      claimedElsewhere: () => others().flatMap((r) => r.batch),
      overlapped: () => mine.overlapped,
      beforeSend: () => mergeNewTexts(conversationId, mine, held.length),
      held,
    };
    try {
      for (;;) {
        const answered = batch.length;
        const outcome = await process(item, run);
        if (!outcome?.held) break;
        // The reply was held back for newer texts: answer again with all of them.
        held.push({ reply: outcome.held.reply, attachments: outcome.held.attachments ?? [], answered });
        run.waitedBehindRun = false;
        mine.open = true;
        item = combineInbound(batch, { merged: true });
        mine.item = item;
      }
      for (const claimed of batch) await finish(claimed, "done");
    } catch (err) {
      log.error(`[inbound] answering ${item._id} failed`, err);
      const message = err instanceof Error ? err.message : String(err);
      for (const claimed of batch) await finish(claimed, "failed", message);
    } finally {
      mine.open = false;
      const left = (answering.get(conversationId) ?? []).filter((r) => r !== mine);
      if (left.length > 0) answering.set(conversationId, left);
      else answering.delete(conversationId);
    }
  }

  /** Resolves after the supervisor's next claim pass (or right away if none will run). */
  function afterNextClaim(conversationId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const list = claimWaiters.get(conversationId) ?? [];
      list.push(resolve);
      claimWaiters.set(conversationId, list);
    });
  }

  function releaseClaimWaiters(conversationId: string, waiters = claimWaiters.get(conversationId)): void {
    if (!waiters) return;
    if (waiters === claimWaiters.get(conversationId)) claimWaiters.delete(conversationId);
    for (const resolve of waiters) resolve();
  }

  /**
   * Fills a conversation's free slots, oldest text first, then waits for an
   * answer to finish (or a new text) and fills again, until nothing is
   * running and nothing more can be claimed.
   */
  async function loop(conversationId: string): Promise<void> {
    const running = new Set<Promise<void>>();
    try {
      for (;;) {
        again.delete(conversationId);
        // Only callers that arrived before this pass are told it's done.
        const waiters = claimWaiters.get(conversationId);
        claimWaiters.delete(conversationId);
        try {
          for (;;) {
            // Stop claiming new texts once this copy stands down; the active
            // copy picks up the rest.
            if (!isActive()) break;
            // The sender is still mid-burst; the quiet-period timer drains later.
            if (timers.has(conversationId)) break;
            // A reply still being written takes newer texts in before it's sent.
            if (mergeTarget(conversationId)) break;
            const maxConcurrent = await concurrencyLimit();
            if (running.size >= maxConcurrent) break;
            const batch = await claim(conversationId, maxConcurrent);
            if (batch.length === 0) break;
            const task: Promise<void> = runBatch(conversationId, batch).finally(() => running.delete(task));
            running.add(task);
          }
        } finally {
          if (waiters) for (const resolve of waiters) resolve();
        }
        if (again.has(conversationId)) continue;
        if (running.size === 0) return;
        // A slot frees when an answer finishes; a new text may find one free now.
        await new Promise<void>((resolve) => {
          wakers.set(conversationId, resolve);
          void Promise.race(running).then(resolve);
        });
        wakers.delete(conversationId);
      }
    } catch (err) {
      // Answers already running finish on their own; wait for them before
      // this supervisor reports the failure, so a retry doesn't double up.
      await Promise.allSettled([...running]);
      throw err;
    } finally {
      wakers.delete(conversationId);
    }
  }

  function drain(conversationId: string): Promise<void> {
    if (!isActive()) return Promise.resolve();
    const running = draining.get(conversationId);
    if (running) {
      again.add(conversationId);
      wakers.get(conversationId)?.();
      return running;
    }
    const run = loop(conversationId)
      .then(() => void flushRetries.delete(conversationId))
      .catch((err) => {
        log.error(`[inbound] queue for a conversation stopped`, err);
        // Usually the store was unreachable; the texts are still queued, so
        // try again shortly instead of waiting for the poller's safety net.
        const tries = (flushRetries.get(conversationId) ?? 0) + 1;
        if (tries > FLUSH_RETRY_LIMIT) {
          flushRetries.delete(conversationId);
          return;
        }
        flushRetries.set(conversationId, tries);
        const retry = setTimeout(() => void drain(conversationId), retryDelayMs * tries);
        retry.unref?.();
      })
      .finally(() => {
        draining.delete(conversationId);
        releaseClaimWaiters(conversationId);
        // A text that arrived after the loop's last check but before this
        // point would otherwise wait for the next poll.
        if (again.delete(conversationId)) void drain(conversationId);
      });
    draining.set(conversationId, run);
    return run;
  }

  async function sendAck(target: AckTarget, text: string): Promise<void> {
    if (!deps.acknowledge) return;
    try {
      await deps.acknowledge(target, text);
      info(`[inbound] ack sent to ${who(target.conversationId)}: ${JSON.stringify(text)}`);
    } catch (err) {
      log.warn(`[inbound] couldn't send a queued ack`, err);
    }
  }

  /** Sends the conversation's waiting ack, if its texts are still waiting behind an answer. */
  async function flushAck(conversationId: string): Promise<void> {
    const pending = pendingAcks.get(conversationId);
    if (!pending) return;
    pendingAcks.delete(conversationId);
    clearTimeout(pending.timer);
    try {
      if (!isActive()) return;
      const [state, maxConcurrent] = await Promise.all([store.waiting(conversationId), concurrencyLimit()]);
      const merging = mergeTarget(conversationId);
      // A slot freed in the meantime: the text is (about to be) answered.
      if (!merging && Math.max(answeringCount(conversationId), state.processing) < maxConcurrent) return;
      const positions = state.queued.flatMap((row, i) => (pending.handles.has(row.handle) ? [i + 1] : []));
      if (positions.length === 0) return;
      await sendAck(pending.target, merging ? mergeAckText(positions.length) : queuedAckText(positions));
    } catch (err) {
      log.warn(`[inbound] couldn't check the queue for an ack`, err);
    }
  }

  /**
   * After a text is saved: if every answer slot in its conversation is busy,
   * remember it waited (so it's batched and numbered next), then either
   * schedule the "queued" ack or, for a bare "never mind", drop the texts
   * waiting before it. A text with a free slot is simply answered. Never throws.
   */
  async function noteIfBehindRun(input: InboundInput): Promise<void> {
    const { conversationId } = input;
    try {
      if (!isActive()) return;
      const [state, maxConcurrent] = await Promise.all([store.waiting(conversationId), concurrencyLimit()]);
      const merging = mergeTarget(conversationId);
      if (!merging && Math.max(answeringCount(conversationId), state.processing) < maxConcurrent) return;
      const index = state.queued.findIndex((row) => row.handle === input.handle);
      // Already claimed: it's being answered, not waiting.
      if (index < 0) return;
      behindRun.add(input.handle);
      backlog.add(conversationId);
      const target = { conversationId, fromNumber: input.fromNumber };

      if (isCancelRequest(input.content) && input.mediaUrls.length === 0 && index > 0) {
        const earlier = state.queued.slice(0, index);
        const dropped = await store.cancel(
          earlier.map((row) => row._id),
          "Cancelled by a later \"never mind\" while Boop was busy.",
        );
        if (dropped > 0) {
          // The "never mind" itself has nothing left to answer.
          await store.cancel([state.queued[index]._id], "A \"never mind\" that dropped the queued texts before it.");
          for (const row of [...earlier, state.queued[index]]) behindRun.delete(row.handle);
          const pending = pendingAcks.get(conversationId);
          if (pending) {
            for (const row of earlier) pending.handles.delete(row.handle);
            if (pending.handles.size === 0) {
              clearTimeout(pending.timer);
              pendingAcks.delete(conversationId);
            }
          }
          info(`[inbound] "never mind" from ${who(conversationId)} dropped ${dropped} queued text(s)`);
          await sendAck(target, cancelAckText(dropped));
          return;
        }
      }

      if (!deps.acknowledge) return;
      const pending = pendingAcks.get(conversationId);
      if (pending) {
        pending.handles.add(input.handle);
        return;
      }
      const timer = setTimeout(() => void flushAck(conversationId), ackDelayMs);
      timer.unref?.();
      pendingAcks.set(conversationId, { target, handles: new Set([input.handle]), timer });
    } catch (err) {
      log.warn(`[inbound] couldn't check whether a text is queued behind an answer`, err);
    }
  }

  /** A new text was saved: replies still being written check for it before sending. */
  function noteNewText(conversationId: string): void {
    if (!mergeInFlight) return;
    for (const r of answering.get(conversationId) ?? []) if (r.open) r.newTexts = true;
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
        if (enqueued) {
          noteNewText(conversationId);
          // Let the queue try a free slot first, so a text that starts its
          // own answer isn't mistaken for one waiting behind the others.
          const claimed = isActive() ? afterNextClaim(conversationId) : Promise.resolve();
          void drain(conversationId);
          await claimed;
          await noteIfBehindRun(input);
        }
        return enqueued;
      }
      // Open (or restart) the quiet period before saving, so a drain already
      // in flight can't claim this text and answer it before the burst ends.
      const wasWaiting = timers.has(conversationId);
      // Sending a text ends the typing bubble; if they keep typing, Sendblue
      // sends a fresh "started typing".
      typingNow.delete(conversationId);
      startQuietPeriod(conversationId, "text");
      const timer = timers.get(conversationId);
      let enqueued = false;
      try {
        enqueued = await store.enqueue(input);
        if (enqueued) noteNewText(conversationId);
        // A slow save can outlast the hold: its timer already fired and
        // drained before this text existed, so answer it now.
        if (enqueued && !timers.has(conversationId)) flush(conversationId);
        if (enqueued) await noteIfBehindRun(input);
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
      const signal = isTyping ? "started typing" : "stopped typing";
      const ignore = (why: string): TypingOutcome => {
        info(`[inbound] typing signal for ${who(conversationId)} (${signal}) ignored: ${why}`);
        return "ignored";
      };
      try {
        if (debounceMs <= 0) return ignore("quiet period is off");
        if (maxTypingWaitMs <= 0) return ignore("typing hold is off");
        // Typing only matters while texts are waiting to be answered; that also
        // drops signals from numbers that never texted (or were already answered).
        const held = heldConversation(conversationId);
        if (!held) return ignore("no text waiting from this number");
        // SMS/RCS keep the plain quiet period.
        if (noTyping.has(held)) return ignore("latest text came over SMS/RCS");
        sawTyping.add(held);
        // "Started" holds until "stopped" (or typingIdleMs); "stopped" leaves
        // one quiet period. Both are capped by the hold's hard deadline.
        if (isTyping) typingNow.add(held);
        else typingNow.delete(held);
        startQuietPeriod(held, signal);
        return isTyping ? "held" : "restarted";
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
      // Replies waiting on a hold go out as they are.
      for (const waiters of holdWaiters.values()) for (const resolve of waiters) resolve();
      holdWaiters.clear();
      holdStartedAt.clear();
      typingNow.clear();
      sawTyping.clear();
      flushRetries.clear();
      noTyping.clear();
      // Unsent acks are dropped; the texts themselves stay queued.
      for (const pending of pendingAcks.values()) clearTimeout(pending.timer);
      pendingAcks.clear();
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
  // A real text that happens to carry is_typing must still be queued, never
  // swallowed as a typing hint.
  if (str(body.content) || str(body.message_handle) || extractSendblueMediaUrls(body.media_url, body.media_urls).length > 0) {
    return null;
  }
  const number = str(body.number);
  if (!number) return null;
  return { conversationId: `sms:${number}`, isTyping: body.is_typing };
}
