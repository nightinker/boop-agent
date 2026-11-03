import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ackDelayMsFromEnv,
  cancelAckText,
  createInboundQueue,
  isCancelRequest,
  queuedAckText,
  type AckTarget,
  type InboundItem,
} from "../server/inbound-queue.js";
import { formatQueueOverview } from "../server/queue-status.js";
import { memoryInboundStore, text } from "./memory-inbound-store.js";

const quiet = { error: () => undefined, warn: () => undefined };
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A processor whose answers finish only when the test says so. */
function gatedProcessor() {
  const turns: InboundItem[] = [];
  const gates: Array<() => void> = [];
  return {
    turns,
    process: (item: InboundItem) =>
      new Promise<void>((resolve) => {
        turns.push(item);
        gates.push(resolve);
      }),
    /** Finishes the oldest answer still running. */
    finishCurrent: () => gates.shift()!(),
  };
}

function setup(opts: { ackDelayMs?: number; debounceMs?: number; isActive?: () => boolean } = {}) {
  const memory = memoryInboundStore();
  const worker = gatedProcessor();
  const acks: Array<AckTarget & { text: string }> = [];
  const queue = createInboundQueue({
    store: memory.store,
    process: worker.process,
    log: quiet,
    ackDelayMs: opts.ackDelayMs ?? 2_000,
    debounceMs: opts.debounceMs ?? 0,
    isActive: opts.isActive,
    acknowledge: async (target, message) => void acks.push({ ...target, text: message }),
  });
  return { ...memory, worker, acks, queue };
}

