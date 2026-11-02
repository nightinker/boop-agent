import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ mutations: [] as { name: string; args: Record<string, unknown> }[] }));

vi.mock("../server/convex-client.js", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    convex: {
      mutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
        calls.mutations.push({ name: getFunctionName(ref as never), args });
        return null;
      }),
      query: vi.fn(async () => []),
    },
  };
});
vi.mock("../server/broadcast.js", () => ({ broadcast: vi.fn() }));
vi.mock("../server/scripted-demo-replies.js", () => ({ maybeHandleScriptedDemoReply: vi.fn(async () => false) }));
vi.mock("../server/interaction-agent.js", () => ({
  handleUserMessageWithAttachments: vi.fn(async () => ({ reply: "Done: #64 is locked while live.", attachments: [] })),
}));

const { processInboundText } = await import("../server/sendblue.js");
const { networkHealth } = await import("../server/network-health.js");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  calls.mutations.length = 0;
});

describe("a reply that can't be sent", () => {
  it("goes to the outbox and the history instead of failing the text", async () => {
    process.env.SENDBLUE_API_KEY = "test-key";
    process.env.SENDBLUE_API_SECRET = "test-secret";
    process.env.SENDBLUE_FROM_NUMBER = "+15550000000";
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const turn = processInboundText({
      _id: "row1",
      handle: "h1",
      conversationId: "sms:user@example.com",
      fromNumber: "user@example.com",
      content: "any update here?",
      mediaUrls: [],
      source: "webhook",
      receivedAt: 0,
      attempts: 1,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(turn).resolves.toBeUndefined();

    const names = calls.mutations.map((m) => m.name);
    expect(names).toEqual(["replyOutbox:add", "messages:send"]);
    expect(calls.mutations[0].args).toMatchObject({
      toNumber: "user@example.com",
      content: "Done: #64 is locked while live.",
    });
    expect(calls.mutations[1].args).toMatchObject({ role: "assistant", content: "Done: #64 is locked while live." });
    expect(networkHealth.isDegraded()).toBe(true);
  });
});
