import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { appCommit, newerFunctionsOnMain } = require("../scripts/convex-push-guard.cjs") as {
  appCommit: (opts: { appDir?: string; home?: string }) => string | null;
  newerFunctionsOnMain: (opts: { sourceDir?: string; commit: string | null }) => Promise<{ skip: boolean; target?: string }>;
};
const { stampBuildInfo } = require("../scripts/stamp-build-info.cjs") as {
  stampBuildInfo: (root: string) => string | null;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

let root: string;
let other: string;
let mac: string;

function landOnMain(file: string): string {
  mkdirSync(join(other, file, ".."), { recursive: true });
  writeFileSync(join(other, file), file);
  git(other, "add", file);
  git(other, "commit", "-q", "-m", `change ${file}`);
  git(other, "push", "-q", "origin", "HEAD:main");
  return git(other, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "boop-push-guard-"));
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });
  other = join(root, "other");
  execFileSync("git", ["clone", "-q", origin, other], { stdio: "pipe" });
  landOnMain("README.md");
  mac = join(root, "mac");
  execFileSync("git", ["clone", "-q", origin, mac], { stdio: "pipe" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the Mac's Convex push guard", () => {
  it("skips the push when main is ahead of this app and changed convex/", async () => {
    const app = git(mac, "rev-parse", "HEAD");
    const target = landOnMain("convex/selfBuilds.ts");
    expect(await newerFunctionsOnMain({ sourceDir: mac, commit: app })).toEqual({ skip: true, target });
  });

  it("pushes when main is ahead but Convex functions didn't change", async () => {
    const app = git(mac, "rev-parse", "HEAD");
    landOnMain("server/index.ts");
    expect((await newerFunctionsOnMain({ sourceDir: mac, commit: app })).skip).toBe(false);
  });

  it("pushes when this app is main, or nothing is known", async () => {
    const app = landOnMain("convex/selfBuilds.ts");
    expect((await newerFunctionsOnMain({ sourceDir: mac, commit: app })).skip).toBe(false);
    expect((await newerFunctionsOnMain({ sourceDir: mac, commit: null })).skip).toBe(false);
    expect((await newerFunctionsOnMain({ sourceDir: join(root, "nope"), commit: app })).skip).toBe(false);
  });

  it("reads the commit stamped into the app before the install record", () => {
    const appDir = join(root, "app");
    const home = join(root, "home");
    const state = join(home, "Library", "Application Support", "Boop", "self-build");
    mkdirSync(appDir);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "installed.json"), JSON.stringify({ commit: "old" }));
    expect(appCommit({ appDir, home })).toBe("old");
    writeFileSync(join(appDir, "build-info.json"), JSON.stringify({ commit: "new" }));
    expect(appCommit({ appDir, home })).toBe("new");
  });

  it("stamps the packed app with its own commit, so a fresh install doesn't read the old install record", async () => {
    // The first start after an install: the install record still names the
    // previous build, and main is this build. The stamp must win, or the app
    // thinks main is ahead of it and skips pushing its functions.
    const home = join(root, "home");
    const state = join(home, "Library", "Application Support", "Boop", "self-build");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "installed.json"), JSON.stringify({ commit: git(mac, "rev-parse", "HEAD") }));
    git(mac, "pull", "-q", "origin", "main");
    landOnMain("convex/selfBuilds.ts");
    git(mac, "pull", "-q", "origin", "main");
    mkdirSync(join(mac, "electron"));
    const stamped = stampBuildInfo(mac);
    expect(stamped).toBe(git(mac, "rev-parse", "HEAD"));
    const commit = appCommit({ appDir: join(mac, "electron"), home });
    expect(commit).toBe(stamped);
    expect((await newerFunctionsOnMain({ sourceDir: mac, commit })).skip).toBe(false);
  });

  it("removes a stale stamp outside a git checkout", () => {
    const dir = join(root, "plain");
    mkdirSync(join(dir, "electron"), { recursive: true });
    writeFileSync(join(dir, "electron", "build-info.json"), JSON.stringify({ commit: "stale" }));
    expect(stampBuildInfo(dir)).toBeNull();
    expect(appCommit({ appDir: join(dir, "electron"), home: join(root, "nohome") })).toBeNull();
  });
});
