import { afterEach, describe, expect, it, vi } from "vitest";
import { pickActive, type InstanceRow } from "../convex/instanceRules.js";
import {
  decideActive,
  instanceIdentity,
  instancePromptNote,
  isActiveInstance,
  resetInstanceState,
  startInstanceCoordinator,
  type InstanceSummary,
} from "../server/instance.js";
import { createInboundQueue } from "../server/inbound-queue.js";
import { memoryInboundStore, text } from "./memory-inbound-store.js";

const now = 1_000_000;
const row = (id: string, priority: number, seenAgo: number, startedAt = 0): InstanceRow => ({
  instanceId: id,
  label: id,
  platform: id.startsWith("mac") ? "darwin" : "linux",
  priority,
  startedAt,
  lastSeenAt: now - seenAgo,
});

afterEach(() => resetInstanceState());

describe("choosing the active copy", () => {
  it("prefers the Mac while it's online", () => {
    expect(pickActive([row("server", 10, 1_000), row("mac", 100, 5_000)], now)?.instanceId).toBe("mac");
  });

  it("falls back to the server when the Mac stops checking in", () => {
    expect(pickActive([row("server", 10, 1_000), row("mac", 100, 60_000)], now)?.instanceId).toBe("server");
  });

  it("has no active copy when everyone is offline, and breaks ties by who started first", () => {
    expect(pickActive([row("mac", 100, 60_000)], now)).toBeNull();
    expect(pickActive([row("b", 10, 0, 5), row("a", 10, 0, 9)], now)?.instanceId).toBe("b");
  });
});

const summary = (active: string | null, online: string[]): InstanceSummary => ({
  activeInstanceId: active,
  instances: ["mac", "server"].map((id) => ({
    instanceId: id,
    label: id,
    platform: id === "mac" ? "darwin" : "linux",
    priority: id === "mac" ? 100 : 10,
    publicUrl: null,
    lastSeenAt: now,
    online: online.includes(id),
  })),
});

describe("becoming active", () => {
  it("starts at once when no other copy is online", () => {
    const d = decideActive({ summary: summary("server", ["server"]), instanceId: "server", activeSeenAt: null, othersWereOnline: false, now });
    expect(d).toMatchObject({ active: true, waitMs: 0 });
  });

  it("waits for the copy stepping down before starting", () => {
    const first = decideActive({ summary: summary("mac", ["mac", "server"]), instanceId: "mac", activeSeenAt: null, othersWereOnline: false, now, graceMs: 20_000 });
    expect(first).toMatchObject({ active: false, waitMs: 20_000 });
    const later = decideActive({
      summary: summary("mac", ["mac", "server"]),
      instanceId: "mac",
      activeSeenAt: first.activeSeenAt,
      othersWereOnline: first.othersWereOnline,
      now: now + 20_000,
      graceMs: 20_000,
    });
    expect(later.active).toBe(true);
  });

  it("stands by when another copy is active", () => {
    const d = decideActive({ summary: summary("mac", ["mac", "server"]), instanceId: "server", activeSeenAt: now - 99_000, othersWereOnline: false, now });
    expect(d).toMatchObject({ active: false, activeSeenAt: null });
  });
});

