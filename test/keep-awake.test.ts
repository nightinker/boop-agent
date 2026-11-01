import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createKeepAwake, describeKeepAwake, KEEP_AWAKE_CAFFEINATE } from "../server/keep-awake.js";
import { getKeepAwakeEnabled } from "../server/runtime-config.js";

class FakeChild extends EventEmitter {
  killed = false;
  constructor(public pid: number) {
    super();
  }
  kill(signal?: string) {
    this.killed = true;
    // Like a real child, the exit event follows the kill.
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
}

function setup(platform: NodeJS.Platform = "darwin") {
  let clock = 1_000_000;
  const children: FakeChild[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const spawn = vi.fn((_cmd: string, _args: string[]) => {
    const child = new FakeChild(500 + children.length);
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const controller = createKeepAwake({
    platform,
    pid: 4242,
    spawn,
    now: () => clock,
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
  const runTimers = () => {
    for (const t of timers.splice(0)) t.fn();
  };
  return { controller, spawn, children, timers, runTimers, advance: (ms: number) => (clock += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("keep Mac awake", () => {
  it("spawns caffeinate -dimsu tied to Boop's pid once enabled and active", () => {
    const { controller, spawn } = setup();
    controller.setEnabled(true);
    expect(spawn).not.toHaveBeenCalled(); // Not the active copy yet.
    controller.setActiveCopy(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(KEEP_AWAKE_CAFFEINATE, ["-dimsu", "-w", "4242"], { stdio: "ignore" });
    const status = controller.status();
    expect(status).toMatchObject({ supported: true, enabled: true, active: true, state: "active", since: 1_000_000, pid: 500 });
    expect(describeKeepAwake(status)).toContain("since");
  });

  it("does not spawn a second caffeinate when settings are re-applied", () => {
    const { controller, spawn } = setup();
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("restarts caffeinate when it exits unexpectedly, backing off", () => {
    const { controller, spawn, children, timers, runTimers, advance } = setup();
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    children[0].emit("exit", 1, null);
    expect(controller.status()).toMatchObject({ active: false, state: "starting", lastError: "exited (code 1)" });
    expect(timers.map((t) => t.ms)).toEqual([1_000]);
    runTimers();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(controller.status()).toMatchObject({ active: true, pid: 501, restarts: 1 });

    children[1].emit("exit", null, "SIGKILL");
    expect(timers.map((t) => t.ms)).toEqual([2_000]);
    runTimers();
    // A run that lasted a while resets the delay.
    advance(120_000);
    children[2].emit("exit", 0, null);
    expect(timers.map((t) => t.ms)).toEqual([1_000]);
  });

  it("retries when caffeinate can't be spawned at all", () => {
    const { controller, spawn, timers } = setup();
    spawn.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    expect(controller.status()).toMatchObject({ active: false, lastError: "ENOENT" });
    expect(timers).toHaveLength(1);
  });

  it("kills caffeinate on shutdown and never restarts it", async () => {
    const { controller, spawn, children, timers } = setup();
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    controller.stop();
    expect(children[0].killed).toBe(true);
    await flush(); // Its exit event arrives after the kill.
    expect(timers).toHaveLength(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(controller.status()).toMatchObject({ active: false, state: "stopped", pid: null });
    controller.setActiveCopy(false);
    controller.setActiveCopy(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending restart on shutdown", () => {
    const { controller, spawn, children, timers } = setup();
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    children[0].emit("exit", 1, null);
    expect(timers).toHaveLength(1);
    controller.stop();
    expect(timers).toHaveLength(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("releases the wake lock when this copy steps down to standby, and takes it back", async () => {
    const { controller, spawn, children, timers } = setup();
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    controller.setActiveCopy(false);
    expect(children[0].killed).toBe(true);
    await flush();
    expect(timers).toHaveLength(0);
    expect(controller.status()).toMatchObject({ active: false, state: "standby" });
    controller.setActiveCopy(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("releases it when the owner turns the setting off", async () => {
    const { controller, children, timers } = setup();
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    controller.setEnabled(false);
    expect(children[0].killed).toBe(true);
    await flush();
    expect(timers).toHaveLength(0);
    expect(controller.status()).toMatchObject({ enabled: false, active: false, state: "disabled" });
  });

  it("is a no-op off macOS", () => {
    const { controller, spawn, timers } = setup("linux");
    controller.setEnabled(true);
    controller.setActiveCopy(true);
    controller.stop();
    expect(spawn).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
    const status = controller.status();
    expect(status).toMatchObject({ supported: false, enabled: false, active: false, state: "unsupported" });
    expect(describeKeepAwake(status)).toContain("macOS");
  });

  it("the setting reads as off on Linux without touching Convex", async () => {
    await expect(getKeepAwakeEnabled("linux")).resolves.toBe(false);
  });
});
