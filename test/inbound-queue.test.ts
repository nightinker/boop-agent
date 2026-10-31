import { describe, expect, it } from "vitest";
import { createInboundQueue, inboundFromSendblue, type InboundItem } from "../server/inbound-queue.js";
import { memoryInboundStore, text } from "./memory-inbound-store.js";

const quiet = { error: () => undefined, warn: () => undefined };

/** A processor whose calls finish only when the test says so. */
function gatedProcessor() {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  let active = 0;
  let maxActive = 0;
  const process = (item: InboundItem) =>
    new Promise<void>((resolve) => {
      started.push(item.content);
      active++;
      maxActive = Math.max(maxActive, active);
      gates.set(item.content, () => {
        active--;
        resolve();
      });
    });
  return {
    process,
    started,
    release: (content: string) => gates.get(content)!(),
    get maxActive() {
      return maxActive;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("inbound queue", () => {
  it("answers a conversation's texts one at a time, in order", async () => {
    const { store, rows } = memoryInboundStore();
    const worker = gatedProcessor();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet });

    await queue.enqueue(text("a", "first"));
    await queue.enqueue(text("a", "second"));
    await queue.enqueue(text("a", "third"));
    await tick();
    expect(worker.started).toEqual(["first"]);

    worker.release("first");
    await tick();
    expect(worker.started).toEqual(["first", "second"]);

    worker.release("second");
    await tick();
    worker.release("third");
    await queue.drain("sms:a");

    expect(worker.started).toEqual(["first", "second", "third"]);
    expect(worker.maxActive).toBe(1);
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
  });

  it("runs different conversations side by side", async () => {
    const { store } = memoryInboundStore();
    const worker = gatedProcessor();
    const queue = createInboundQueue({ store, process: worker.process, log: quiet });

    await queue.enqueue(text("a", "from a"));
    await queue.enqueue(text("b", "from b"));
    await tick();
    expect(worker.started.sort()).toEqual(["from a", "from b"]);
    worker.release("from a");
    worker.release("from b");
  });

  it("answers a text only once when it's delivered twice", async () => {
    const { store, rows } = memoryInboundStore();
    const seen: string[] = [];
    const queue = createInboundQueue({ store, process: async (item) => void seen.push(item.content), log: quiet });

    expect(await queue.enqueue(text("a", "hi", "same-handle"))).toBe(true);
    expect(await queue.enqueue({ ...text("a", "hi", "same-handle"), source: "poll" })).toBe(false);
    await queue.drain("sms:a");

    expect(seen).toEqual(["hi"]);
    expect(rows).toHaveLength(1);
  });

  it("marks a failed text and moves on to the next one", async () => {
    const { store, rows } = memoryInboundStore();
    const seen: string[] = [];
    const queue = createInboundQueue({
      store,
      log: quiet,
      process: async (item) => {
        seen.push(item.content);
        if (item.content === "boom") throw new Error("model down");
      },
    });

    await queue.enqueue(text("a", "boom"));
    await queue.enqueue(text("a", "after"));
    await queue.drain("sms:a");

    expect(seen).toEqual(["boom", "after"]);
    expect(rows.map((r) => [r.status, r.error])).toEqual([
      ["failed", "model down"],
      ["done", undefined],
    ]);
  });

  it("picks up a text that arrives just as the conversation goes idle", async () => {
    const { store } = memoryInboundStore();
    const seen: string[] = [];
    const queue = createInboundQueue({ store, process: async (item) => void seen.push(item.content), log: quiet });

    const first = queue.enqueue(text("a", "one"));
    const second = queue.enqueue(text("a", "two"));
    await Promise.all([first, second]);
    await queue.drain("sms:a");
    await tick();

    expect(seen).toEqual(["one", "two"]);
  });

  it("after a restart, answers texts that were cut off or still waiting", async () => {
    const { store, rows } = memoryInboundStore();
    await store.enqueue(text("a", "cut off"));
    await store.claimNext("sms:a"); // the old process died while answering this
    await store.enqueue(text("a", "waiting"));

    const seen: string[] = [];
    const queue = createInboundQueue({ store, process: async (item) => void seen.push(item.content), log: quiet });
    expect(await queue.recover()).toEqual({ requeued: 1, failed: 0 });
    await queue.drainAll();

    expect(seen).toEqual(["cut off", "waiting"]);
    expect(rows.every((r) => r.status === "done")).toBe(true);
  });
});

describe("reading a Sendblue message", () => {
  it("keeps what Boop needs from an inbound text", () => {
    expect(
      inboundFromSendblue(
        {
          content: "hello",
          from_number: "+15551234567",
          message_handle: "abc",
          media_url: "https://cdn.example/a.png",
          date_sent: "2026-01-01T12:00:00.000Z",
          is_outbound: false,
        },
        "webhook",
      ),
    ).toEqual({
      handle: "abc",
      conversationId: "sms:+15551234567",
      fromNumber: "+15551234567",
      content: "hello",
      mediaUrls: ["https://cdn.example/a.png"],
      source: "webhook",
      receivedAt: Date.parse("2026-01-01T12:00:00.000Z"),
    });
  });

  it("skips outbound and empty messages", () => {
    expect(inboundFromSendblue({ content: "hi", from_number: "+1555", is_outbound: true }, "webhook")).toBeNull();
    expect(inboundFromSendblue({ content: "", from_number: "+1555" }, "webhook")).toBeNull();
    expect(inboundFromSendblue({ content: "hi" }, "webhook")).toBeNull();
    expect(inboundFromSendblue(null, "webhook")).toBeNull();
  });

  it("gives a text without a handle a unique local one", () => {
    const a = inboundFromSendblue({ content: "hi", from_number: "+1555" }, "webhook", 42)!;
    const b = inboundFromSendblue({ content: "hi", from_number: "+1555" }, "webhook", 42)!;
    expect(a.handle).toMatch(/^local:/);
    expect(a.handle).not.toBe(b.handle);
    expect(a.receivedAt).toBe(42);
  });
});