describe("the coordinator", () => {
  it("switches work on and off as the active copy changes, and hands over on stop", async () => {
    const identity = { instanceId: "server", label: "the linux server", platform: "linux", priority: 10, startedAt: 0 };
    let reply = summary("server", ["server"]);
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();
    const leave = vi.fn(async () => undefined);
    const c = startInstanceCoordinator({
      identity,
      checkIn: async () => reply,
      leave,
      onActivate,
      onDeactivate,
      intervalMs: 60_000,
      log: { log: () => undefined, warn: () => undefined },
    });
    await c.tick();
    expect(isActiveInstance()).toBe(true);
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ othersOnline: false }));

    reply = summary("mac", ["mac", "server"]); // the Mac is back
    await c.tick();
    expect(isActiveInstance()).toBe(false);
    expect(onDeactivate).toHaveBeenCalledTimes(1);

    await c.stop();
    expect(leave).toHaveBeenCalledWith("server");
  });

  it("keeps its role when a check-in fails", async () => {
    const identity = { instanceId: "mac", label: "the Mac", platform: "darwin", priority: 100, startedAt: 0 };
    let fail = false;
    const c = startInstanceCoordinator({
      identity,
      checkIn: async () => {
        if (fail) throw new Error("offline");
        return summary("mac", ["mac"]);
      },
      leave: async () => undefined,
      onActivate: () => undefined,
      onDeactivate: () => undefined,
      intervalMs: 60_000,
      log: { log: () => undefined, warn: () => undefined },
    });
    await c.tick();
    fail = true;
    await c.tick();
    expect(isActiveInstance()).toBe(true);
    await c.stop();
  });

  it("stands by after losing contact for as long as the others wait, then catches up when it's back", async () => {
    // The Mac with its lid shut: check-ins fail long enough that the server
    // takes over. When the network returns it must run onActivate again, which
    // is what starts the self-builds queued meanwhile.
    const identity = { instanceId: "mac", label: "the Mac", platform: "darwin", priority: 100, startedAt: 0 };
    let clock = now;
    let reply: InstanceSummary | null = summary("mac", ["mac"]);
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();
    const c = startInstanceCoordinator({
      identity,
      checkIn: async () => {
        if (!reply) throw new Error("fetch failed");
        return reply;
      },
      leave: async () => undefined,
      onActivate,
      onDeactivate,
      intervalMs: 60_000,
      graceMs: 20_000,
      offlineAfterMs: 45_000,
      now: () => clock,
      log: { log: () => undefined, warn: () => undefined },
    });
    await c.tick();
    expect(onActivate).toHaveBeenCalledTimes(1);

    reply = null; // lid shut, no network
    clock += 30_000;
    await c.tick();
    expect(isActiveInstance()).toBe(true); // a short blip keeps the role
    clock += 30_000;
    await c.tick();
    expect(isActiveInstance()).toBe(false);
    expect(onDeactivate).toHaveBeenCalledTimes(1);

    reply = summary("mac", ["mac", "server"]); // back online; the server steps down
    clock += 1_000;
    await c.tick();
    clock += 20_000;
    await c.tick();
    expect(isActiveInstance()).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(2);
    await c.stop();
  });
});

describe("knowing where it runs", () => {
  it("names the Mac and the server, with the Mac first", () => {
    expect(instanceIdentity({}, "darwin", "studio-mbp.local", 5)).toEqual({
      instanceId: "darwin:studio-mbp",
      label: "the owner's Mac (studio-mbp)",
      platform: "darwin",
      priority: 100,
      startedAt: 5,
    });
    expect(instanceIdentity({}, "linux", "vps1", 5)).toMatchObject({ instanceId: "linux:vps1", priority: 10 });
    expect(instanceIdentity({ BOOP_INSTANCE_PRIORITY: "200", BOOP_INSTANCE_LABEL: "Studio" }, "linux", "x").priority).toBe(200);
  });

  it("tells Boop which copy it is, whether it's active, and what needs the Mac", async () => {
    const identity = instanceIdentity({}, "linux", "vps1");
    const c = startInstanceCoordinator({
      identity,
      checkIn: async () => ({
        activeInstanceId: identity.instanceId,
        instances: [
          { instanceId: identity.instanceId, label: identity.label, platform: "linux", priority: 10, publicUrl: null, lastSeenAt: now, online: true },
          { instanceId: "darwin:mbp", label: "the owner's Mac (mbp)", platform: "darwin", priority: 100, publicUrl: null, lastSeenAt: 0, online: false },
        ],
      }),
      leave: async () => undefined,
      onActivate: () => undefined,
      onDeactivate: () => undefined,
      intervalMs: 60_000,
      log: { log: () => undefined, warn: () => undefined },
    });
    await c.tick();
    const note = instancePromptNote();
    expect(note).toContain("you are Boop's copy on the linux server (vps1)");
    expect(note).toContain("the owner's Mac (mbp): offline");
    expect(note).toContain("You are the active copy right now.");
    expect(note).toContain("Self-builds code and ship on the Mac");
    await c.stop();
  });

  it("adds nothing before coordination starts", () => {
    expect(instancePromptNote()).toBe("");
  });
});

describe("a standby copy and incoming texts", () => {
  it("saves texts but leaves answering to the active copy, then catches up when it takes over", async () => {
    const { store, rows } = memoryInboundStore();
    let active = false;
    const seen: string[] = [];
    const queue = createInboundQueue({
      store,
      process: async (item) => void seen.push(item.content),
      isActive: () => active,
      log: { error: () => undefined, warn: () => undefined },
    });
    expect(await queue.enqueue(text("a", "while standing by"))).toBe(true);
    await queue.drain("sms:a");
    expect(seen).toEqual([]);
    expect(rows[0]!.status).toBe("queued");

    active = true; // the Mac went offline; this copy takes over
    await queue.drainAll();
    expect(seen).toEqual(["while standing by"]);
  });
});
