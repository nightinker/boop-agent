import { describe, expect, it, vi } from "vitest";

vi.mock("../server/broadcast.js", () => ({ broadcast: vi.fn() }));
vi.mock("../server/sendblue.js", () => ({ sendImessage: vi.fn() }));

import {
  branchName,
  codingPrompt,
  isOwnerConversation,
  parseGitHubRepo,
  prBody,
  readyMessage,
  restartScript,
  slugify,
} from "../server/self-build/plan.js";
import { codingEnv, realNodeEnv } from "../server/self-build/run.js";
import { SELF_BUILD_ALLOWED_TOOLS, createSelfBuildTools } from "../server/self-build/tools.js";

describe("who may change Boop's code", () => {
  it("allows local conversations", () => {
    expect(isOwnerConversation("debug-test", undefined)).toBe(true);
  });

  it("allows only listed iMessage numbers, ignoring formatting", () => {
    expect(isOwnerConversation("sms:+15551234567", "+1 (555) 123-4567")).toBe(true);
    expect(isOwnerConversation("sms:+15551234567", "+15550000000, +15551234567")).toBe(true);
    expect(isOwnerConversation("sms:+15559999999", "+15551234567")).toBe(false);
  });

  it("is off for every iMessage sender when no owner is set", () => {
    expect(isOwnerConversation("sms:+15551234567", undefined)).toBe(false);
    expect(isOwnerConversation("sms:+15551234567", "")).toBe(false);
  });
});

describe("naming", () => {
  it("turns a request into a short branch name", () => {
    expect(slugify("Boop, please add a weekly summary of my skills!")).toBe("add-weekly-summary-of-skills");
    expect(slugify("!!!")).toBe("feature");
    expect(branchName("Add dark mode", "b123")).toBe("boop/self-build-add-dark-mode-b123");
  });

  it("reads owner/repo from GitHub remotes", () => {
    expect(parseGitHubRepo("https://github.com/nightinker/boop-agent.git")).toBe("nightinker/boop-agent");
    expect(parseGitHubRepo("git@github.com:nightinker/boop-agent.git")).toBe("nightinker/boop-agent");
    expect(parseGitHubRepo("https://github.com/nightinker/boop-agent")).toBe("nightinker/boop-agent");
    expect(parseGitHubRepo("https://gitlab.com/x/y")).toBeNull();
  });
});

describe("coding brief", () => {
  it("includes the request and the guard rails", () => {
    const prompt = codingPrompt("Add a /skills summary");
    expect(prompt).toContain('"Add a /skills summary"');
    expect(prompt).toMatch(/Do not push/);
    expect(prompt).toMatch(/\.env\.local/);
    expect(prompt).toMatch(/npx vitest run/);
    expect(prompt).toMatch(/Do not run the app/);
  });
});

describe("messages", () => {
  it("writes a PR body with the request and check status", () => {
    const body = prBody({ request: "Add X", summary: "Added X.", testsPassed: false, testOutput: "1 failed" });
    expect(body).toContain("> Add X");
    expect(body).toContain("## Checks: FAILING");
    expect(body).toContain("1 failed");
  });

  it("texts the owner the PR and how to ship", () => {
    const text = readyMessage({ buildId: "b1", summary: "Added X.", prUrl: "https://github.com/a/b/pull/9", testsPassed: true });
    expect(text).toContain("Build b1 is ready");
    expect(text).toContain("https://github.com/a/b/pull/9");
    expect(text).toContain("ship it");
  });
});

describe("restart script", () => {
  const script = restartScript({
    buildId: "b1",
    newAppPath: "/tmp/new/Boop.app",
    appPath: "/Applications/Boop.app",
    backupDir: "/tmp/it's here/previous",
    resultPath: "/tmp/result.json",
    healthUrl: "http://localhost:3456/health",
  });

  it("swaps the app and checks it comes back", () => {
    expect(script).toContain('mv "$APP" "$BACKUP/Boop.app"');
    expect(script).toContain('ditto "$NEW" "$APP"');
    expect(script).toContain("wait_for_health");
    expect(script).toContain("write_result shipped");
  });

  it("restores the previous build when the new one doesn't answer", () => {
    expect(script).toContain('mv "$BACKUP/Boop.app" "$APP"');
    expect(script).toContain("write_result rolled_back");
  });

  it("quotes paths safely", () => {
    expect(script).toContain(`BACKUP='/tmp/it'\\''s here/previous'`);
  });
});

describe("coding agent environment", () => {
  it("drops Boop's secrets and keeps what tools need", () => {
    const env = codingEnv({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      COMPOSIO_API_KEY: "x",
      SENDBLUE_API_SECRET: "x",
      CONVEX_DEPLOYMENT: "x",
      GITHUB_TOKEN: "x",
      VOYAGE_API_KEY: "x",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/me" });
  });
});

describe("main agent tools", () => {
  it("exposes start, list, ship and cancel, all allowed", () => {
    const tools = createSelfBuildTools("debug-test");
    expect(tools.map((t) => t.name)).toEqual([
      "start_self_build",
      "list_self_builds",
      "ship_self_build",
      "cancel_self_build",
    ]);
    expect(SELF_BUILD_ALLOWED_TOOLS).toHaveLength(4);
  });
});

describe("build commands use the system Node", () => {
  it("drops the app's Electron node shim from PATH", () => {
    const env = realNodeEnv({
      PATH: "/Users/me/Library/Application Support/Boop/bin:/x/node_modules/.bin:/opt/homebrew/bin:/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
      BOOP_NODE_CMD: "/Users/me/Library/Application Support/Boop/bin/node",
      HOME: "/Users/me",
    });
    expect(env.PATH).toBe("/x/node_modules/.bin:/opt/homebrew/bin:/usr/bin");
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.BOOP_NODE_CMD).toBeUndefined();
    expect(env.HOME).toBe("/Users/me");
  });
});
