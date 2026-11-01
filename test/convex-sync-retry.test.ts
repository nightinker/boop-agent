import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  backoffDelay,
  isNetworkReachable,
  waitForNetwork,
  retryWithBackoff,
  restartOnFailure,
} = require("../scripts/convex-sync-retry.cjs");

// A fake clock: sleep() advances time instantly so retries run without waiting.
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const fetchFailed = () => new Error("Unexpected error when authorizing - are you connected to the internet? TypeError: fetch failed");

describe("backoffDelay", () => {
  it("doubles from the base and caps at the max", () => {
    const opts = { baseMs: 1000, maxMs: 5000 };
    expect([1, 2, 3, 4, 5].map((n) => backoffDelay(n, opts))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
});

describe("isNetworkReachable", () => {
  it("treats any HTTP response as online and a thrown fetch as offline", async () => {
    expect(await isNetworkReachable({ fetchImpl: async () => new Response(null, { status: 404 }) })).toBe(true);
    expect(
      await isNetworkReachable({
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).toBe(false);
  });
});

describe("waitForNetwork", () => {
  it("polls until online and announces the wait once", async () => {
    const clock = fakeClock();
    const answers = [false, false, true];
    const onWaiting = vi.fn();
    const ok = await waitForNetwork({ isOnline: async () => answers.shift(), onWaiting, intervalMs: 1000, ...clock });
    expect(ok).toBe(true);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it("gives up after the timeout", async () => {
    const clock = fakeClock();
    const ok = await waitForNetwork({ isOnline: async () => false, intervalMs: 1000, timeoutMs: 3000, ...clock });
    expect(ok).toBe(false);
    expect(clock.now()).toBeLessThanOrEqual(3000);
  });
});

describe("retryWithBackoff", () => {
  it("retries a fetch-failed sync with backoff until it succeeds", async () => {
    const clock = fakeClock();
    let calls = 0;
    const onAttemptFailed = vi.fn();
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw fetchFailed();
      },
      { isOnline: async () => true, baseMs: 1000, maxMs: 10_000, budgetMs: 120_000, onAttemptFailed, ...clock },
    );
    expect(result).toEqual({ ok: true, attempts: 3 });
    expect(clock.sleeps).toEqual([1000, 2000]);
    expect(onAttemptFailed.mock.calls.map((c) => c[2])).toEqual([1000, 2000]);
  });

  it("waits for the network before the first attempt", async () => {
    const clock = fakeClock();
    const online = [false, false, true, true];
    const task = vi.fn(async () => {});
    const onWaitingForNetwork = vi.fn();
    const result = await retryWithBackoff(task, {
      isOnline: async () => online.shift() ?? true,
      networkPollMs: 2000,
      onWaitingForNetwork,
      ...clock,
    });
    expect(result.ok).toBe(true);
    expect(onWaitingForNetwork).toHaveBeenCalledTimes(1);
    expect(task).toHaveBeenCalledTimes(1);
    expect(clock.now()).toBe(4000);
  });

  it("stops after the budget and returns the last error instead of throwing", async () => {
    const clock = fakeClock();
    const onAttemptFailed = vi.fn();
    const result = await retryWithBackoff(
      async () => {
        throw fetchFailed();
      },
      { isOnline: async () => true, baseMs: 2000, maxMs: 30_000, budgetMs: 60_000, onAttemptFailed, ...clock },
    );
    expect(result.ok).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.error.message).toMatch(/fetch failed/);
    expect(result.attempts).toBeGreaterThan(1);
    expect(clock.now()).toBeLessThanOrEqual(60_000);
    // The last failure reports no further retry.
    expect(onAttemptFailed.mock.calls.at(-1)?.[2]).toBeNull();
  });

  it("still makes an attempt when the network never comes back", async () => {
    const clock = fakeClock();
    const task = vi.fn(async () => {
      throw fetchFailed();
    });
    const result = await retryWithBackoff(task, { isOnline: async () => false, budgetMs: 10_000, ...clock });
    expect(result.ok).toBe(false);
    expect(task).toHaveBeenCalled();
  });

  it("stops early when asked to", async () => {
    const clock = fakeClock();
    let stop = false;
    const task = vi.fn(async () => {
      stop = true;
      throw fetchFailed();
    });
    const result = await retryWithBackoff(task, { isOnline: async () => true, shouldStop: () => stop, ...clock });
    expect(result).toMatchObject({ ok: false, stopped: true, attempts: 1 });
  });
});

describe("restartOnFailure", () => {
  type FakeChild = EventEmitter & { ready: Promise<void>; markReady: () => void };
  function fakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.ready = new Promise((resolve) => (child.markReady = resolve));
    return child;
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("restarts the Convex watcher after a failed exit instead of giving up", async () => {
    const children: FakeChild[] = [];
    const log = vi.fn();
    const sleeps: number[] = [];
    const supervisor = restartOnFailure({
      start: () => {
        const c = fakeChild();
        children.push(c);
        return c;
      },
      isOnline: async () => true,
      sleep: async (ms: number) => void sleeps.push(ms),
      log,
      baseMs: 1000,
    });
    expect(children).toHaveLength(1);

    children[0].emit("exit", 1);
    await flush();
    expect(children).toHaveLength(2);
    expect(supervisor.current()).toBe(children[1]);
    expect(log.mock.calls[0][0]).toMatch(/server keeps running/);

    children[1].emit("exit", 1);
    await flush();
    expect(children).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);

    // Once a child syncs, the backoff resets.
    children[2].markReady();
    await flush();
    children[2].emit("exit", 1);
    await flush();
    expect(sleeps.at(-1)).toBe(1000);
  });

  it("keeps a crashed ngrok tunnel alive and reports each relaunch", async () => {
    // ngrok panics on a flaky network; Boop restarts it rather than stopping.
    const children: FakeChild[] = [];
    const log = vi.fn();
    const relaunched: FakeChild[] = [];
    restartOnFailure({
      start: () => {
        const c = fakeChild();
        children.push(c);
        return c;
      },
      label: "ngrok",
      onRelaunch: (c: FakeChild) => relaunched.push(c),
      isOnline: async () => true,
      sleep: async () => {},
      log,
    });
    expect(relaunched).toEqual([]);
    children[0].emit("exit", 2);
    await flush();
    expect(children).toHaveLength(2);
    expect(relaunched).toEqual([children[1]]);
    expect(log.mock.calls[0][0]).toMatch(/^ngrok exited with code 2; the server keeps running/);
  });

  it("does not restart on a clean exit, a signal, or during shutdown", async () => {
    let shuttingDown = false;
    const children: FakeChild[] = [];
    restartOnFailure({
      start: () => {
        const c = fakeChild();
        children.push(c);
        return c;
      },
      isShuttingDown: () => shuttingDown,
      isOnline: async () => true,
      sleep: async () => {},
    });
    children[0].emit("exit", 0);
    children[0].emit("exit", null);
    shuttingDown = true;
    children[0].emit("exit", 1);
    await flush();
    expect(children).toHaveLength(1);
  });
});
