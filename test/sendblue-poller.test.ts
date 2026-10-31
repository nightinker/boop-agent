import { describe, expect, it, vi } from "vitest";
import { pickMissedTexts, pollSendblueOnce } from "../server/sendblue-poller.js";

const now = Date.parse("2026-10-31T17:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

function message(handle: string, sentMsAgo: number, extra: Record<string, unknown> = {}) {
  return {
    message_handle: handle,
    content: `text ${handle}`,
    from_number: "+15551234567",
    is_outbound: false,
    date_sent: ago(sentMsAgo),
    ...extra,
  };
}

describe("finding texts the webhook missed", () => {
  it("keeps recent inbound texts, oldest first", () => {
    const picked = pickMissedTexts([message("new", 60_000), message("old", 5 * 60_000)], {
      now,
      lookbackMs: 30 * 60_000,
    });
    expect(picked.map((p) => p.handle)).toEqual(["old", "new"]);
    expect(picked.every((p) => p.source === "poll")).toBe(true);
  });

  it("gives the webhook a moment before counting a text as missed", () => {
    expect(pickMissedTexts([message("fresh", 5_000)], { now, lookbackMs: 30 * 60_000 })).toEqual([]);
  });

  it("ignores texts older than the lookback window", () => {
    expect(pickMissedTexts([message("stale", 31 * 60_000)], { now, lookbackMs: 30 * 60_000 })).toEqual([]);
  });

  it("ignores outbound messages and ones without a handle", () => {
    const rows = [
      message("mine", 60_000, { is_outbound: true }),
      { ...message("x", 60_000), message_handle: undefined },
    ];
    expect(pickMissedTexts(rows, { now, lookbackMs: 30 * 60_000 })).toEqual([]);
  });
});

describe("polling Sendblue", () => {
  it("asks for recent inbound texts and queues the new ones", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [message("a", 60_000), message("b", 120_000)] }), { status: 200 }),
    );
    const enqueue = vi.fn(async (input: { handle: string }) => input.handle === "a");

    const caught = await pollSendblueOnce({
      queue: { enqueue },
      apiKey: "key",
      apiSecret: "secret",
      now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(caught).toBe(1);
    expect(enqueue.mock.calls.map(([input]) => input.handle)).toEqual(["b", "a"]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("is_outbound=false");
    expect(init.headers).toEqual({ "sb-api-key-id": "key", "sb-api-secret-key": "secret" });
  });

  it("reports a failed request", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(
      pollSendblueOnce({
        queue: { enqueue: vi.fn() },
        apiKey: "key",
        apiSecret: "secret",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("HTTP 503");
  });
});
