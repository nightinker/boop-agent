import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, updatePlan, type Run } from "../server/self-update.js";

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
