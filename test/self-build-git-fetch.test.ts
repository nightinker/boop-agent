import { describe, expect, it } from "vitest";
import { fetchOriginSerialized, isRefLockRace, type Runner, type Shell } from "../server/self-build/git-fetch.js";

// The failure from 7 Nov 2026 (self-build bmw6n4d2wfhts), as git printed it.
const LOCK_RACE_OUTPUT = `From https://github.com/nightinker/boop-agent
 * branch            main       -> FETCH_HEAD
error: cannot lock ref 'refs/remotes/origin/main': is at f345a9d58609077858dc8cf5e96c69d555ac3f88 but expected f1827cc13ebb44093490b3fbabbf305fd92b285b
 ! f1827cc..f345a9d  main       -> origin/main  (unable to update local ref)`;

const noSleep = async () => {};

describe("isRefLockRace", () => {
  it("recognises git losing a ref or lock-file race", () => {
    expect(isRefLockRace(LOCK_RACE_OUTPUT)).toBe(true);
    expect(isRefLockRace("fatal: Unable to create '/repo/.git/shallow.lock': File exists.")).toBe(true);
  });

  it("does not treat other fetch failures as a race", () => {
    expect(isRefLockRace("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host")).toBe(false);
    expect(isRefLockRace("fatal: couldn't find remote ref main")).toBe(false);
  });
});

describe("fetchOriginSerialized", () => {
  it("retries a lock race and succeeds once the other fetch has moved the ref", async () => {
    const results: Shell[] = [{ ok: false, output: LOCK_RACE_OUTPUT }, { ok: true, output: "" }];
    const calls: string[][] = [];
    const run: Runner = async (_cmd, args) => {
      calls.push(args);
      return results.shift()!;
    };
    const result = await fetchOriginSerialized(run, "/repo-retry", { sleep: noSleep });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([["fetch", "origin", "main"], ["fetch", "origin", "main"]]);
  });

  it("gives up after the retries and returns the last failure", async () => {
    let calls = 0;
    const run: Runner = async () => {
      calls++;
      return { ok: false, output: LOCK_RACE_OUTPUT };
    };
    const result = await fetchOriginSerialized(run, "/repo-giveup", { retries: 2, sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(calls).toBe(3);
  });

  it("does not retry a failure that is not a lock race", async () => {
    let calls = 0;
    const run: Runner = async () => {
      calls++;
      return { ok: false, output: "fatal: Could not resolve host: github.com" };
    };
    const result = await fetchOriginSerialized(run, "/repo-network", { sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("runs fetches of the same repository one at a time, even when one fails", async () => {
    let running = 0;
    let overlapped = false;
    const order: string[] = [];
    let n = 0;
    const run: Runner = async () => {
      const id = ++n;
      running++;
      if (running > 1) overlapped = true;
      order.push(`start ${id}`);
      await new Promise((done) => setTimeout(done, 5));
      order.push(`end ${id}`);
      running--;
      return id === 1 ? { ok: false, output: "fatal: network" } : { ok: true, output: "" };
    };
    const [a, b, c] = await Promise.all([
      fetchOriginSerialized(run, "/repo-serial", { sleep: noSleep }),
      fetchOriginSerialized(run, "/repo-serial/.", { sleep: noSleep }),
      fetchOriginSerialized(run, "/repo-serial", { sleep: noSleep }),
    ]);
    expect(overlapped).toBe(false);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
    expect([a.ok, b.ok, c.ok]).toEqual([false, true, true]);
  });

  it("lets different repositories fetch at the same time", async () => {
    let running = 0;
    let maxRunning = 0;
    const run: Runner = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((done) => setTimeout(done, 5));
      running--;
      return { ok: true, output: "" };
    };
    await Promise.all([
      fetchOriginSerialized(run, "/repo-one", { sleep: noSleep }),
      fetchOriginSerialized(run, "/repo-two", { sleep: noSleep }),
    ]);
    expect(maxRunning).toBe(2);
  });
});
