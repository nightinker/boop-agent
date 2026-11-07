import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The server codes and ships a build while the Mac is off; the Mac installs
// main when it's back. Real git repos stand in for GitHub and both checkouts;
// Convex, texts and the Mac app build are mocked.

const home = vi.hoisted(() => ({ dir: "" }));
const convexMock = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
const notifyMock = vi.hoisted(() => vi.fn());
const instance = vi.hoisted(() => ({ active: true }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir || actual.homedir() };
});
vi.mock("../server/convex-client.js", () => ({ convex: convexMock }));
vi.mock("../server/notify.js", () => ({ notifyConversation: notifyMock }));
vi.mock("../server/instance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/instance.js")>();
  return { ...actual, isActiveInstance: () => instance.active };
});

import {
  catchUpWithPeers,
  installMissedUpdates,
  resetCatchUpState,
  resumeSelfBuilds,
  setBuildRunnerForTests,
  shipSelfBuild,
  startNextQueuedBuild,
  startSelfBuild,
} from "../server/self-build/run.js";
import { shipBlocker } from "../server/self-build/queue.js";

const SERVER = "linux:test-server";
const MAC = "darwin:test-mac";
const OWNER = "sms:+15551234567";
const realPlatform = process.platform;
const env = { ...process.env };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

let root: string;
let origin: string;
let serverCheckout: string;
let macCheckout: string;
let stateDir: string;

/** A change merged into main on GitHub (here: pushed from the server's checkout). */
function mergeToMain(file: string): string {
  writeFileSync(join(serverCheckout, file), file);
  git(serverCheckout, "add", file);
  git(serverCheckout, "commit", "-m", `Merge pull request #7 from org/${file}`);
  git(serverCheckout, "push", "-q", "origin", "HEAD:main");
  return git(serverCheckout, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "boop-server-to-mac-"));
  home.dir = join(root, "home");
  stateDir = join(home.dir, "Library", "Application Support", "Boop", "self-build");
  mkdirSync(stateDir, { recursive: true });
  origin = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });
  serverCheckout = join(root, "server");
  execFileSync("git", ["clone", "-q", origin, serverCheckout], { stdio: "pipe" });
  writeFileSync(join(serverCheckout, "README.md"), "boop");
  git(serverCheckout, "add", "README.md");
  git(serverCheckout, "commit", "-q", "-m", "initial");
  git(serverCheckout, "push", "-q", "origin", "HEAD:main");
  macCheckout = join(root, "mac");
  execFileSync("git", ["clone", "-q", origin, macCheckout], { stdio: "pipe" });

  process.env.BOOP_OWNER_NUMBERS = "+15551234567";
  delete process.env.BOOP_AUTO_UPDATE;
  instance.active = true;
  convexMock.query.mockReset().mockResolvedValue([]);
  convexMock.mutation.mockReset();
  notifyMock.mockReset();
  resetCatchUpState();
});

afterEach(() => {
  setBuildRunnerForTests(null);
  resetCatchUpState();
  setPlatform(realPlatform);
  process.env = { ...env };
  home.dir = "";
  rmSync(root, { recursive: true, force: true });
});

function onServer() {
  setPlatform("linux");
  process.env.BOOP_INSTANCE_ID = SERVER;
  process.env.BOOP_SOURCE_DIR = serverCheckout;
  delete process.env.BOOP_DESKTOP;
}

function onMac() {
  setPlatform("darwin");
  process.env.BOOP_INSTANCE_ID = MAC;
  process.env.BOOP_SOURCE_DIR = macCheckout;
  process.env.BOOP_DESKTOP = "1";
}

