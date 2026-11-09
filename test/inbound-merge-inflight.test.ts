import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  combineInbound,
  createInboundQueue,
  maxHoldMsFromEnv,
  mergeAckText,
  mergedBatchHeader,
  mergeInFlightFromEnv,
  type AckTarget,
  type InboundItem,
  type ProcessOutcome,
  type RunContext,
} from "../server/inbound-queue.js";
import { heldReplyNote, turnPrompt } from "../server/parallel-turns.js";
import { memoryInboundStore, text } from "./memory-inbound-store.js";

const quiet = { error: () => undefined, warn: () => undefined };
const settle = () => vi.advanceTimersByTimeAsync(0);

/**
 * A processor shaped like processInboundText: it "writes" a reply when the
 * test releases it, asks beforeSend(), and either holds the draft back or
 * "sends" it. Every call is one model turn.
 */
function replyingProcessor() {
  const turns: Array<{ content: string; held: number; run: RunContext }> = [];
  const sent: string[] = [];
  const gates: Array<() => void> = [];
  return {
    turns,
    sent,
    process: async (item: InboundItem, run: RunContext): Promise<void | ProcessOutcome> => {
      turns.push({ content: item.content, held: run.held.length, run });
      await new Promise<void>((resolve) => gates.push(resolve));
      const reply = `reply to: ${item.content}`;
      if (await run.beforeSend()) return { held: { reply, attachments: [`img-${turns.length}`] } };
      sent.push(reply);
    },
    /** Lets the oldest turn still writing finish its reply. */
    release: () => gates.shift()!(),
    get writing() {
      return gates.length;
    },
  };
}

function setup(
  opts: { debounceMs?: number; maxHoldMs?: number; maxConcurrentRuns?: number; maxRedos?: number; merge?: boolean } = {},
) {
  const memory = memoryInboundStore();
  const worker = replyingProcessor();
  const acks: Array<AckTarget & { text: string }> = [];
  const queue = createInboundQueue({
    store: memory.store,
    process: worker.process,
    log: quiet,
    ackDelayMs: 2_000,
    debounceMs: opts.debounceMs ?? 0,
    maxHoldMs: opts.maxHoldMs,
    maxConcurrentRuns: opts.maxConcurrentRuns ?? 2,
    mergeInFlight: opts.merge ?? true,
    maxRedos: opts.maxRedos,
    acknowledge: async (target, message) => void acks.push({ ...target, text: message }),
  });
  const status = (content: string) => memory.rows.find((r) => r.content === content)?.status;
  return { ...memory, worker, acks, queue, status };
}

describe("rapid-fire bursts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("answers a single text once, after the quiet period, with no hold-back", async () => {
    const { queue, worker, status } = setup({ debounceMs: 3_000 });
    await queue.enqueue(text("a", "hi"));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(worker.turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.turns.map((t) => t.content)).toEqual(["hi"]);
    worker.release();
    await settle();
    expect(worker.sent).toEqual(["reply to: hi"]);
    expect(worker.turns).toHaveLength(1);
    expect(status("hi")).toBe("done");
  });

  it("bundles texts sent within the window into one request, oldest first", async () => {
    const { queue, worker } = setup({ debounceMs: 3_000 });
    await queue.enqueue(text("a", "book a table"));
    await vi.advanceTimersByTimeAsync(1_000);
    await queue.enqueue(text("a", "for 4 people"));
    await vi.advanceTimersByTimeAsync(2_000);
    await queue.enqueue(text("a", "actually make it 5"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.turns.map((t) => t.content)).toEqual(["book a table\nfor 4 people\nactually make it 5"]);
    expect(worker.turns[0].run.batch).toHaveLength(3);
  });

  it("extends the window per text, but never past the configured max hold", async () => {
    const { queue, worker } = setup({ debounceMs: 3_000, maxHoldMs: 8_000 });
    for (let i = 1; i <= 5; i++) {
      await queue.enqueue(text("a", `t${i}`));
      if (i < 5) await vi.advanceTimersByTimeAsync(2_500);
    }
    // First text at 0, last at 10s: the 8s cap flushed whatever had arrived.
    expect(worker.turns[0]?.content).toBe("t1\nt2\nt3\nt4");
  });

  it("reads the max hold and merge switch from the environment", () => {
    expect(maxHoldMsFromEnv(undefined)).toBe(15_000);
    expect(maxHoldMsFromEnv("8000")).toBe(8_000);
    expect(maxHoldMsFromEnv("999999")).toBe(120_000);
    expect(maxHoldMsFromEnv("nope")).toBe(15_000);
    expect(mergeInFlightFromEnv(undefined)).toBe(true);
    expect(mergeInFlightFromEnv("false")).toBe(false);
    expect(mergeInFlightFromEnv("0")).toBe(false);
    expect(mergeInFlightFromEnv("true")).toBe(true);
  });
});

