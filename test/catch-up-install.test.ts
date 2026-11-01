import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));
const convexMock = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir || actual.homedir() };
});
vi.mock("../server/convex-client.js", () => ({ convex: convexMock }));
vi.mock("../server/notify.js", () => ({ notifyConversation: notifyMock }));

import { catchUpMessage } from "../server/self-build/plan.js";
import { installMissedUpdates, reportPendingRestart } from "../server/self-build/run.js";

describe("the catch-up message", () => {
  it("names the PRs that landed", () => {
    expect(
      catchUpMessage(["Merge pull request #28 from org/a", "Merge pull request #29 from org/b"]),
    ).toBe("While your Mac was off, PRs #28, #29 landed on main. Installing now; I'll be back in a minute or two.");
    expect(catchUpMessage(["Merge pull request #30 from org/c"])).toContain("PR #30 landed");
    expect(catchUpMessage(["fix typo", "tweak"])).toContain("2 changes landed");
  });
});

describe("after a catch-up install restarts", () => {
  let state: string;
  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), "boop-home-"));
    state = join(home.dir, "Library", "Application Support", "Boop", "self-build");
    mkdirSync(state, { recursive: true });
    convexMock.query.mockReset().mockResolvedValue(null); // not a self-build
    convexMock.mutation.mockReset();
    notifyMock.mockReset();
  });
  afterEach(() => rmSync(home.dir, { recursive: true, force: true }));

  const installing = { id: "update-abc1234", commit: "abc1234def", conversationId: "sms:+15550000000" };

  it("records the new version and says it's back", async () => {
    writeFileSync(join(state, "installing.json"), JSON.stringify(installing));
    writeFileSync(join(state, "pending-result.json"), JSON.stringify({ buildId: "update-abc1234", status: "shipped" }));
    await reportPendingRestart();
    expect(JSON.parse(readFileSync(join(state, "installed.json"), "utf8")).commit).toBe("abc1234def");
    expect(notifyMock).toHaveBeenCalledWith("sms:+15550000000", "I'm back, running the latest main (abc1234).", "self_build");
  });

  it("keeps the old version on record when the update rolled back", async () => {
    writeFileSync(join(state, "installed.json"), JSON.stringify({ commit: "old0000" }));
    writeFileSync(join(state, "installing.json"), JSON.stringify(installing));
    writeFileSync(join(state, "pending-result.json"), JSON.stringify({ buildId: "update-abc1234", status: "rolled_back" }));
    await reportPendingRestart();
    expect(JSON.parse(readFileSync(join(state, "installed.json"), "utf8")).commit).toBe("old0000");
    expect(notifyMock.mock.calls[0][1]).toContain("rolled back");
  });

  it("doesn't touch the record for someone else's restart result", async () => {
    writeFileSync(join(state, "installing.json"), JSON.stringify(installing));
    writeFileSync(join(state, "pending-result.json"), JSON.stringify({ buildId: "other", status: "shipped" }));
    await reportPendingRestart();
    expect(existsSync(join(state, "installed.json"))).toBe(false);
  });
});

describe("checking for missed updates", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("does nothing outside the desktop app or without a checkout", async () => {
    delete process.env.BOOP_DESKTOP;
    expect(await installMissedUpdates()).toBe(false);
    process.env.BOOP_DESKTOP = "1";
    delete process.env.BOOP_SOURCE_DIR;
    expect(await installMissedUpdates()).toBe(false);
  });
});
