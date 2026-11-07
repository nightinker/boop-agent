import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, createUpdateBackoff, updatePlan, type Run } from "../server/self-update.js";

const quiet = { log: () => undefined, warn: () => undefined };

/** A fake git/npm: answers by command, records every call. */
function fakeRun(opts: { head: string; target: string; changed?: string[]; dirty?: boolean; ancestor?: boolean; failOn?: string }) {
  const calls: string[] = [];
  const run: Run = async (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (opts.failOn && line.includes(opts.failOn)) throw new Error(`${opts.failOn} broke`);
    if (line === "git rev-parse HEAD") return opts.head;
    if (line.startsWith("git rev-parse origin/")) return opts.target;
    if (line.startsWith("git merge-base")) {
      if (opts.ancestor === false) throw new Error("not ancestor");
      return "";
    }
    if (line.startsWith("git status")) return opts.dirty ? " M server/index.ts" : "";
    if (line.startsWith("git diff --name-only")) return (opts.changed ?? []).join("\n");
    return "";
  };
  return { run, calls };
}

describe("what an update needs", () => {
  it("reinstalls only when dependencies change, and rebuilds the dashboard when it changes", () => {
    expect(updatePlan(["server/index.ts"])).toEqual({ install: false, dashboard: false, convex: false });
    expect(updatePlan(["debug/src/App.tsx"])).toEqual({ install: false, dashboard: true, convex: false });
    expect(updatePlan(["package-lock.json"])).toEqual({ install: true, dashboard: true, convex: false });
  });
});

describe("updating the server", () => {
  it("does nothing when already current", async () => {
    const { run } = fakeRun({ head: "aaa", target: "aaa" });
    expect(await checkForUpdate({ run, log: quiet })).toEqual({ status: "current" });
  });

  it("moves to the new commit and restarts", async () => {
    const { run, calls } = fakeRun({ head: "aaa1111", target: "bbb2222", changed: ["server/x.ts"] });
    const restart = vi.fn();
    expect(await checkForUpdate({ run, restart, log: quiet })).toEqual({ status: "updated", from: "aaa1111", to: "bbb2222" });
    expect(calls).toContain("git checkout --quiet --detach bbb2222");
    expect(calls.some((c) => c.startsWith("npm"))).toBe(false);
    expect(restart).toHaveBeenCalledWith("aaa1111", "bbb2222");
  });

  it("installs dependencies and rebuilds the dashboard when needed", async () => {
    const { run, calls } = fakeRun({ head: "a", target: "b", changed: ["package-lock.json"] });
    await checkForUpdate({ run, restart: () => undefined, log: quiet });
    expect(calls).toContain("npm install --no-audit --no-fund");
    expect(calls).toContain("npm run dashboard:build");
  });

  it("waits while a text is being answered", async () => {
    const { run, calls } = fakeRun({ head: "a", target: "b" });
    expect(await checkForUpdate({ run, isBusy: () => true, log: quiet })).toEqual({ status: "busy" });
    expect(calls.some((c) => c.includes("checkout"))).toBe(false);
  });

  it("won't touch local changes or commits that aren't on main", async () => {
    expect(await checkForUpdate({ run: fakeRun({ head: "a", target: "b", dirty: true }).run, log: quiet })).toEqual({ status: "dirty" });
    expect(await checkForUpdate({ run: fakeRun({ head: "a", target: "b", ancestor: false }).run, log: quiet })).toEqual({ status: "dirty" });
  });

  it("goes back to the old code and keeps running if a step fails", async () => {
    const { run, calls } = fakeRun({ head: "aaa", target: "bbb", changed: ["debug/x.tsx"], failOn: "dashboard:build" });
    const restart = vi.fn();
    const result = await checkForUpdate({ run, restart, log: quiet });
    expect(result).toMatchObject({ status: "failed" });
    expect(calls).toContain("git checkout --quiet --detach aaa");
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("pushing Convex functions on update", () => {
  it("is off unless asked for: the code updates, nothing is pushed", async () => {
    const { run, calls } = fakeRun({ head: "aaa", target: "bbb", changed: ["convex/selfBuilds.ts"] });
    const restart = vi.fn();
    const result = await checkForUpdate({ run, restart, log: quiet });
    expect(result).toEqual({ status: "updated", from: "aaa", to: "bbb", convexPush: "skipped" });
    expect(calls.some((c) => c.startsWith("npx convex"))).toBe(false);
    expect(restart).toHaveBeenCalled();
  });

  it("a failed push keeps the new code instead of undoing it", async () => {
    const { run, calls } = fakeRun({ head: "aaa", target: "bbb", changed: ["convex/selfBuilds.ts"], failOn: "npx convex" });
    const restart = vi.fn();
    const result = await checkForUpdate({ run, restart, pushConvex: true, log: quiet });
    expect(result).toEqual({ status: "updated", from: "aaa", to: "bbb", convexPush: "failed" });
    expect(calls).not.toContain("git checkout --quiet --detach aaa");
    expect(restart).toHaveBeenCalledWith("aaa", "bbb");
  });
});

describe("backing off after a failed update", () => {
  it("leaves a commit that failed alone for a while, longer each time", async () => {
    let now = 0;
    const backoff = createUpdateBackoff(5 * 60_000, () => now);
    backoff.note({ status: "failed", target: "bbb", error: "npm broke" });
    expect(backoff.skip("bbb")).toBe(true);
    expect(backoff.skip("ccc")).toBe(false); // a new commit is tried at once
    now = 5 * 60_000;
    expect(backoff.skip("bbb")).toBe(false);
    backoff.note({ status: "failed", target: "bbb", error: "npm broke" });
    now += 9 * 60_000;
    expect(backoff.skip("bbb")).toBe(true); // second failure waits 10 minutes
    now += 2 * 60_000;
    expect(backoff.skip("bbb")).toBe(false);
  });

  it("skips the commit without touching the checkout", async () => {
    const { run, calls } = fakeRun({ head: "aaa", target: "bbb", changed: ["package-lock.json"] });
    expect(await checkForUpdate({ run, skipTarget: (t) => t === "bbb", log: quiet })).toEqual({ status: "backoff", target: "bbb" });
    expect(calls.some((c) => c.includes("checkout") || c.startsWith("npm"))).toBe(false);
  });
});
