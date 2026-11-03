import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  combineInbound,
  contactMatchKey,
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
    expect(started).toHaveLength(2);
    expect(started[1]).toMatch(/sent while you were busy[^\n]*\n1\. second\n2\. third$/);
    release();
  });

  it("typing extends the quiet period, then answers 5s after the last signal", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({
      store,
      process: worker.process,
      log: quiet,
      debounceMs: 5_000,
      maxTypingWaitMs: 15_000,
    });

    await queue.enqueue(text("a", "one"));
    await vi.advanceTimersByTimeAsync(3_000);
    queue.noteTyping("sms:a", true);
    await vi.advanceTimersByTimeAsync(4_000);
    // 7s after the text, 4s after typing: still waiting.
    expect(worker.turns).toHaveLength(0);

    queue.noteTyping("sms:a", false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(worker.turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["one"]);
  });

  it("logs hold start, extend and flush", async () => {
    const { store } = memoryInboundStore();
    const lines: string[] = [];
    const queue = createInboundQueue({
      store,
      process: async () => undefined,
      log: { ...quiet, log: (line: string) => void lines.push(line) },
      debounceMs: 5_000,
    });

    await queue.enqueue(text("+15551234567", "one"));
    queue.noteTyping("sms:+15551234567", true);
    queue.noteTyping("sms:+15551234567", false);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    queue.noteTyping("sms:+15551234567", true);
    expect(lines[0]).toMatch(/hold started/);
    expect(lines[1]).toMatch(/hold extended .*started typing.*until stopped typing/);
    expect(lines[2]).toMatch(/hold extended .*stopped typing/);
    expect(lines[3]).toMatch(/\] flush for/);
    expect(lines[4]).toMatch(/typing signal .* ignored: no text waiting/);
    // Phone numbers stay out of the logs.
    expect(lines.join("\n")).not.toContain("5551234567");
  });

  it("logs a max-hold flush when the cap cuts the wait short", async () => {
    const { store } = memoryInboundStore();
    const lines: string[] = [];
    const queue = createInboundQueue({
      store,
      process: async () => undefined,
      log: { ...quiet, log: (line: string) => void lines.push(line) },
      debounceMs: 5_000,
      maxTypingWaitMs: 60_000,
    });

    await queue.enqueue(text("a", "one"));
    queue.noteTyping("sms:a", true);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      queue.noteTyping("sms:a", true);
    }
    await settle();
    expect(lines.filter((l) => /flush/.test(l))).toEqual([expect.stringMatching(/max-hold flush .* after 60000ms/)]);
  });

  it("logs a typing-timeout flush when \"stopped typing\" never arrives", async () => {
    const { store } = memoryInboundStore();
    const lines: string[] = [];
    const queue = createInboundQueue({
      store,
      process: async () => undefined,
      log: { ...quiet, log: (line: string) => void lines.push(line) },
      debounceMs: 5_000,
    });

    await queue.enqueue(text("a", "one"));
    queue.noteTyping("sms:a", true);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(lines.at(-1)).toMatch(/typing-timeout flush .* after 30000ms/);
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
      maxTypingWaitMs: 60_000,
    });
    return { queue, rows, turns: worker.turns };
  }

  it("holds the window open while the sender is typing", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(queue.noteTyping("sms:a", true)).toBe("held");
    // Well past the text's own 5s and the old 15s cap: still typing, still waiting.
    await vi.advanceTimersByTimeAsync(16_000);
    await settle();
    expect(turns).toHaveLength(0);
    expect(queue.isBusy()).toBe(true);
  });

  it("restarts the full 5s window when they stop typing", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"), { service: "iMessage" });
    queue.noteTyping("sms:a", true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.noteTyping("sms:a", false)).toBe("restarted");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one"]);
  });

  it("a new text while typing restarts the 5s window", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"));
    queue.noteTyping("sms:a", true);
    await vi.advanceTimersByTimeAsync(3_000);
    await queue.enqueue(text("a", "two"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one\ntwo"]);
  });

  it("a typing start with no stop event holds 30s from that signal, then answers", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"));
    await vi.advanceTimersByTimeAsync(1_000);
    queue.noteTyping("sms:a", true);
    // is_typing=false never arrives.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one"]);
    expect(queue.isBusy()).toBe(false);
  });

  it("repeated is_typing=true signals can't hold past the 60s typing cap", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "one"));
    queue.noteTyping("sms:a", true);
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      queue.noteTyping("sms:a", true);
    }
    // 50s in; the next 30s would end at 80s, but the cap is 60s.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one"]);
  });

  it("a steady stream of texts alone is still answered within 15s", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("a", "t0"));
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      await queue.enqueue(text("a", `t${i}`));
    }
    // 16s of constant texting: the first batch went out at 15s.
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["t0\nt1\nt2\nt3"]);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["t0\nt1\nt2\nt3", "t4"]);
  });

  it("matches typing for the same number written differently", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("+15551234567", "one"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(queue.noteTyping("sms:15551234567", true)).toBe("held");
    expect(queue.noteTyping("sms:(555) 123-4567", true)).toBe("held");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(turns).toHaveLength(0);
    expect(queue.noteTyping("sms:555.123.4567", false)).toBe("restarted");
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    // Answered once, under the conversation the text came in on.
    expect(turns.map((t) => [t.conversationId, t.content])).toEqual([["sms:+15551234567", "one"]]);
    expect(queue.isBusy()).toBe(false);
  });

  it("typing for a different number never holds a waiting text", async () => {
    const { queue, turns } = typingQueue();
    await queue.enqueue(text("+15551234567", "one"));
    expect(queue.noteTyping("sms:+15559876543", true)).toBe("ignored");
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["one"]);
  });

  it("retries a flush whose store call failed instead of leaving texts held", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const claimQueued = store.claimQueued.bind(store);
    let failures = 1;
    store.claimQueued = async (id) => {
      if (failures-- > 0) throw new Error("network down");
      return claimQueued(id);
    };
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, debounceMs: 5_000, retryDelayMs: 1_000 });
    await queue.enqueue(text("a", "one"));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(worker.turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["one"]);
  });

  it("answers a text whose save outlasted the hold", async () => {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const enqueue = store.enqueue.bind(store);
    store.enqueue = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return enqueue(input);
    };
    const queue = createInboundQueue({ store, process: worker.process, log: quiet, debounceMs: 5_000 });
    const saved = queue.enqueue(text("a", "slow"));
    await vi.advanceTimersByTimeAsync(6_000);
    await saved;
    await settle();
    expect(worker.turns.map((t) => t.content)).toEqual(["slow"]);
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

describe("regression: Boop replied while the user was still typing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Production defaults: 5s quiet, 60s typing cap, 30s per "started typing".
  function prodQueue() {
    const { store } = memoryInboundStore();
    const worker = recorder();
    const queue = createInboundQueue({
      store,
      process: worker.process,
      log: quiet,
      debounceMs: debounceMsFromEnv(undefined),
      maxTypingWaitMs: maxTypingHoldMsFromEnv(undefined),
    });
    return { queue, turns: worker.turns };
  }

  it("a typing event mid-debounce holds the reply past the quiet period", async () => {
    const { queue, turns } = prodQueue();
    await queue.enqueue(text("+15551234567", "first thought"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.noteTyping("sms:+15551234567", true)).toBe("held");
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(turns).toHaveLength(0);
  });

  it("continuous typing beyond 10s (and past the old 15s cap) doesn't trigger a reply", async () => {
    const { queue, turns } = prodQueue();
    await queue.enqueue(text("+15551234567", "first thought"), { service: "iMessage" });
    // They start typing again ~5s later, as in the bug report, and Sendblue
    // sends nothing more until they stop.
    await vi.advanceTimersByTimeAsync(4_900);
    queue.noteTyping("sms:+15551234567", true);
    for (let s = 0; s < 22; s++) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(turns).toHaveLength(0);
    }
    expect(queue.isBusy()).toBe(true);
  });

  it("repeated typing events keep holding while they keep arriving", async () => {
    const { queue, turns } = prodQueue();
    await queue.enqueue(text("+15551234567", "first thought"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(2_000);
    queue.noteTyping("sms:+15551234567", true);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(8_000);
      queue.noteTyping("sms:+15551234567", true);
      queue.noteTyping("sms:+15551234567", false);
      queue.noteTyping("sms:+15551234567", true);
    }
    // 42s in, still typing.
    await settle();
    expect(turns).toHaveLength(0);
  });

  it("flushes 5s after typing stops", async () => {
    const { queue, turns } = prodQueue();
    await queue.enqueue(text("+15551234567", "first thought"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(4_000);
    queue.noteTyping("sms:+15551234567", true);
    await vi.advanceTimersByTimeAsync(14_000);
    // 18s in: they give up without sending.
    expect(queue.noteTyping("sms:+15551234567", false)).toBe("restarted");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["first thought"]);
  });

  it("flushes 5s after the follow-up text that ends the typing", async () => {
    const { queue, turns } = prodQueue();
    await queue.enqueue(text("+15551234567", "first thought"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(4_000);
    queue.noteTyping("sms:+15551234567", true);
    await vi.advanceTimersByTimeAsync(16_000);
    // Sendblue may never send is_typing=false once the text goes out.
    await queue.enqueue(text("+15551234567", "second thought"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["first thought\nsecond thought"]);
  });

  it("typing events for a different number are ignored", async () => {
    const { queue, turns } = prodQueue();
    await queue.enqueue(text("+15551234567", "first thought"), { service: "iMessage" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(queue.noteTyping("sms:+15559876543", true)).toBe("ignored");
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(turns.map((t) => t.content)).toEqual(["first thought"]);
  });
});

describe("quiet period helpers", () => {
  it("reads BOOP_MAX_TYPING_HOLD_MS with a 60s default and a 120s ceiling", () => {
    expect(maxTypingHoldMsFromEnv(undefined)).toBe(60_000);
    expect(maxTypingHoldMsFromEnv(" ")).toBe(60_000);
    expect(maxTypingHoldMsFromEnv("30000")).toBe(30_000);
    expect(maxTypingHoldMsFromEnv("600000")).toBe(120_000);
    expect(maxTypingHoldMsFromEnv("0")).toBe(0);
    expect(maxTypingHoldMsFromEnv("soon")).toBe(60_000);
    expect(maxTypingHoldMsFromEnv("-5")).toBe(60_000);
  });

  it("matches a contact across number formats", () => {
    const key = contactMatchKey("sms:+15551234567");
    expect(contactMatchKey("sms:15551234567")).toBe(key);
    expect(contactMatchKey("sms:5551234567")).toBe(key);
    expect(contactMatchKey("sms:+1 (555) 123-4567")).toBe(key);
    expect(contactMatchKey("sms:+15559876543")).not.toBe(key);
    expect(contactMatchKey("sms:Someone@Example.com")).toBe("someone@example.com");
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
    // A real text carrying is_typing is a text, not a typing hint.
    expect(typingFromSendblue({ number: "+15551234567", is_typing: false, content: "hi", message_handle: "m1" })).toBeNull();
  });
});