describe("texts that arrive while a reply is being written", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds the reply back and answers every text together, numbered oldest first", async () => {
    const { queue, worker, status } = setup();
    await queue.enqueue(text("a", "what's the weather in Paris"));
    await settle();
    expect(worker.writing).toBe(1);

    // Mid-generation: no second answer starts, even with a free slot.
    await queue.enqueue(text("a", "and Lyon"));
    await settle();
    expect(worker.turns).toHaveLength(1);

    worker.release();
    await settle();
    // The first draft was never sent; one redo covers both texts.
    expect(worker.sent).toEqual([]);
    expect(worker.turns).toHaveLength(2);
    const redo = worker.turns[1];
    expect(redo.content).toContain(mergedBatchHeader(2));
    expect(redo.content).toContain("1. what's the weather in Paris\n2. and Lyon");
    expect(redo.held).toBe(1);
    expect(redo.run.held[0]).toMatchObject({ reply: "reply to: what's the weather in Paris", answered: 1 });

    worker.release();
    await settle();
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0]).toContain("1. what's the weather in Paris");
    expect(status("what's the weather in Paris")).toBe("done");
    expect(status("and Lyon")).toBe("done");
  });

  it("waits out the new texts' quiet period before redoing, so a burst lands in one redo", async () => {
    const { queue, worker } = setup({ debounceMs: 3_000 });
    await queue.enqueue(text("a", "one"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.turns).toHaveLength(1);

    await queue.enqueue(text("a", "two"));
    worker.release(); // the reply is written while "two" is still in its window
    await vi.advanceTimersByTimeAsync(1_000);
    await queue.enqueue(text("a", "three"));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(worker.turns).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(worker.turns).toHaveLength(2);
    expect(worker.turns[1].content).toContain("1. one\n2. two\n3. three");
    worker.release();
    await settle();
    expect(worker.sent).toHaveLength(1);
  });

  it("folds texts sent during a long sub-agent run into its reply and acks them once", async () => {
    const { queue, worker, acks, status } = setup();
    await queue.enqueue(text("a", "research flights to Tokyo"));
    await settle();
    // The sub-agent runs for a while; two follow-ups arrive.
    await vi.advanceTimersByTimeAsync(30_000);
    await queue.enqueue(text("a", "only direct ones"));
    await queue.enqueue(text("a", "never mind the direct part, any is fine"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(acks.map((a) => a.text)).toEqual([mergeAckText(2)]);
    expect(worker.turns).toHaveLength(1);

    worker.release();
    await settle();
    const redo = worker.turns[1];
    expect(redo.content).toContain(
      "1. research flights to Tokyo\n2. only direct ones\n3. never mind the direct part, any is fine",
    );
    worker.release();
    await settle();
    expect(worker.sent).toHaveLength(1);
    for (const c of ["research flights to Tokyo", "only direct ones", "never mind the direct part, any is fine"]) {
      expect(status(c)).toBe("done");
    }
    expect(acks).toHaveLength(1);
  });

  it("merges a text that arrives during the redo too, up to maxRedos, then sends", async () => {
    const { queue, worker } = setup({ maxRedos: 1 });
    await queue.enqueue(text("a", "one"));
    await settle();
    await queue.enqueue(text("a", "two"));
    worker.release();
    await settle();
    expect(worker.turns).toHaveLength(2);

    // Arrives during the (only allowed) redo: the redo is sent anyway and
    // "three" gets its own answer afterwards. Nothing is lost.
    await queue.enqueue(text("a", "three"));
    await settle();
    worker.release();
    await settle();
    expect(worker.sent).toHaveLength(1);
    expect(worker.turns).toHaveLength(3);
    expect(worker.turns[2].content).toBe("three");
    worker.release();
    await settle();
    expect(worker.sent).toHaveLength(2);
  });

  it("answers a text separately once the earlier reply is already on its way", async () => {
    const memory = memoryInboundStore();
    const sent: string[] = [];
    let releaseSend!: () => void;
    const queue = createInboundQueue({
      store: memory.store,
      log: quiet,
      maxConcurrentRuns: 2,
      mergeInFlight: true,
      process: async (item, run) => {
        if (await run.beforeSend()) return { held: { reply: item.content } };
        if (item.content === "first") await new Promise<void>((r) => (releaseSend = r)); // sending…
        sent.push(item.content);
      },
    });
    await queue.enqueue(text("a", "first"));
    await settle();
    await queue.enqueue(text("a", "second"));
    await settle();
    // "first" was committed before "second" arrived, so "second" gets its own answer.
    expect(sent).toEqual(["second"]);
    releaseSend();
    await settle();
    expect(sent).toEqual(["second", "first"]);
  });

  it("never answers a merged text twice, and doesn't merge texts another answer claimed", async () => {
    const { queue, worker, rows } = setup({ maxConcurrentRuns: 3 });
    await queue.enqueue(text("a", "one"));
    await settle();
    await queue.enqueue(text("a", "two"));
    await queue.enqueue(text("a", "two", "h-a-two")); // the same text delivered twice
    await settle();
    worker.release();
    await settle();
    worker.release();
    await settle();
    expect(worker.turns).toHaveLength(2);
    expect(worker.sent).toHaveLength(1);
    expect(rows.filter((r) => r.content === "two")).toHaveLength(1);
    expect(rows.every((r) => r.status === "done")).toBe(true);
  });

  it("sends the reply as is when merging fails", async () => {
    const memory = memoryInboundStore();
    const sent: string[] = [];
    let release!: () => void;
    const claimQueued = memory.store.claimQueued.bind(memory.store);
    memory.store.claimQueued = async (id, opts) => {
      if (opts?.heldIds) throw new Error("store down");
      return claimQueued(id, opts);
    };
    const queue = createInboundQueue({
      store: memory.store,
      log: quiet,
      maxConcurrentRuns: 2,
      mergeInFlight: true,
      process: async (item, run) => {
        if (item.content === "one") await new Promise<void>((r) => (release = r));
        if (await run.beforeSend()) return { held: { reply: item.content } };
        sent.push(item.content);
      },
    });
    await queue.enqueue(text("a", "one"));
    await settle();
    await queue.enqueue(text("a", "two"));
    await settle();
    release();
    await settle();
    expect(sent).toEqual(["one", "two"]);
  });

  it("keeps the old parallel behaviour with merging off", async () => {
    const { queue, worker } = setup({ merge: false });
    await queue.enqueue(text("a", "one"));
    await settle();
    await queue.enqueue(text("a", "two"));
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["one", "two"]);
  });
});

