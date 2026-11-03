import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const convexMock = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));

vi.mock("../server/convex-client.js", () => ({ convex: convexMock }));
vi.mock("../server/notify.js", () => ({ notifyConversation: vi.fn() }));

import { KEEP_FAILED_WORKTREE_MS, worktreesToPrune } from "../server/self-build/plan.js";
import { pruneWorktrees } from "../server/self-build/run.js";

const now = 1_000_000_000_000;
const fresh = now - 60_000;
const stale = now - KEEP_FAILED_WORKTREE_MS - 60_000;

describe("worktreesToPrune", () => {
  const prune = (
    worktrees: { name: string; mtimeMs: number }[],
    builds: Record<string, { status: string; prUrl?: string } | null>,
    installBusy = false,
  ) => worktreesToPrune({ worktrees, builds, installBusy, now }).sort();

  it("removes a build's worktree once its PR is open, shipped or rolled back", () => {
    const pr = "https://github.com/o/r/pull/1";
    expect(
      prune(
        [
          { name: "self-build-a", mtimeMs: fresh },
          { name: "self-build-b", mtimeMs: fresh },
          { name: "self-build-c", mtimeMs: fresh },
        ],
        { a: { status: "pr_open", prUrl: pr }, b: { status: "shipped", prUrl: pr }, c: { status: "rolled_back", prUrl: pr } },
      ),
    ).toEqual(["self-build-a", "self-build-b", "self-build-c"]);
  });

  it("removes a cancelled build's worktree", () => {
    expect(prune([{ name: "self-build-a", mtimeMs: fresh }], { a: { status: "cancelled" } })).toEqual(["self-build-a"]);
  });

  it("never touches a build that is still running", () => {
    const worktrees = ["queued", "coding", "testing", "shipping", "restarting"].map((status) => ({
      name: `self-build-${status}`,
      mtimeMs: stale,
    }));
    const builds = Object.fromEntries(
      ["queued", "coding", "testing", "shipping", "restarting"].map((status) => [status, { status, prUrl: "x" }]),
    );
    expect(prune(worktrees, builds)).toEqual([]);
  });

  it("keeps a failed build without a PR for a few days, then removes it", () => {
    expect(prune([{ name: "self-build-a", mtimeMs: fresh }], { a: { status: "failed" } })).toEqual([]);
    expect(prune([{ name: "self-build-a", mtimeMs: stale }], { a: { status: "failed" } })).toEqual(["self-build-a"]);
  });

  it("removes a worktree whose build Convex no longer knows, only once it is old", () => {
    expect(prune([{ name: "self-build-gone", mtimeMs: fresh }], { gone: null })).toEqual([]);
    expect(prune([{ name: "self-build-gone", mtimeMs: stale }], { gone: null })).toEqual(["self-build-gone"]);
  });

  it("removes release worktrees unless an install may still need one", () => {
    const worktrees = [
      { name: "self-build-release-a", mtimeMs: fresh },
      { name: "self-build-release-update-1234567", mtimeMs: fresh },
    ];
    expect(prune(worktrees, {})).toEqual(["self-build-release-a", "self-build-release-update-1234567"]);
    expect(prune(worktrees, {}, true)).toEqual([]);
  });

  it("leaves worktrees that are not Boop's alone", () => {
    expect(
      prune(
        [
          { name: "feature-x", mtimeMs: stale },
          { name: "release-main", mtimeMs: stale },
        ],
        {},
      ),
    ).toEqual([]);
  });
});

describe("pruneWorktrees", () => {
  let src = "";
  let shared = "";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: src, stdio: "pipe" }).toString();

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "boop-prune-"));
    shared = mkdtempSync(join(tmpdir(), "boop-shared-modules-"));
    writeFileSync(join(shared, "keep.txt"), "the main checkout's node_modules");
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    mkdirSync(join(src, ".claude", "worktrees"), { recursive: true });
    for (const name of ["self-build-done", "self-build-busy", "self-build-release-done", "someone-elses"]) {
      git("worktree", "add", "-q", "--detach", join(src, ".claude", "worktrees", name));
    }
    symlinkSync(shared, join(src, ".claude", "worktrees", "self-build-release-done", "node_modules"), "dir");
    convexMock.query.mockReset();
  });

  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  });

  it("removes finished worktrees, keeps running and foreign ones, and leaves borrowed node_modules intact", async () => {
    convexMock.query.mockImplementation(async (_ref: unknown, args?: { buildId?: string; limit?: number }) => {
      if (args?.limit) return [{ status: "pr_open" }];
      return args?.buildId === "busy" ? { status: "coding" } : { status: "pr_open", prUrl: "https://github.com/o/r/pull/9" };
    });

    await pruneWorktrees(src);

    const dir = join(src, ".claude", "worktrees");
    expect(existsSync(join(dir, "self-build-done"))).toBe(false);
    expect(existsSync(join(dir, "self-build-release-done"))).toBe(false);
    expect(existsSync(join(dir, "self-build-busy"))).toBe(true);
    expect(existsSync(join(dir, "someone-elses"))).toBe(true);
    expect(existsSync(join(shared, "keep.txt"))).toBe(true);
    expect(git("worktree", "list")).not.toContain("self-build-done");
  });

  it("deletes nothing when Convex can't be reached", async () => {
    convexMock.query.mockRejectedValue(new Error("offline"));

    await pruneWorktrees(src);

    expect(existsSync(join(src, ".claude", "worktrees", "self-build-done"))).toBe(true);
    expect(existsSync(join(src, ".claude", "worktrees", "self-build-release-done"))).toBe(true);
  });

  it("keeps release worktrees while an install is in progress", async () => {
    convexMock.query.mockImplementation(async (_ref: unknown, args?: { limit?: number }) =>
      args?.limit ? [{ status: "restarting" }] : { status: "pr_open", prUrl: "x" },
    );

    await pruneWorktrees(src);

    expect(existsSync(join(src, ".claude", "worktrees", "self-build-release-done"))).toBe(true);
    expect(existsSync(join(src, ".claude", "worktrees", "self-build-done"))).toBe(false);
  });
});
