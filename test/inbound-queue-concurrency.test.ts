import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInboundQueue,
  parseMaxConcurrentRuns,
  type AckTarget,
  type InboundItem,
  type RunContext,
} from "../server/inbound-queue.js";
import {
  createKeyedLock,
  historyBeforeTurn,
  parallelTurnsNote,
  replyHeading,
  withReplyHeading,
} from "../server/parallel-turns.js";
import { formatQueueOverview } from "../server/queue-status.js";
import { memoryInboundStore, text } from "./memory-inbound-store.js";

const quiet = { error: () => undefined, warn: () => undefined };
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A processor whose answers finish only when the test says so, by content. */
function gatedProcessor() {
  const started: string[] = [];
  const runs = new Map<string, RunContext>();
  const gates = new Map<string, () => void>();
  let active = 0;
  let maxActive = 0;
  return {
    started,
    runs,
    process: (item: InboundItem, run: RunContext) =>
      new Promise<void>((resolve) => {
        started.push(item.content);
        runs.set(item.content, run);
        active++;
        maxActive = Math.max(maxActive, active);
        gates.set(item.content, () => {
          active--;
          resolve();
        });
      }),
    finish: (content: string) => gates.get(content)!(),
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
  };
}

function setup(opts: { maxConcurrentRuns?: number | (() => number); debounceMs?: number } = {}) {
  const memory = memoryInboundStore();
  const worker = gatedProcessor();
  const acks: Array<AckTarget & { text: string }> = [];
  const queue = createInboundQueue({
    store: memory.store,
    process: worker.process,
    log: quiet,
    ackDelayMs: 2_000,
    debounceMs: opts.debounceMs ?? 0,
    maxConcurrentRuns: opts.maxConcurrentRuns ?? 2,
    acknowledge: async (target, message) => void acks.push({ ...target, text: message }),
  });
  const status = (content: string) => memory.rows.find((r) => r.content === content)?.status;
  return { ...memory, worker, acks, queue, status };
}

