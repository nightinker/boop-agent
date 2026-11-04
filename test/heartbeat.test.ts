import { describe, expect, it, vi } from "vitest";

vi.mock("../server/convex-client.js", () => ({ convex: {} }));
vi.mock("../server/broadcast.js", () => ({ broadcast: () => {} }));
vi.mock("../server/instance.js", () => ({ isActiveInstance: () => true }));

const { classifyRun, MAX_RUN_MS } = await import("../server/heartbeat.js");
const { STALLED_AFTER_MS } = await import("../server/agent-auto-retry.js");

describe("classifyRun", () => {
  const now = 10 * MAX_RUN_MS;

  it("keeps a long run that is still busy", () => {
    const startedAt = now - 60 * 60 * 1000;
    expect(classifyRun(now, startedAt, { startedAt, lastActivity: now - 1000 })).toBe("keep");
  });

  it("flags a run that has gone quiet", () => {
    const startedAt = now - 30 * 60 * 1000;
    expect(classifyRun(now, startedAt, { startedAt, lastActivity: now - STALLED_AFTER_MS })).toBe(
      "stale",
    );
  });

  it("stops a run past the hard limit even if busy", () => {
    const startedAt = now - MAX_RUN_MS;
    expect(classifyRun(now, startedAt, { startedAt, lastActivity: now })).toBe("timeout");
  });

  it("marks a run the server no longer knows about as orphaned", () => {
    expect(classifyRun(now, now - 5 * 60 * 1000, undefined)).toBe("orphaned");
    expect(classifyRun(now, now - 10 * 1000, undefined)).toBe("keep");
  });
});
