import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createKeepAwake,
  describeKeepAwake,
  KEEP_AWAKE_CAFFEINATE,
  restartCommand,
  type KeepAwakeStatus,
} from "../server/keep-awake.js";
import {
  activeBuildIds,
  wakeLockSource,
  wakeLockSourceLabel,
  WAKE_LOCK_BUILD_STATUSES,
} from "../server/keep-awake-labels.js";
import { createBuildWakeLockSync } from "../server/keep-awake-routes.js";
import { keepAwakeLabel, keepAwakePillLabel } from "../debug/src/components/KeepAwake.js";

class FakeChild extends EventEmitter {
  killed = false;
  constructor(public pid: number) {
    super();
  }
  kill(signal?: string) {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
}

function setup(platform: NodeJS.Platform = "darwin") {
  const children: FakeChild[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const spawn = vi.fn((_cmd: string, _args: string[]) => {
    const child = new FakeChild(700 + children.length);
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const controller = createKeepAwake({
    platform,
    pid: 4242,
    spawn,
    now: () => 1_000_000,
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    log: { log: () => {}, warn: () => {} },
  });
  return { controller, spawn, children, timers };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("build-triggered wake lock", () => {
  it("starts caffeinate as soon as a build is in progress, even with the toggle off", () => {
    const { controller, spawn } = setup();
    controller.setEnabled(false);
    controller.setBuilds(["b1"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(KEEP_AWAKE_CAFFEINATE, ["-dimsu", "-w", "4242"], { stdio: "ignore" });
    expect(controller.status()).toMatchObject({
      active: true,
      state: "active",
      enabled: false,
      userHold: false,
      buildHold: true,
      buildIds: ["b1"],
      heldBy: "build",
    });
  });

  it("holds it for a build even while this copy stands by (builds run on the Mac)", () => {
    const { controller, spawn } = setup();
    controller.setActiveCopy(false);
    controller.setBuilds(["b1"]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("releases it when the last build ends and the toggle is off", async () => {
    const { controller, children, timers } = setup();
    controller.setBuilds(["b1", "b2"]);
    controller.setBuilds(["b2"]);
    expect(children[0].killed).toBe(false);
    controller.setBuilds([]);
    expect(children[0].killed).toBe(true);
    await flush();
    expect(timers).toHaveLength(0); // No restart scheduled after a deliberate release.
    expect(controller.status()).toMatchObject({ active: false, state: "disabled", heldBy: null, buildIds: [] });
  });

  it("keeps the same caffeinate running when the build ends but the owner turned keep-awake on", async () => {
    const { controller, spawn, children } = setup();
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    controller.setBuilds(["b1"]);
    expect(spawn).toHaveBeenCalledTimes(1); // One caffeinate serves both.
    expect(controller.status().heldBy).toBe("both");
    controller.setBuilds([]);
    await flush();
    expect(children[0].killed).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(controller.status()).toMatchObject({ active: true, heldBy: "user", buildHold: false });
  });

  it("keeps holding for the build when the owner turns the toggle off mid-build", async () => {
    const { controller, children } = setup();
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    controller.setBuilds(["b1"]);
    controller.setEnabled(false);
    await flush();
    expect(children[0].killed).toBe(false);
    expect(controller.status()).toMatchObject({ active: true, heldBy: "build" });
    controller.setBuilds([]);
    expect(children[0].killed).toBe(true);
  });

  it("restarts caffeinate if it dies while a build holds it", () => {
    const { controller, spawn, children, timers } = setup();
    controller.setBuilds(["b1"]);
    children[0].emit("exit", 1, null);
    expect(controller.status()).toMatchObject({ state: "starting", heldBy: "build" });
    expect(timers).toHaveLength(1);
    timers.splice(0)[0].fn();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending restart when the build ends", () => {
    const { controller, spawn, children, timers } = setup();
    controller.setBuilds(["b1"]);
    children[0].emit("exit", 1, null);
    controller.setBuilds([]);
    expect(timers).toHaveLength(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("releases it on shutdown mid-build and never takes it back", async () => {
    const { controller, spawn, children } = setup();
    controller.setBuilds(["b1"]);
    controller.stop();
    expect(children[0].killed).toBe(true);
    await flush();
    controller.setBuilds(["b2"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(controller.status()).toMatchObject({ state: "stopped", active: false, heldBy: null });
  });

  it("does not respawn when the same builds are reported again", () => {
    const { controller, spawn } = setup();
    controller.setBuilds(["b1"]);
    controller.setBuilds(["b1"]);
    controller.setBuilds(["b1", "b1"]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op off macOS", () => {
    const { controller, spawn } = setup("linux");
    controller.setBuilds(["b1"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(controller.status()).toMatchObject({ state: "unsupported", buildHold: false, buildIds: [], heldBy: null });
  });
});

describe("which builds hold the wake lock", () => {
  it("counts queued through restarting, not finished or waiting-for-owner builds", () => {
    expect([...WAKE_LOCK_BUILD_STATUSES]).toEqual(["queued", "coding", "testing", "shipping", "restarting"]);
    const builds = [
      { buildId: "q", status: "queued", createdAt: 5 },
      { buildId: "c", status: "coding", createdAt: 1 },
      { buildId: "t", status: "testing", createdAt: 2 },
      { buildId: "s", status: "shipping", createdAt: 3 },
      { buildId: "r", status: "restarting", createdAt: 4 },
      { buildId: "p", status: "pr_open", createdAt: 6 },
      { buildId: "f", status: "failed", createdAt: 7 },
      { buildId: "x", status: "cancelled", createdAt: 8 },
      { buildId: "d", status: "shipped", createdAt: 9 },
      { buildId: "rb", status: "rolled_back", createdAt: 10 },
      { buildId: "q", status: "queued", createdAt: 5 }, // Listed by both queries.
    ];
    expect(activeBuildIds(builds)).toEqual(["c", "t", "s", "r", "q"]);
  });
});

describe("syncing builds from Convex", () => {
  it("applies the builds in progress, and releases once they finish", async () => {
    const { controller, spawn, children } = setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ buildId: "b1", status: "coding" }])
      .mockResolvedValueOnce([{ buildId: "b1", status: "shipped" }]);
    const sync = createBuildWakeLockSync(controller, list);
    await sync();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(controller.status().buildIds).toEqual(["b1"]);
    await sync();
    expect(children[0].killed).toBe(true);
    expect(controller.status().buildIds).toEqual([]);
  });

  it("ignores an answer that arrives after a newer one", async () => {
    const { controller } = setup();
    let resolveOld!: (v: { buildId: string; status: string }[]) => void;
    const list = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
      .mockResolvedValueOnce([]);
    const sync = createBuildWakeLockSync(controller, list);
    const old = sync();
    await sync();
    resolveOld([{ buildId: "b1", status: "coding" }]);
    await old;
    expect(controller.status().buildIds).toEqual([]);
  });

  it("keeps the previous builds when Convex can't be read", async () => {
    const { controller } = setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ buildId: "b1", status: "testing" }])
      .mockRejectedValueOnce(new Error("offline"));
    const sync = createBuildWakeLockSync(controller, list);
    await sync();
    await expect(sync()).rejects.toThrow("offline");
    expect(controller.status()).toMatchObject({ active: true, buildIds: ["b1"] });
  });

  it("doesn't query anything off macOS", async () => {
    const { controller } = setup("linux");
    const list = vi.fn();
    await createBuildWakeLockSync(controller, list)();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("holding the lock through the ship restart", () => {
  it("runs the restart script under caffeinate on macOS", () => {
    expect(restartCommand("/tmp/restart-b1.sh", "darwin", () => true)).toEqual({
      command: KEEP_AWAKE_CAFFEINATE,
      args: ["-dimsu", "/bin/bash", "/tmp/restart-b1.sh"],
    });
  });

  it("runs it plainly elsewhere or when caffeinate is missing", () => {
    expect(restartCommand("/x.sh", "linux", () => true)).toEqual({ command: "/bin/bash", args: ["/x.sh"] });
    expect(restartCommand("/x.sh", "darwin", () => false)).toEqual({ command: "/bin/bash", args: ["/x.sh"] });
  });
});

describe("who holds the wake lock, in words", () => {
  it("names the self-build agent and its build", () => {
    const h = { userHold: false, buildHold: true, buildIds: ["bmv123"] };
    expect(wakeLockSource(h)).toBe("build");
    expect(wakeLockSourceLabel(h)).toBe(
      "Awake: held by the self-build agent (build bmv123) while it works; will release when done",
    );
  });

  it("lists several builds, and copes with no ids", () => {
    expect(wakeLockSourceLabel({ userHold: false, buildHold: true, buildIds: ["a", "b"] })).toContain(
      "the self-build agent (builds a, b)",
    );
    expect(wakeLockSourceLabel({ userHold: false, buildHold: true, buildIds: [] })).toBe(
      "Awake: held by the self-build agent while it works; will release when done",
    );
  });

  it("says the owner turned it on", () => {
    const h = { userHold: true, buildHold: false, buildIds: [] };
    expect(wakeLockSource(h)).toBe("user");
    expect(wakeLockSourceLabel(h)).toBe("Awake: you turned this on");
  });

  it("says both when both apply", () => {
    const h = { userHold: true, buildHold: true, buildIds: ["b1"] };
    expect(wakeLockSource(h)).toBe("both");
    const label = wakeLockSourceLabel(h)!;
    expect(label).toContain("you turned this on");
    expect(label).toContain("the self-build agent (build b1)");
  });

  it("says nothing when nobody holds it", () => {
    expect(wakeLockSourceLabel({ userHold: false, buildHold: false, buildIds: [] })).toBeNull();
  });

  it("labels the controller's status for get_config, Settings and the dashboard pill", () => {
    const { controller } = setup();
    controller.setBuilds(["b1"]);
    let status = controller.status() as KeepAwakeStatus;
    expect(describeKeepAwake(status)).toContain("held by the self-build agent (build b1)");
    expect(keepAwakeLabel(status)).toContain("Awake: held by the self-build agent (build b1) while it works");
    expect(keepAwakePillLabel(status)).toBe("Awake: self-build agent (build b1)");

    controller.setEnabled(true);
    controller.setActiveCopy(true);
    status = controller.status();
    expect(keepAwakeLabel(status)).toContain("Awake: you turned this on, and the self-build agent (build b1)");
    expect(keepAwakePillLabel(status)).toBe("Awake: you + self-build agent (build b1)");

    controller.setBuilds([]);
    status = controller.status();
    expect(describeKeepAwake(status)).toContain("Awake: you turned this on");
    expect(keepAwakeLabel(status)).toMatch(/^Awake: you turned this on/);
    expect(keepAwakePillLabel(status)).toBe("Awake: you turned this on");
  });

  it("names the self-build agent while caffeinate is (re)starting", () => {
    const { controller, children } = setup();
    controller.setBuilds(["b1"]);
    children[0].emit("exit", 1, null);
    const status = controller.status();
    expect(keepAwakeLabel(status)).toBe("Restarting caffeinate for the self-build agent (build b1) (exited (code 1))");
    expect(describeKeepAwake(status)).toBe("Starting caffeinate for the self-build agent (build b1)…");
  });
});
