import { afterEach, describe, expect, it, vi } from "vitest";
import { pickActive, type InstanceRow } from "../convex/instanceRules.js";
import {
  DEGRADED_PRIORITY,
  isActiveInstance,
  resetInstanceState,
  startInstanceCoordinator,
  type InstanceIdentity,
  type InstanceSummary,
} from "../server/instance.js";
import { createNetworkHealth, isNetworkError } from "../server/network-health.js";
import { flushReplyOutbox, OUTBOX_MAX_AGE_MS, type OutboxRow } from "../server/reply-outbox.js";

const quiet = { log: () => undefined, warn: () => undefined };
const MIN = 60_000;

afterEach(() => resetInstanceState());

describe("network health", () => {
  it("turns degraded after 3 failures in 3 minutes, not 2", () => {
    const h = createNetworkHealth({ log: quiet });
    h.noteFailure("a", 0);
    h.noteFailure("b", 1 * MIN);
    expect(h.isDegraded(1 * MIN)).toBe(false);
    h.noteFailure("c", 2 * MIN);
    expect(h.isDegraded(2 * MIN)).toBe(true);
  });

  it("ignores failures spread out over a longer time", () => {
    const h = createNetworkHealth({ log: quiet });
    h.noteFailure("a", 0);
    h.noteFailure("b", 2 * MIN);
    h.noteFailure("c", 4 * MIN);
    expect(h.isDegraded(4 * MIN)).toBe(false);
  });

  it("recovers after 10 minutes without a failure, and a new failure resets the clock", () => {
    const h = createNetworkHealth({ log: quiet });
    for (const t of [0, 10_000, 20_000]) h.noteFailure("x", t);
    h.noteFailure("x", 5 * MIN); // still failing
    expect(h.isDegraded(14 * MIN)).toBe(true);
    expect(h.isDegraded(15 * MIN)).toBe(false);
  });

  it("knows a network failure from a service saying no", () => {
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkError(Object.assign(new Error("boom"), { cause: { code: "ENOTFOUND" } }))).toBe(true);
    expect(isNetworkError(new DOMException("The operation timed out.", "TimeoutError"))).toBe(true);
    expect(isNetworkError(new Error("send failed (HTTP 400)"))).toBe(false);
  });
});

describe("handing over when the Mac's network is bad", () => {
  it("checks in below the server while degraded, so the server takes over, then takes back over", async () => {
    // A tiny Convex: the same pickActive rule over the latest check-ins.
    const rows = new Map<string, InstanceRow>([
      ["server", { instanceId: "server", label: "server", platform: "linux", priority: 10, startedAt: 0, lastSeenAt: 0 }],
    ]);
    const checkIn = async (identity: InstanceIdentity): Promise<InstanceSummary> => {
      const now = Date.now();
      rows.set(identity.instanceId, { ...identity, lastSeenAt: now });
      rows.set("server", { ...rows.get("server")!, lastSeenAt: now });
      const all = [...rows.values()];
      return {
        activeInstanceId: pickActive(all, now)?.instanceId ?? null,
        instances: all.map((r) => ({ ...r, publicUrl: null, online: true })),
      };
    };
    let degraded = false;
    const noteFailure = vi.fn();
    const seen: number[] = [];
    const onDeactivate = vi.fn();
    const onActivate = vi.fn();
    const c = startInstanceCoordinator({
      identity: { instanceId: "mac", label: "the Mac", platform: "darwin", priority: 100, startedAt: 0 },
      checkIn: (identity) => {
        seen.push(identity.priority);
        return checkIn(identity);
      },
      leave: async () => undefined,
      network: { isDegraded: () => degraded, noteFailure },
      onActivate,
      onDeactivate,
      intervalMs: 60_000,
      graceMs: 0,
      log: quiet,
    });
    await c.tick();
    expect(isActiveInstance()).toBe(true);

    degraded = true;
    await c.tick();
    expect(seen.at(-1)).toBe(DEGRADED_PRIORITY);
    expect(isActiveInstance()).toBe(false);
    expect(onDeactivate).toHaveBeenCalledTimes(1);

    degraded = false;
    await c.tick();
    expect(seen.at(-1)).toBe(100);
    expect(isActiveInstance()).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(2);
    await c.stop();
  });

  it("stays active while degraded when no other copy is online", async () => {
    const c = startInstanceCoordinator({
      identity: { instanceId: "mac", label: "the Mac", platform: "darwin", priority: 100, startedAt: 0 },
      checkIn: async (identity) => {
        const r = { ...identity, lastSeenAt: Date.now() };
        return {
          activeInstanceId: pickActive([r], Date.now())?.instanceId ?? null,
          instances: [{ ...r, publicUrl: null, online: true }],
        };
      },
      leave: async () => undefined,
      network: { isDegraded: () => true, noteFailure: () => undefined },
      onActivate: () => undefined,
      onDeactivate: () => undefined,
      intervalMs: 60_000,
      log: quiet,
    });
    await c.tick();
    expect(isActiveInstance()).toBe(true);
    await c.stop();
  });

  it("counts a failed check-in as a network failure", async () => {
    const noteFailure = vi.fn();
    const c = startInstanceCoordinator({
      identity: { instanceId: "mac", label: "the Mac", platform: "darwin", priority: 100, startedAt: 0 },
      checkIn: async () => {
        throw new TypeError("fetch failed");
      },
      leave: async () => undefined,
      network: { isDegraded: () => false, noteFailure },
      onActivate: () => undefined,
      onDeactivate: () => undefined,
      intervalMs: 60_000,
      log: quiet,
    });
    await c.tick();
    expect(noteFailure).toHaveBeenCalledWith("convex check-in");
    await c.stop();
  });
});