describe("prompt for a redone reply", () => {
  it("numbers the merged texts under a header that says the first reply was never sent", () => {
    const items = ["a", "b"].map((c, i) => ({ ...text("x", c), _id: `r${i}`, attempts: 1 }));
    const merged = combineInbound(items, { merged: true });
    expect(merged.content.split("\n")[0]).toBe(mergedBatchHeader(2));
    expect(mergedBatchHeader(2)).toMatch(/held back and never sent/);
    expect(mergedBatchHeader(2)).toMatch(/later one/);
  });

  it("passes the held draft along so finished work and sent acks aren't repeated", () => {
    expect(heldReplyNote([])).toBe("");
    const note = heldReplyNote([{ reply: "Found 3 flights: …", answered: 1 }]);
    expect(note).toContain("Draft that answered message 1 (NOT sent):\nFound 3 flights: …");
    expect(note).toMatch(/Don't redo that work or spawn the same task again/);
    expect(note).toMatch(/Don't repeat an ack/);
    const prompt = turnPrompt({ history: "", parallelNote: "", batchNote: "", heldNote: note, message: "1. x\n2. y" });
    expect(prompt.indexOf(note)).toBeLessThan(prompt.indexOf("Current message:"));
    expect(turnPrompt({ history: "", parallelNote: "", batchNote: "", message: "hi" })).toBe("hi");
  });
});
