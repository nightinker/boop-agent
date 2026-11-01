import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  combineInbound,
  createInboundQueue,
  debounceMsFromEnv,
  maxTypingHoldMsFromEnv,
  serviceFromSendblue,
  supportsTyping,
  typingFromSendblue,
  type InboundItem,
} from "../server/inbound-queue.js";
import { memoryInboundStore, text } from "./memory-inbound-store.js";

const quiet = { error: () => undefined, warn: () => undefined };

function recorder() {
  const turns: InboundItem[] = [];
  return { turns, process: async (item: InboundItem) => void turns.push(item) };
}

/** Lets the queue's awaited store calls settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("inbound queue with a quiet period", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("folds rapid-fire texts (1s apart) into a single turn", async () => {
    const { store, rows } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, debounceMs: 5_000 });

    await queue.enqueue(text("a", "hey"));
    await vi.advanceTimersByTimeAsync(1_000);
    await queue.enqueue(text("a", "can you check", "h2", ["https://cdn.example/1.png"]));
    await vi.advanceTimersByTimeAsync(1_000);
    await queue.enqueue(text("a", "my calendar for friday?"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(worker.turns).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(worker.turns).toHaveLength(1);
    expect(worker.turns[0].content).toBe("hey\ncan you check\nmy calendar for friday?");
    expect(worker.turns[0].mediaUrls).toEqual(["https://cdn.example/1.png"]);
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
  });

  it("still answers a single text, after the quiet period", async () => {
    const { store, rows } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, debounceMs: 5_000 });

    await queue.enqueue(text("a", "just one"));
    expect(queue.isBusy()).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(worker.turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(worker.turns.map((t) => t.content)).toEqual(["just one"]);
    expect(rows[0].status).toBe("done");
    expect(queue.isBusy()).toBe(false);
  });

  it("restarts the full wait on every new text", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, debounceMs: 5_000 });

    await queue.enqueue(text("a", "one"));
    await vi.advanceTimersByTimeAsync(4_000);
    await queue.enqueue(text("a", "two"));
    // 8s after the first text, but only 4s after the second: still waiting.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(worker.turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["one\ntwo"]);
  });

  it("won't answer while a drain runs mid-burst (e.g. the poller's safety net)", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, debounceMs: 5_000 });

    await queue.enqueue(text("a", "one"));
    await queue.drainAll();
    expect(worker.turns).toHaveLength(0);
  });

  it("keeps conversations apart", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, debounceMs: 5_000 });

    await queue.enqueue(text("a", "a1"));
    await vi.advanceTimersByTimeAsync(3_000);
    await queue.enqueue(text("b", "b1"));
    await queue.enqueue(text("a", "a2"));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(worker.turns.map((t) => [t.conversationId, t.content]).sort()).toEqual([
      ["sms:a", "a1\na2"],
      ["sms:b", "b1"],
    ]);
  });

  it("holds texts that arrive mid-answer for the next batch", async () => {
    const { store } = memoryInboundStore();
    const started: string[] = [];
    let release!: () => void;
    const queue = createInboundQueue({
      store,
      log: quiet,
      debounceMs: 5_000,
      process: (item) =>
        new Promise<void>((resolve) => {
          started.push(item.content);
          release = resolve;
        }),
    });

    await queue.enqueue(text("a", "first"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toEqual(["first"]);

    await queue.enqueue(text("a", "second"));
    await vi.advanceTimersByTimeAsync(1_000);
    await queue.enqueue(text("a", "third"));
    release(); // first answer finishes while the new burst is still open
    await vi.advanceTimersByTimeAsync(4_999);
    expect(started).toEqual(["first"]);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(started).toEqual(["first", "second\nthird"]);
    release();
  });

  it("waits while the sender is typing, then restarts the quiet period", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({
      store,
      process: worker.process,
      log: quiet,
      debounceMs: 5_000,
      maxTypingWaitMs: 30_000,
    });

    await queue.enqueue(text("a", "one"));
    await vi.advanceTimersByTimeAsync(3_000);
    queue.noteTyping("sms:a", true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(worker.turns).toHaveLength(0);

    queue.noteTyping("sms:a", false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(worker.turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["one"]);
  });

  it("stops waiting on a typing signal that never ends", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({
      store,
      process: worker.process,
      log: quiet,
      debounceMs: 5_000,
      maxTypingWaitMs: 30_000,
    });

    await queue.enqueue(text("a", "one"));
    queue.noteTyping("sms:a", true);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["one"]);
  });

  it("ignores typing when nothing is waiting", async () => {
    const { store } = memoryInboundStore();
    const queue = createInboundQueue({ store, process: async () => undefined, log: quiet, debounceMs: 5_000 });
    queue.noteTyping("sms:a", true);
    expect(queue.isBusy()).toBe(false);
  });

  it("answers each text at once when the quiet period is 0", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, debounceMs: 0 });

    await queue.enqueue(text("a", "one"));
    await queue.enqueue(text("a", "two"));
    await queue.drain("sms:a");
    expect(worker.turns.map((t) => t.content)).toEqual(["one", "two"]);
  });

  it("on shutdown leaves waiting texts queued, and answers them together after restart", async () => {
    const { store, rows } = memoryInboundStore();
    const before = recorder();
    const old = createInboundQueue({ store, process: before.process, log: quiet, debounceMs: 5_000 });
    await old.enqueue(text("a", "one"));
    await old.enqueue(text("a", "two"));
    expect(old.stop()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(before.turns).toHaveLength(0);
    expect(rows.map((r) => r.status)).toEqual(["queued", "queued"]);

    const after = recorder();
    const restarted = createInboundQueue({ store, process: after.process, log: quiet, debounceMs: 5_000 });
    await restarted.recover();
    await settle();
    await restarted.drainAll();
    expect(after.turns.map((t) => t.content)).toEqual(["one\ntwo"]);
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("marks every text in a failed batch as failed", async () => {
    const { store, rows } = memoryInboundStore();
    const queue = createInboundQueue({
      store,
      log: quiet,
      debounceMs: 5_000,
      process: async () => {
        throw new Error("model down");
      },
    });
    await queue.enqueue(text("a", "one"));
    await queue.enqueue(text("a", "two"));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(rows.map((r) => [r.status, r.error])).toEqual([
      ["failed", "model down"],
      ["failed", "model down"],
    ]);
  });

  it("doesn't hold up an idle conversation for a duplicate delivery", async () => {
    const { store } = memoryInboundStore();
    const queue = createInboundQueue({ store, process: async () => undefined, log: quiet, debounceMs: 5_000 });
    await queue.enqueue(text("a", "one"));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(await queue.enqueue(text("a", "one"))).toBe(false);
    expect(queue.isBusy()).toBe(false);
  });
});

describe("quiet period with Sendblue typing indicators", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function typingQueue() {
    const { store, rows } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({
      store,
      process: worker.process,
      log: quiet,
      debounceMs: 5_000,
      maxTypingWaitMs: 45_000,
    });
    return { queue, rows, turns: worker.turns };
  }

  it("holds the window open while the sender is typing", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(queue.noteTyping("sms:a", true)).toBe("held");
    // Well past the 5s quiet period: still holding.
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(turns).toHaveLength(0);
    expect(queue.isBusy()).toBe(true);
  });

  it("restarts the full 5s window when they stop typing", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"), { service: "iMessage" });
    queue.noteTyping("sms:a", true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queue.noteTyping("sms:a", false)).toBe("restarted");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one"]);
  });

  it("a new text while typing ends the hold and restarts the 5s window", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"));
    queue.noteTyping("sms:a", true);
    await vi.advanceTimersByTimeAsync(8_000);
    await queue.enqueue(text("a", "two"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one\ntwo"]);
  });

  it("answers once the max hold passes if is_typing=false never arrives", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"));
    await vi.advanceTimersByTimeAsync(1_000);
    queue.noteTyping("sms:a", true);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one"]);
    expect(queue.isBusy()).toBe(false);
  });

  it("repeated is_typing=true signals don't push the max hold out", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"));
    queue.noteTyping("sms:a", true);
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      queue.noteTyping("sms:a", true);
    }
    // 40s in: still holding; the cap is counted from the first signal.
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one"]);
  });

  it("ignores typing from a number with nothing waiting", async () => {
    const { queue, turns } = typingQueue();
    expect(queue.noteTyping("sms:+15559999999", true)).toBe("ignored");
    expect(queue.isBusy()).toBe(false);
    // ...and it doesn't leak into that number's next text.
    await queue.enqueue(text("+15559999999", "hi"));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["hi"]);
  });

  it("SMS and RCS texts ignore typing and keep the plain 5s wait", async () => {
    for (const service of ["SMS", "RCS"]) {
      const { queue, turns } = typingQueue();
      await queue.enqueue(text("a", "one"), { service });
      expect(queue.noteTyping("sms:a", true)).toBe("ignored");
      expect(queue.noteTyping("sms:a", false)).toBe("ignored");
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(turns.map((t) => t.content)).toEqual(["one"]);
    }
  });

  it("without typing signals the timing is exactly the plain quiet period", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(3_000);
    await queue.enqueue(text("a", "two"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one\ntwo"]);
  });

  it("typing is ignored when the quiet period or the max hold is 0", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({
      store,
      process: worker.process,
      log: quiet,
      debounceMs: 5_000,
      maxTypingWaitMs: 0,
    });
    await queue.enqueue(text("a", "one"));
    expect(queue.noteTyping("sms:a", true)).toBe("ignored");
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["one"]);

    const instant = createInboundQueue({ store, process: async () => undefined, log: quiet, debounceMs: 0 });
    expect(instant.noteTyping("sms:a", true)).toBe("ignored");
  });
});

describe("quiet period helpers", () => {
  it("reads BOOP_MAX_TYPING_HOLD_MS with a 60s default", () => {
    expect(maxTypingHoldMsFromEnv(undefined)).toBe(60_000);
    expect(maxTypingHoldMsFromEnv(" ")).toBe(60_000);
    expect(maxTypingHoldMsFromEnv("30000")).toBe(30_000);
    expect(maxTypingHoldMsFromEnv("0")).toBe(0);
    expect(maxTypingHoldMsFromEnv("soon")).toBe(60_000);
    expect(maxTypingHoldMsFromEnv("-5")).toBe(60_000);
  });

  it("only iMessage (or an unstated service) supports typing", () => {
    expect(supportsTyping("iMessage")).toBe(true);
    expect(supportsTyping(undefined)).toBe(true);
    expect(supportsTyping("SMS")).toBe(false);
    expect(supportsTyping("RCS")).toBe(false);
    expect(serviceFromSendblue({ service: "SMS" })).toBe("SMS");
    expect(serviceFromSendblue({ content: "hi" })).toBeUndefined();
  });

  it("reads BOOP_MESSAGE_DEBOUNCE_MS with a 5s default", () => {
    expect(debounceMsFromEnv(undefined)).toBe(5_000);
    expect(debounceMsFromEnv("")).toBe(5_000);
    expect(debounceMsFromEnv("0")).toBe(0);
    expect(debounceMsFromEnv("2500")).toBe(2_500);
    expect(debounceMsFromEnv("nope")).toBe(5_000);
    expect(debounceMsFromEnv("-1")).toBe(5_000);
  });

  it("combines texts in order, skipping image-only blanks, keeping every image", () => {
    const item = (id: string, content: string, mediaUrls: string[] = []): InboundItem => ({
      ...text("a", content, id, mediaUrls),
      _id: id,
      attempts: 1,
    });
    const combined = combineInbound([item("1", "look"), item("2", "", ["https://cdn.example/x.png"]), item("3", "this?")]);
    expect(combined.content).toBe("look\nthis?");
    expect(combined.mediaUrls).toEqual(["https://cdn.example/x.png"]);
    expect(combined.handle).toBe("3");
  });

  it("reads a Sendblue typing indicator", () => {
    expect(typingFromSendblue({ number: "+15551234567", is_typing: true, from_number: "+15550000000" })).toEqual({
      conversationId: "sms:+15551234567",
      isTyping: true,
    });
    expect(typingFromSendblue({ number: "+15551234567", is_typing: false })?.isTyping).toBe(false);
    expect(typingFromSendblue({ content: "hi", from_number: "+1555" })).toBeNull();
  });
});