describe("server builds, Mac installs on return", () => {
  it("the server codes the build itself when it has a checkout, marked as its own", async () => {
    onServer();
    const ran: string[] = [];
    setBuildRunnerForTests(async ({ buildId }) => void ran.push(buildId));
    convexMock.mutation.mockResolvedValue({ status: "coding", position: 0, blockedBy: null });

    const reply = await startSelfBuild({ conversationId: OWNER, request: "Add X" });

    expect(reply).toMatch(/^Started build /);
    const [, args] = convexMock.mutation.mock.calls[0]!;
    expect(args).toMatchObject({ request: "Add X", runner: SERVER });
    expect(args).not.toHaveProperty("forceQueue");
    await vi.waitFor(() => expect(ran).toHaveLength(1));
  });

  it("shipping on the server merges to main and says the Mac installs it later", async () => {
    onServer();
    // A stand-in `gh` that reports the PR as already merged.
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho MERGED\n");
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    convexMock.query.mockResolvedValue([
      { buildId: "b1", status: "pr_open", prUrl: "https://github.com/org/repo/pull/7", testsPassed: true, conversationId: OWNER },
    ]);
    convexMock.mutation.mockResolvedValue(null);

    expect(await shipSelfBuild({ conversationId: OWNER })).toContain("Shipping it");

    await vi.waitFor(() =>
      expect(notifyMock).toHaveBeenCalledWith(OWNER, expect.stringContaining("Your Mac installs it"), "self_build"),
    );
    const updates = convexMock.mutation.mock.calls.map(([, args]) => args);
    expect(updates).toContainEqual(expect.objectContaining({ buildId: "b1", status: "shipping", runner: SERVER }));
    expect(updates).toContainEqual(expect.objectContaining({ buildId: "b1", status: "shipped" }));
  });

  it("the Mac sees the server's newer commit on check-in and installs main", async () => {
    onMac();
    const installedCommit = git(macCheckout, "rev-parse", "HEAD");
    writeFileSync(join(stateDir, "installed.json"), JSON.stringify({ commit: installedCommit }));
    const shipped = mergeToMain("feature.txt");
    // The server is still coding another build; that doesn't stop the Mac.
    convexMock.query.mockResolvedValue([{ buildId: "b2", status: "coding", runner: SERVER }]);
    const install = vi.fn().mockResolvedValue(undefined);

    const started = await catchUpWithPeers(
      {
        activeInstanceId: MAC,
        instances: [{ instanceId: SERVER, label: "server", platform: "linux", priority: 10, publicUrl: null, commit: shipped, lastSeenAt: 0, online: true }],
      },
      { install },
    );

    expect(started).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]![0]).toMatchObject({ id: `update-${shipped.slice(0, 7)}`, src: macCheckout, conversationId: OWNER });
    expect(notifyMock).toHaveBeenCalledWith(OWNER, expect.stringContaining("PR #7 landed"), "self_build");
  });

  it("does nothing when the server runs what the Mac already has", async () => {
    onMac();
    const installedCommit = git(macCheckout, "rev-parse", "HEAD");
    writeFileSync(join(stateDir, "installed.json"), JSON.stringify({ commit: installedCommit }));
    const install = vi.fn();
    const summary = {
      activeInstanceId: MAC,
      instances: [{ instanceId: SERVER, label: "server", platform: "linux", priority: 10, publicUrl: null, commit: installedCommit, lastSeenAt: 0, online: true }],
    };
    expect(await catchUpWithPeers(summary, { install })).toBe(false);
    expect(install).not.toHaveBeenCalled();
    expect(convexMock.query).not.toHaveBeenCalled();
  });

  it("waits for a running execution agent before restarting the Mac", async () => {
    onMac();
    writeFileSync(join(stateDir, "installed.json"), JSON.stringify({ commit: git(macCheckout, "rev-parse", "HEAD") }));
    mergeToMain("feature.txt");
    let agentRunning = true;
    const install = vi.fn().mockResolvedValue(undefined);
    const opts = { install, isBusy: () => agentRunning, retryMs: 20 };

    expect(await installMissedUpdates(opts)).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(install).not.toHaveBeenCalled();
    // While it waits it only rechecks locally: no Convex reads.
    expect(convexMock.query).not.toHaveBeenCalled();

    agentRunning = false;
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  });

  it("doesn't restart over a build coding on this Mac", async () => {
    onMac();
    writeFileSync(join(stateDir, "installed.json"), JSON.stringify({ commit: git(macCheckout, "rev-parse", "HEAD") }));
    mergeToMain("feature.txt");
    convexMock.query.mockResolvedValue([{ buildId: "b3", status: "coding", runner: MAC }]);
    const install = vi.fn();
    expect(await installMissedUpdates({ install })).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });
});

describe("no double build", () => {
  it("a copy standing by never claims a queued build", async () => {
    onServer();
    instance.active = false;
    await startNextQueuedBuild();
    expect(convexMock.mutation).not.toHaveBeenCalled();

    instance.active = true;
    convexMock.mutation.mockResolvedValue(null);
    await startNextQueuedBuild();
    expect(convexMock.mutation).toHaveBeenCalledWith(expect.anything(), { runner: SERVER });
  });

  it("the server restarting only fails its own interrupted builds", async () => {
    onServer();
    convexMock.query.mockResolvedValue([]);
    convexMock.mutation.mockResolvedValue([]);
    await resumeSelfBuilds({ startQueued: false });
    expect(convexMock.mutation).toHaveBeenCalledWith(expect.anything(), { runner: SERVER, claimsUnowned: false });
  });

  it("the server never fails every build when Convex predates runners", async () => {
    onServer();
    convexMock.query.mockResolvedValue([]);
    convexMock.mutation.mockRejectedValueOnce(new Error("ArgumentValidationError: Object contains extra field `runner`"));
    await resumeSelfBuilds({ startQueued: false });
    expect(convexMock.mutation).toHaveBeenCalledTimes(1);
  });

  it("the Mac can ship while the server is coding another build", () => {
    const builds = [{ buildId: "server-build", status: "coding" as const, runner: SERVER }];
    const runsHere = (b: { runner?: string }) => b.runner === MAC;
    expect(shipBlocker(builds, "ship-me", true, runsHere)).toBeNull();
    expect(shipBlocker([{ ...builds[0]!, runner: MAC }], "ship-me", true, runsHere)).toContain("still coding");
  });
});
