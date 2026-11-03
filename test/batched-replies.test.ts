import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  combineInbound,
  createInboundQueue,
  queuedBatchHeader,
  type InboundItem,
  type RunContext,
} from "../server/inbound-queue.js";
import { burstNote, messageLabel, parallelTurnsNote, turnPrompt } from "../server/parallel-turns.js";
import { memoryInboundStore, text } from "./memory-inbound-store.js";

const quiet = { error: () => undefined, warn: () => undefined };
const settle = () => vi.advanceTimersByTimeAsync(0);

const item = (id: string, content: string, mediaUrls: string[] = []): InboundItem => ({
  ...text("a", content, id, mediaUrls),
  _id: id,
  attempts: 1,
});

/** Builds the prompt the way the turn does, from what the queue hands it. */
function promptFor(combined: InboundItem, run: RunContext, history = ""): string {
  return turnPrompt({
    history,
    parallelNote: parallelTurnsNote(run.claimedElsewhere().map(messageLabel)),
    batchNote: burstNote(run.waitedBehindRun ? 1 : run.batch.length),
    message: combined.content,
  });
}

/** A processor whose answers finish only when the test says so. */
function gated() {
  const calls: Array<{ item: InboundItem; run: RunContext; prompt: string }> = [];
  const gates = new Map<string, () => void>();
  return {
    calls,
    process: (combined: InboundItem, run: RunContext) =>
      new Promise<void>((resolve) => {
        calls.push({ item: combined, run, prompt: promptFor(combined, run) });
        gates.set(combined.content, resolve);
      }),
    finish: (content: string) => gates.get(content)!(),
  };
}

describe("one combined reply for texts that waited behind a busy slot", () => {
  it("numbers them oldest first under a header asking for one combined reply", () => {
    const combined = combineInbound(
      [item("1", "book a table for 4"), item("2", "", ["https://cdn.example/x.png"]), item("3", "make it 5 people")],
      { waitedBehindRun: true },
    );
    const lines = combined.content.split("\n");
    expect(lines[0]).toBe(queuedBatchHeader(3));
    expect(lines.slice(1)).toEqual(["1. book a table for 4", "2. (no text) [1 image attached]", "3. make it 5 people"]);

    const header = lines[0];
    expect(header).toContain("3 messages sent while you were busy");
    expect(header).toContain("same person in this same conversation");
    expect(header).toContain("numbered oldest first");
    expect(header).toContain("Write ONE combined reply that addresses all 3 in order");
    expect(header).toContain("merge overlapping or duplicate asks");
    expect(header).toContain("don't answer each one as a separate standalone message");
    expect(header).toContain("don't repeat yourself");
    expect(header).toContain("go with the later one");
  });

  it("puts the numbered batch in the prompt without the burst note", () => {
    const batch = [item("1", "one"), item("2", "two")];
    const combined = combineInbound(batch, { waitedBehindRun: true });
    const run: RunContext = {
      batch,
      waitedBehindRun: true,
      parallel: () => [],
      claimedElsewhere: () => [],
      overlapped: () => false,
    };
    const prompt = promptFor(combined, run, "USER: earlier\nASSISTANT: earlier reply");
    expect(prompt).toBe(
      `Prior turns:\nUSER: earlier\nASSISTANT: earlier reply\n\nCurrent message:\n${queuedBatchHeader(2)}\n1. one\n2. two`,
    );
  });
});

describe("many texts sent in a row", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says nothing extra for a single text", () => {
    expect(burstNote(1)).toBe("");
    expect(turnPrompt({ history: "", parallelNote: "", batchNote: "", message: "hi" })).toBe("hi");
  });

  it("answers a burst as one thread of intent where later corrections win", async () => {
    const { store } = memoryInboundStore();
    const worker = gated();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, debounceMs: 5_000 });

    const burst = ["remind me to call mom", "at 6pm", "actually make it 7pm", "and also buy milk", "at 6pm"];
    for (const [i, content] of burst.entries()) {
      await queue.enqueue(text("a", content, `burst-${i}`));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    // One turn for the whole burst, oldest first, as one message.
    expect(worker.calls).toHaveLength(1);
    const [{ item: combined, run, prompt }] = worker.calls;
    expect(run.waitedBehindRun).toBe(false);
    expect(run.batch).toHaveLength(5);
    expect(combined.content).toBe("remind me to call mom\nat 6pm\nactually make it 7pm\nand also buy milk\nat 6pm");

    const note = burstNote(5);
    expect(note).toContain("5 texts the same person sent in a row");
    expect(note).toContain("joined oldest first");
    expect(note).toContain("one thread of intent");
    expect(note).toContain("a later text that corrects, narrows or overrides an earlier one wins");
    expect(note).toContain("overlapping or repeated asks are one ask");
    expect(note).toContain("Send one coherent reply");
    expect(prompt).toBe(`${note}\n\nCurrent message:\n${combined.content}`);
    worker.finish(combined.content);
  });
});

