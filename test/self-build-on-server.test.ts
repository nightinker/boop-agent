import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const convexMock = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
vi.mock("../server/convex-client.js", () => ({ convex: convexMock }));
vi.mock("../server/notify.js", () => ({ notifyConversation: vi.fn() }));

import { resumeSelfBuilds, shipSelfBuild, startSelfBuild } from "../server/self-build/run.js";

const realPlatform = process.platform;
const env = { ...process.env };

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  delete process.env.BOOP_SOURCE_DIR;
  process.env.BOOP_OWNER_NUMBERS = "+15551234567";
  convexMock.mutation.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  process.env = { ...env };
});

describe("self-builds requested on the server", () => {
  it("queue for the Mac instead of being refused", async () => {
    convexMock.mutation.mockResolvedValue({ status: "queued", position: 1, blockedBy: null });
    const reply = await startSelfBuild({ conversationId: "sms:+15551234567", request: "Add X" });
    expect(convexMock.mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ request: "Add X", forceQueue: true }),
    );
    expect(reply).toContain("your Mac starts it as soon as it's back online");
  });

  it("leave the Mac's running builds alone when the server restarts", async () => {
    // A server restart (e.g. its auto-update) interrupted nothing: the build
    // marked coding is running on the Mac, so it must not be failed here.
    convexMock.query.mockResolvedValue([{ buildId: "b1", status: "coding" }]);
    await resumeSelfBuilds();
    expect(convexMock.mutation).not.toHaveBeenCalled();
  });

  it("explain that shipping waits for the Mac", async () => {
    const reply = await shipSelfBuild({ conversationId: "sms:+15551234567" });
    expect(reply).toContain("has to happen on your Mac");
    expect(convexMock.mutation).not.toHaveBeenCalled();
  });
});

describe("retrySelfBuild", () => {
  it("re-queues a failed build's request and records which build it re-runs", async () => {
    const { retrySelfBuild } = await import("../server/self-build/run.js");
    convexMock.query.mockResolvedValue({ buildId: "b-old", status: "failed", request: "Add X", conversationId: "sms:+15551234567" });
    convexMock.mutation.mockResolvedValue({ status: "queued", position: 1, blockedBy: null });
    const reply = await retrySelfBuild({ conversationId: "sms:+15551234567", buildId: "b-old" });
    expect(convexMock.mutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ request: "Add X", retryOf: "b-old" }),
    );
    expect(reply).toMatch(/^Retrying build b-old\./);
  });

  it("refuses a build that isn't finished or failed", async () => {
    const { retrySelfBuild } = await import("../server/self-build/run.js");
    convexMock.query.mockResolvedValue({ buildId: "b1", status: "coding", request: "x" });
    expect(await retrySelfBuild({ conversationId: "sms:+15551234567", buildId: "b1" })).toContain(
      "only failed, cancelled or rolled-back builds can be retried",
    );
    expect(convexMock.mutation).not.toHaveBeenCalled();
  });

  it("is owner-only", async () => {
    const { retrySelfBuild } = await import("../server/self-build/run.js");
    expect(await retrySelfBuild({ conversationId: "sms:+19999999999", buildId: "b1" })).toContain("Only Boop's owner");
  });
});