describe("texts that arrive while Boop is busy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("acks a text queued behind a running answer with its position", async () => {
    const { queue, worker, acks, rows } = setup();
    await queue.enqueue(text("a", "start the long task"));
    await settle();
    expect(worker.turns).toHaveLength(1);

    await queue.enqueue(text("a", "also add captions"));
    expect(rows.find((r) => r.content === "also add captions")?.status).toBe("queued");
    expect(acks).toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(acks).toEqual([
      { conversationId: "sms:a", fromNumber: "a", text: "Got it, queued behind the current task (position 1)." },
    ]);
  });

  it("sends one ack for texts sent together, and the next ack counts on", async () => {
    const { queue, acks } = setup();
    await queue.enqueue(text("a", "long task"));
    await settle();

    await queue.enqueue(text("a", "one"));
    await vi.advanceTimersByTimeAsync(500);
    await queue.enqueue(text("a", "two"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(acks.map((a) => a.text)).toEqual(["Got it, 2 messages queued behind the current task (positions 1–2)."]);

    await queue.enqueue(text("a", "three"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(acks.map((a) => a.text)[1]).toBe("Got it, queued behind the current task (position 3).");
  });

  it("doesn't ack a text when nothing is being answered", async () => {
    const { queue, worker, acks } = setup();
    await queue.enqueue(text("a", "hi"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.turns.map((t) => t.content)).toEqual(["hi"]);
    expect(acks).toEqual([]);
  });

  it("skips the ack when the answer finishes before the delay", async () => {
    const { queue, worker, acks } = setup();
    await queue.enqueue(text("a", "quick question"));
    await settle();
    await queue.enqueue(text("a", "follow-up"));
    worker.finishCurrent();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(worker.turns.map((t) => t.content)).toEqual(["quick question", "follow-up"]);
    expect(acks).toEqual([]);
  });

  it("answers what waited right after the answer finishes, in order, with each text's images", async () => {
    const { queue, worker, rows } = setup();
    await queue.enqueue(text("a", "build it"));
    await settle();
    await queue.enqueue(text("a", "first thought"));
    await queue.enqueue(text("a", "", "h-img", ["https://cdn.example/a.png", "https://cdn.example/b.png"]));
    await queue.enqueue(text("a", "last thought", "h-last", ["https://cdn.example/c.png"]));

    worker.finishCurrent();
    await settle();
    expect(worker.turns).toHaveLength(2);
    const batch = worker.turns[1];
    expect(batch.content.split("\n").slice(1)).toEqual([
      "1. first thought",
      "2. (no text) [2 images attached]",
      "3. last thought [1 image attached]",
    ]);
    expect(batch.mediaUrls).toEqual([
      "https://cdn.example/a.png",
      "https://cdn.example/b.png",
      "https://cdn.example/c.png",
    ]);

    worker.finishCurrent();
    await queue.drain("sms:a");
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("answers queued texts sent far apart as separate turns, oldest first", async () => {
    const { queue, worker } = setup();
    const now = Date.now();
    await queue.enqueue(text("a", "big task"));
    await settle();
    await queue.enqueue({ ...text("a", "early a"), receivedAt: now });
    await queue.enqueue({ ...text("a", "early b"), receivedAt: now + 30_000 });
    await queue.enqueue({ ...text("a", "much later"), receivedAt: now + 30 * 60_000 });

    worker.finishCurrent();
    await settle();
    expect(worker.turns[1].content).toContain("1. early a\n2. early b");
    expect(worker.turns[1].content).not.toContain("much later");
    worker.finishCurrent();
    await settle();
    expect(worker.turns[2].content).toBe("much later");
    worker.finishCurrent();
    await queue.drain("sms:a");
    expect(worker.turns).toHaveLength(3);
  });

  it("queues and acks a text delivered twice only once", async () => {
    const { queue, worker, acks, rows } = setup();
    await queue.enqueue(text("a", "task"));
    await settle();
    expect(await queue.enqueue(text("a", "dup", "same"))).toBe(true);
    expect(await queue.enqueue({ ...text("a", "dup", "same"), source: "poll" })).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rows.filter((r) => r.handle === "same")).toHaveLength(1);
    expect(acks.map((a) => a.text)).toEqual(["Got it, queued behind the current task (position 1)."]);

    worker.finishCurrent();
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["task", "dup"]);
    worker.finishCurrent();
  });

  it("a bare 'never mind' drops the texts waiting before it", async () => {
    const { queue, worker, acks, rows } = setup();
    await queue.enqueue(text("a", "task"));
    await settle();
    await queue.enqueue(text("a", "do x"));
    await queue.enqueue(text("a", "and y"));
    await queue.enqueue(text("a", "Never mind!"));

    expect(acks.map((a) => a.text)).toEqual([cancelAckText(2)]);
    expect(rows.slice(1).map((r) => r.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    // The pending "queued" ack for the dropped texts is never sent.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(acks).toHaveLength(1);

    worker.finishCurrent();
    await queue.drain("sms:a");
    expect(worker.turns.map((t) => t.content)).toEqual(["task"]);
  });

  it("a 'never mind' with nothing waiting is queued and answered like any text", async () => {
    const { queue, worker, acks } = setup();
    await queue.enqueue(text("a", "task"));
    await settle();
    await queue.enqueue(text("a", "nvm"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(acks.map((a) => a.text)).toEqual(["Got it, queued behind the current task (position 1)."]);
    worker.finishCurrent();
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["task", "nvm"]);
    worker.finishCurrent();
  });

  it("keeps queued texts across a restart and answers them after recovery", async () => {
    const { store, rows, queue, worker } = setup();
    await queue.enqueue(text("a", "task"));
    await settle();
    await queue.enqueue(text("a", "queued one"));
    queue.stop(); // the process dies mid-answer

    const after = gatedProcessor();
    const restarted = createInboundQueue({ store, process: after.process, log: quiet });
    expect(await restarted.recover()).toEqual({ requeued: 1, failed: 0 });
    await settle();
    expect(after.turns[0].content).toBe("task");
    after.finishCurrent();
    await settle();
    expect(after.turns[1].content).toBe("queued one");
    after.finishCurrent();
    await restarted.drain("sms:a");
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
    expect(worker.turns).toHaveLength(1);
  });

  it("a standby copy saves texts but doesn't ack them", async () => {
    let active = true;
    const { queue, acks, rows } = setup({ isActive: () => active });
    await queue.enqueue(text("a", "task"));
    await settle();
    active = false;
    await queue.enqueue(text("a", "while standing by"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rows).toHaveLength(2);
    expect(acks).toEqual([]);
  });

  it("acks and batches with the quiet period on too", async () => {
    const { queue, worker, acks } = setup({ debounceMs: 5_000 });
    await queue.enqueue(text("a", "task"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.turns).toHaveLength(1);

    await queue.enqueue(text("a", "q1"));
    await queue.enqueue(text("a", "q2"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(acks.map((a) => a.text)).toEqual(["Got it, 2 messages queued behind the current task (positions 1–2)."]);

    await vi.advanceTimersByTimeAsync(10_000);
    worker.finishCurrent();
    await settle();
    expect(worker.turns[1].content).toContain("1. q1\n2. q2");
    worker.finishCurrent();
  });

  it("a failing ack never loses the text", async () => {
    const memory = memoryInboundStore();
    const worker = gatedProcessor();
    const queue = createInboundQueue({
      store: memory.store,
      process: worker.process,
      log: quiet,
      ackDelayMs: 0,
      acknowledge: async () => {
        throw new Error("send failed");
      },
    });
    await queue.enqueue(text("a", "task"));
    await settle();
    expect(await queue.enqueue(text("a", "still here"))).toBe(true);
    await settle();
    worker.finishCurrent();
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["task", "still here"]);
    worker.finishCurrent();
  });
});

describe("queue helpers", () => {
  it("recognises a bare cancel, and nothing more", () => {
    for (const yes of ["never mind", "Nevermind.", "nvm", "cancel that", "Actually, forget it", "scratch that pls", "ignore my last messages"]) {
      expect(isCancelRequest(yes), yes).toBe(true);
    }
    for (const no of ["never mind the captions, just trim it", "cancel my 3pm meeting", "stop", "forget about the dentist and book a haircut", ""]) {
      expect(isCancelRequest(no), no).toBe(false);
    }
  });

  it("words the acks", () => {
    expect(queuedAckText([2])).toBe("Got it, queued behind the current task (position 2).");
    expect(queuedAckText([3, 2])).toBe("Got it, 2 messages queued behind the current task (positions 2–3).");
    expect(queuedAckText([1, 3])).toBe("Got it, 2 messages queued behind the current task (positions 1, 3).");
    expect(cancelAckText(1)).toMatch(/^Okay, dropped 1 queued message\./);
  });

  it("reads BOOP_QUEUE_ACK_DELAY_MS", () => {
    expect(ackDelayMsFromEnv(undefined)).toBe(2_000);
    expect(ackDelayMsFromEnv("0")).toBe(0);
    expect(ackDelayMsFromEnv("nope")).toBe(2_000);
    expect(ackDelayMsFromEnv("999999")).toBe(60_000);
  });

  it("formats the queue for list_queued_messages", () => {
    const now = 1_000_000_000;
    const overview = {
      totalQueued: 2,
      conversations: [
        {
          conversationId: "sms:+15550001111",
          answeringSince: now - 120_000,
          queued: [
            { content: "add captions", mediaCount: 0, receivedAt: now - 60_000 },
            { content: "", mediaCount: 1, receivedAt: now - 30_000 },
          ],
        },
        { conversationId: "sms:+15550002222", answeringSince: now - 5_000, queued: [] },
      ],
    };
    const mine = formatQueueOverview(overview, { now, conversationId: "sms:+15550001111", owner: false });
    expect(mine).toBe(
      [
        "This conversation: answering a message (started 2m ago), 2 queued behind it",
        '  1. "add captions", sent 1m ago',
        '  2. "(no text)" [1 image], sent 30s ago',
      ].join("\n"),
    );
    const all = formatQueueOverview(overview, { now, conversationId: "sms:+15550001111", owner: true });
    expect(all).toContain("0 queued behind it");
    expect(all).not.toContain("+15550002222");
    expect(formatQueueOverview(overview, { now, conversationId: "sms:other", owner: false })).toMatch(/^Nothing is queued/);
  });
});
