import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const convexMock = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
vi.mock("../server/convex-client.js", () => ({ convex: convexMock }));
vi.mock("../server/notify.js", () => ({ notifyConversation: vi.fn() }));

import { shipSelfBuild, startSelfBuild } from "../server/self-build/run.js";

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

  it("explain that shipping waits for the Mac", async () => {
    const reply = await shipSelfBuild({ conversationId: "sms:+15551234567" });
    expect(reply).toContain("has to happen on your Mac");
    expect(convexMock.mutation).not.toHaveBeenCalled();
  });
});