describe("reply outbox", () => {
  const row = (id: string, createdAt: number): OutboxRow => ({
    _id: id,
    conversationId: "sms:user@example.com",
    toNumber: "user@example.com",
    content: `reply ${id}`,
    createdAt,
    attempts: 0,
  });
  const deps = (rows: OutboxRow[], send: (to: string, text: string) => Promise<void>, active = true) => {
    const removed: string[] = [];
    const attempts: string[] = [];
    return {
      removed,
      attempts,
      d: {
        pending: async () => rows,
        send,
        remove: async (id: string) => void removed.push(id),
        noteAttempt: async (id: string) => void attempts.push(id),
        isActive: () => active,
        now: () => 10 * MIN,
        log: quiet,
      },
    };
  };

  it("resends waiting replies in order and clears them", async () => {
    const send = vi.fn(async () => undefined);
    const { d, removed } = deps([row("a", 1), row("b", 2)], send);
    expect(await flushReplyOutbox(d)).toEqual({ sent: 2, dropped: 0, failed: false });
    expect(send.mock.calls.map((c) => c[1])).toEqual(["reply a", "reply b"]);
    expect(removed).toEqual(["a", "b"]);
  });

  it("stops at the first failure and keeps the rest for later", async () => {
    const send = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { d, removed, attempts } = deps([row("a", 1), row("b", 2)], send);
    expect(await flushReplyOutbox(d)).toEqual({ sent: 0, dropped: 0, failed: true });
    expect(send).toHaveBeenCalledOnce();
    expect(removed).toEqual([]);
    expect(attempts).toEqual(["a"]);
  });

  it("drops replies too old to be useful, and does nothing on a standby copy", async () => {
    const send = vi.fn(async () => undefined);
    const old = deps([row("old", 10 * MIN - OUTBOX_MAX_AGE_MS - 1)], send);
    expect(await flushReplyOutbox(old.d)).toEqual({ sent: 0, dropped: 1, failed: false });
    const standby = deps([row("a", 1)], send, false);
    expect(await flushReplyOutbox(standby.d)).toEqual({ sent: 0, dropped: 0, failed: false });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("recovering from a flagged network", () => {
  it("recovers after 3 passing health checks, at least 45s after the last failure", () => {
    const h = createNetworkHealth({ log: quiet });
    for (const t of [0, 10_000, 20_000]) h.noteFailure("x", t);
    h.noteProbe([], 30_000);
    h.noteProbe([], 45_000);
    h.noteProbe([], 60_000);
    expect(h.isDegraded(60_000)).toBe(true); // only 40s since the last failure
    h.noteProbe([], 75_000);
    expect(h.isDegraded(75_000)).toBe(false);
  });

  it("a failing check resets the count and counts as a failure", () => {
    const h = createNetworkHealth({ log: quiet });
    for (const t of [0, 10_000, 20_000]) h.noteFailure("x", t);
    h.noteProbe([], 70_000);
    h.noteProbe([], 85_000);
    h.noteProbe(["sendblue"], 100_000);
    expect(h.status(100_000)).toMatchObject({ degraded: true, probesPassed: 0, lastProbeFailures: ["sendblue"] });
    h.noteProbe([], 115_000);
    h.noteProbe([], 130_000);
    expect(h.isDegraded(130_000)).toBe(true);
    h.noteProbe([], 145_000);
    expect(h.isDegraded(145_000)).toBe(false);
  });

  it("the coordinator probes only while flagged, and a non-network check-in error isn't counted", async () => {
    const h = createNetworkHealth({ log: quiet });
    const probe = vi.fn(async () => [] as string[]);
    let fail: Error | null = new Error("Server Error: something broke");
    const identity: InstanceIdentity = { instanceId: "mac", label: "mac", platform: "darwin", priority: 100 };
    const coord = startInstanceCoordinator({
      identity,
      checkIn: async () => {
        if (fail) throw fail;
        return { activeInstanceId: "mac", instances: [] };
      },
      leave: async () => undefined,
      onActivate: () => undefined,
      onDeactivate: () => undefined,
      network: h,
      probe,
      intervalMs: 60 * MIN,
      log: quiet,
    });
    for (let i = 0; i < 4; i++) await coord.tick();
    expect(h.status().recentFailures).toBe(0);
    expect(probe).not.toHaveBeenCalled();

    fail = new TypeError("fetch failed");
    for (let i = 0; i < 3; i++) await coord.tick();
    expect(h.isDegraded()).toBe(true);
    fail = null;
    await coord.tick();
    expect(probe).toHaveBeenCalledTimes(1);
    await coord.stop();
  });
});

describe("probeNetwork", () => {
  it("counts any HTTP answer as reachable and names what got no answer", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("down")) throw new TypeError("fetch failed");
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
    const { probeNetwork } = await import("../server/network-health.js");
    expect(
      await probeNetwork(
        [
          { name: "up", url: "https://up.example/" },
          { name: "down", url: "https://down.example/" },
          { name: "skipped", url: undefined },
        ],
        { fetchImpl },
      ),
    ).toEqual(["down"]);
  });
});