describe("answering up to maxConcurrentRuns texts at once", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts a second text right away in its own run, without a queued ack", async () => {
    const { queue, worker, acks, status } = setup();
    await queue.enqueue(text("a", "long task"));
    await settle();
    await queue.enqueue(text("a", "quick question"));
    await settle();

    expect(worker.started).toEqual(["long task", "quick question"]);
    expect(worker.active).toBe(2);
    expect(status("quick question")).toBe("processing");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(acks).toEqual([]);

    // Each run is its own turn and knows about the other one.
    expect(worker.runs.get("quick question")!.parallel().map((i) => i.content)).toEqual(["long task"]);
    expect(worker.runs.get("long task")!.overlapped()).toBe(true);
    expect(worker.runs.get("quick question")!.batch.map((i) => i.content)).toEqual(["quick question"]);
  });

  it("queues a third text while both slots are busy, numbering only waiting texts", async () => {
    const { queue, worker, acks, status } = setup();
    await queue.enqueue(text("a", "one"));
    await queue.enqueue(text("a", "two"));
    await queue.enqueue(text("a", "three"));
    await settle();

    expect(worker.started).toEqual(["one", "two"]);
    expect(status("three")).toBe("queued");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(acks).toEqual([
      { conversationId: "sms:a", fromNumber: "a", text: "Got it, queued behind the current task (position 1)." },
    ]);

    await queue.enqueue(text("a", "four"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(acks[1].text).toBe("Got it, queued behind the current task (position 2).");
  });

  it("drains the queue into a slot as soon as one frees", async () => {
    const { queue, worker, rows } = setup();
    await queue.enqueue(text("a", "one"));
    await queue.enqueue(text("a", "two"));
    await queue.enqueue(text("a", "three"));
    await queue.enqueue(text("a", "four"));
    await settle();
    expect(worker.started).toEqual(["one", "two"]);

    // "two" finishes first: the texts that waited go together into its slot.
    worker.finish("two");
    await settle();
    expect(worker.started).toHaveLength(3);
    const batch = worker.started[2];
    expect(batch.split("\n").slice(1)).toEqual(["1. three", "2. four"]);
    expect(worker.active).toBe(2);

    worker.finish("one");
    worker.finish(batch);
    await queue.drain("sms:a");
    expect(worker.maxActive).toBe(2);
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("a limit of 1 answers one text at a time, as before", async () => {
    const { queue, worker, acks, rows, status } = setup({ maxConcurrentRuns: 1 });
    await queue.enqueue(text("a", "one"));
    await queue.enqueue(text("a", "two"));
    await settle();
    expect(worker.started).toEqual(["one"]);
    expect(status("two")).toBe("queued");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(acks.map((a) => a.text)).toEqual(["Got it, queued behind the current task (position 1)."]);

    worker.finish("one");
    await settle();
    expect(worker.started).toEqual(["one", "two"]);
    expect(worker.runs.get("two")!.overlapped()).toBe(false);
    worker.finish("two");
    await queue.drain("sms:a");
    expect(worker.maxActive).toBe(1);
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("reads the limit for each text, so setting it back to 1 applies to the next one", async () => {
    let limit = 2;
    const { queue, worker, status } = setup({ maxConcurrentRuns: () => limit });
    await queue.enqueue(text("a", "one"));
    await settle();
    limit = 1;
    await queue.enqueue(text("a", "two"));
    await settle();
    expect(worker.started).toEqual(["one"]);
    expect(status("two")).toBe("queued");
    worker.finish("one");
    await settle();
    expect(worker.started).toEqual(["one", "two"]);
    worker.finish("two");
  });

  it("keeps different conversations independent of each other's slots", async () => {
    const { queue, worker } = setup({ maxConcurrentRuns: 1 });
    await queue.enqueue(text("a", "from a"));
    await queue.enqueue(text("b", "from b"));
    await settle();
    expect([...worker.started].sort()).toEqual(["from a", "from b"]);
    worker.finish("from a");
    worker.finish("from b");
  });

  it("holds the limit across two copies sharing the store (Mac/server handoff)", async () => {
    const memory = memoryInboundStore();
    const mac = gatedProcessor();
    const server = gatedProcessor();
    const onMac = createInboundQueue({ store: memory.store, process: mac.process, log: quiet, maxConcurrentRuns: 2 });
    const onServer = createInboundQueue({ store: memory.store, process: server.process, log: quiet, maxConcurrentRuns: 2 });

    await onMac.enqueue(text("a", "one"));
    await onServer.enqueue(text("a", "two"));
    await onServer.enqueue(text("a", "three"));
    await settle();
    expect(mac.started).toEqual(["one"]);
    expect(server.started).toEqual(["two"]);
    expect(memory.rows.find((r) => r.content === "three")?.status).toBe("queued");

    server.finish("two");
    await settle();
    expect(server.started).toEqual(["two", "three"]);
    mac.finish("one");
    server.finish("three");
  });

  it("restarts both interrupted answers after a restart", async () => {
    const { store, rows, queue } = setup();
    await queue.enqueue(text("a", "one"));
    await queue.enqueue(text("a", "two"));
    await queue.enqueue(text("a", "three"));
    await settle();
    queue.stop(); // the process dies with two answers running

    const after = gatedProcessor();
    const restarted = createInboundQueue({ store, process: after.process, log: quiet, maxConcurrentRuns: 2 });
    expect(await restarted.recover()).toEqual({ requeued: 2, failed: 0 });
    await settle();
    expect(after.started).toEqual(["one", "two"]);
    after.finish("one");
    await settle();
    expect(after.started[2]).toBe("three");
    after.finish("two");
    after.finish("three");
    await restarted.drain("sms:a");
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
  });

  it("with a quiet period, a burst after a running answer gets the free slot and no ack", async () => {
    const { queue, worker, acks } = setup({ debounceMs: 5_000 });
    await queue.enqueue(text("a", "task"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.started).toEqual(["task"]);

    await queue.enqueue(text("a", "q1"));
    await queue.enqueue(text("a", "q2"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(acks).toEqual([]);
    expect(worker.started[1]).toBe("q1\nq2");
    expect(worker.active).toBe(2);
    worker.finish("task");
    worker.finish("q1\nq2");
  });

  it("a failing answer frees its slot and the other run carries on", async () => {
    const memory = memoryInboundStore();
    const worker = gatedProcessor();
    const queue = createInboundQueue({
      store: memory.store,
      log: quiet,
      maxConcurrentRuns: 2,
      process: (item, run) => (item.content === "boom" ? Promise.reject(new Error("nope")) : worker.process(item, run)),
    });
    await queue.enqueue(text("a", "slow"));
    await queue.enqueue(text("a", "boom"));
    await queue.enqueue(text("a", "next"));
    await settle();
    expect(worker.started).toEqual(["slow", "next"]);
    expect(memory.rows.map((r) => r.status)).toEqual(["processing", "failed", "processing"]);
    worker.finish("slow");
    worker.finish("next");
    await queue.drain("sms:a");
  });
});

describe("parallel-turn helpers", () => {
  it("parses maxConcurrentRuns: whole numbers from 1 to 5", () => {
    expect(parseMaxConcurrentRuns(undefined)).toBe(2);
    expect(parseMaxConcurrentRuns(null)).toBe(2);
    expect(parseMaxConcurrentRuns("1")).toBe(1);
    expect(parseMaxConcurrentRuns(3)).toBe(3);
    expect(parseMaxConcurrentRuns("0")).toBe(2);
    expect(parseMaxConcurrentRuns("-1", 1)).toBe(1);
    expect(parseMaxConcurrentRuns("1.5")).toBe(2);
    expect(parseMaxConcurrentRuns("lots")).toBe(2);
    expect(parseMaxConcurrentRuns("99")).toBe(5);
  });

  it("cuts a turn's history at its own message", () => {
    const messages = [
      { role: "user", content: "earlier", turnId: "t0" },
      { role: "assistant", content: "earlier reply", turnId: "t0" },
      { role: "user", content: "long task", turnId: "t1" },
      { role: "user", content: "quick question", turnId: "t2" },
    ];
    expect(historyBeforeTurn(messages, "t1").map((m) => m.content)).toEqual(["earlier", "earlier reply"]);
    expect(historyBeforeTurn(messages, "t2").map((m) => m.content)).toEqual(["earlier", "earlier reply", "long task"]);
    expect(historyBeforeTurn(messages, "missing")).toHaveLength(3);
  });

  it("tells a turn which messages are answered in parallel", () => {
    expect(parallelTurnsNote([])).toBe("");
    const note = parallelTurnsNote(["long task"]);
    expect(note).toMatch(/^Being answered in parallel right now/);
    expect(note).toContain('- "long task"');
  });

  it("heads an overlapping reply with the message it answers", () => {
    expect(replyHeading([{ content: "what's the weather tomorrow in Lisbon, roughly?", mediaUrls: [] }])).toBe(
      '↪ Re "what\'s the weather tomorrow in Lisbon, roughly?":',
    );
    expect(replyHeading([{ content: "x".repeat(80), mediaUrls: [] }])).toBe(`↪ Re "${"x".repeat(59)}…":`);
    expect(replyHeading([{ content: "", mediaUrls: ["u"] }])).toBe("↪ Re your image:");
    expect(replyHeading([{ content: "a", mediaUrls: [] }, { content: "b", mediaUrls: [] }])).toBe("↪ Re your 2 messages:");
    expect(withReplyHeading("Sunny.", '↪ Re "weather?":')).toBe('↪ Re "weather?":\nSunny.');
  });

  it("sends one reply at a time per recipient, so parts never interleave", async () => {
    const lock = createKeyedLock();
    const sent: string[] = [];
    const reply = (name: string, parts: number) =>
      lock("+1555", async () => {
        for (let i = 1; i <= parts; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          sent.push(`${name}${i}`);
        }
      });
    const failing = lock("+1555", async () => {
      throw new Error("send failed");
    });
    await Promise.all([reply("a", 3), failing.catch(() => undefined), reply("b", 2)]);
    expect(sent).toEqual(["a1", "a2", "a3", "b1", "b2"]);
  });

  it("shows parallel answers in list_queued_messages", () => {
    const now = 1_000_000_000;
    const text = formatQueueOverview(
      {
        totalQueued: 1,
        conversations: [
          {
            conversationId: "sms:+15550001111",
            answeringSince: now - 60_000,
            answering: 2,
            queued: [{ content: "third", mediaCount: 0, receivedAt: now - 5_000 }],
          },
        ],
      },
      { now, conversationId: "sms:+15550001111", owner: false },
    );
    expect(text.split("\n")[0]).toBe(
      "This conversation: answering 2 messages in parallel (oldest started 1m ago), 1 queued behind it",
    );
  });
});