describe("replies stay matched to their own messages with 2 runs at once", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a run only answers what it claimed and is told what the other run claimed", async () => {
    const { store, rows } = memoryInboundStore();
    const worker = gated();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, maxConcurrentRuns: 2 });

    await queue.enqueue(text("a", "A: plan my trip"));
    await settle();
    await queue.enqueue(text("a", "B: what time is it in Tokyo"));
    await settle();
    // Both slots busy: these wait and go together, numbered, into the next free slot.
    await queue.enqueue(text("a", "C: also book the hotel"));
    await queue.enqueue(text("a", "D: a cheap one"));
    await settle();
    expect(worker.calls.map((c) => c.run.batch.map((i) => i.content))).toEqual([
      ["A: plan my trip"],
      ["B: what time is it in Tokyo"],
    ]);

    // B was told A is claimed by another run, and answers only B.
    const b = worker.calls[1];
    expect(b.prompt).toContain('- "A: plan my trip"');
    expect(b.prompt).toContain("already claimed these messages");
    expect(b.prompt).toMatch(/Current message:\nB: what time is it in Tokyo$/);

    worker.finish("B: what time is it in Tokyo");
    await settle();
    expect(worker.calls).toHaveLength(3);
    const batch = worker.calls[2];
    // The batch covers exactly C and D: not A (still running elsewhere), not B (answered).
    expect(batch.run.batch.map((i) => i.content)).toEqual(["C: also book the hotel", "D: a cheap one"]);
    expect(batch.run.waitedBehindRun).toBe(true);
    expect(batch.run.claimedElsewhere().map((i) => i.content)).toEqual(["A: plan my trip"]);
    expect(batch.prompt).toContain('- "A: plan my trip"');
    expect(batch.prompt).not.toContain("B: what time");
    expect(batch.prompt).toContain(
      `Current message:\n${queuedBatchHeader(2)}\n1. C: also book the hotel\n2. D: a cheap one`,
    );
    // Not a burst: the numbered header is the only batch instruction.
    expect(batch.prompt).not.toContain("in a row");

    worker.finish("A: plan my trip");
    worker.finish(batch.item.content);
    await queue.drain("sms:a");
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("names the other run's texts as sent, not its combined numbered header", async () => {
    const { store } = memoryInboundStore();
    const worker = gated();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, maxConcurrentRuns: 2 });

    await queue.enqueue(text("a", "one"));
    await queue.enqueue(text("a", "two"));
    await queue.enqueue(text("a", "three"));
    await queue.enqueue(text("a", "", "img", ["https://cdn.example/x.png"]));
    await settle();
    worker.finish("two");
    await settle();
    const batch = worker.calls[2];
    expect(batch.run.batch.map((i) => i._id)).toHaveLength(2);

    // "one" is still running: it sees the batch's texts one by one, as sent.
    const one = worker.calls[0];
    expect(one.run.claimedElsewhere().map(messageLabel)).toEqual(["three", "(an image)"]);
    const note = parallelTurnsNote(one.run.claimedElsewhere().map(messageLabel));
    expect(note).toContain('- "three"\n- "(an image)"');
    expect(note).not.toContain("sent while you were busy");
    // And the batch is told "one" is taken, not "two" (already answered).
    expect(batch.run.claimedElsewhere().map((i) => i.content)).toEqual(["one"]);
    worker.finish("one");
    worker.finish(batch.item.content);
    await queue.drain("sms:a");
  });
});
