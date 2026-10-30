import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverClaudeProfiles,
  envWithClaudeConfigDir,
  formatProfileList,
  labelForDir,
  parseProfileIdentity,
  pickActiveProfile,
  resolveProfileInput,
  type ClaudeProfile,
} from "../server/claude-profiles.js";
import { createSelfTools } from "../server/self-tools.js";

function account(email: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    oauthAccount: { emailAddress: email, organizationName: "Example Org" },
    primaryApiKey: "sk-should-never-be-read",
    ...extra,
  });
}

describe("profile identity", () => {
  it("keeps only the email and org", () => {
    const identity = parseProfileIdentity(account("me@example.test"));
    expect(identity).toEqual({ email: "me@example.test", orgName: "Example Org" });
    expect(JSON.stringify(identity)).not.toContain("sk-");
  });

  it("treats a dir without a signed-in account as no profile", () => {
    expect(parseProfileIdentity(JSON.stringify({ numStartups: 3 }))).toBeNull();
    expect(parseProfileIdentity("not json")).toBeNull();
  });

  it("labels dirs by their suffix", () => {
    expect(labelForDir("/Users/x/.claude-work")).toBe("work");
    expect(labelForDir("/Users/x/.claude_Personal")).toBe("personal");
    expect(labelForDir("/opt/claude-profiles/side")).toBe("side");
  });
});

describe("profile discovery", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "boop-claude-profiles-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("finds the default login and signed-in extra config dirs", async () => {
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude.json"), account("main@example.test"));
    await mkdir(join(home, ".claude-work"));
    await writeFile(join(home, ".claude-work", ".claude.json"), account("work@example.test"));
    await mkdir(join(home, ".claude-empty"));
    await writeFile(join(home, ".claude-empty", ".claude.json"), "{}");
    const extra = join(home, "elsewhere", "side");
    await mkdir(extra, { recursive: true });
    await writeFile(join(extra, ".claude.json"), account("side@example.test"));

    const profiles = await discoverClaudeProfiles({ home, extraDirs: extra });
    expect(profiles.map((p) => [p.label, p.email, p.isDefault])).toEqual([
      ["default", "main@example.test", true],
      ["side", "side@example.test", false],
      ["work", "work@example.test", false],
    ]);
  });

  it("returns nothing when no account is signed in", async () => {
    expect(await discoverClaudeProfiles({ home })).toEqual([]);
  });

  it("treats Boop's own CLAUDE_CONFIG_DIR as the default", async () => {
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude.json"), account("main@example.test"));
    await mkdir(join(home, ".claude-work"));
    await writeFile(join(home, ".claude-work", ".claude.json"), account("work@example.test"));

    const profiles = await discoverClaudeProfiles({ home, envConfigDir: join(home, ".claude-work") });
    expect(profiles.map((p) => [p.label, p.email])).toEqual([
      ["default", "work@example.test"],
      ["home", "main@example.test"],
    ]);
  });
});

const profiles: ClaudeProfile[] = [
  { label: "default", configDir: "/h/.claude", isDefault: true, email: "main@example.test", orgName: null },
  { label: "work", configDir: "/h/.claude-work", isDefault: false, email: "work@example.test", orgName: "Acme" },
];

describe("choosing a profile", () => {
  it("matches labels, emails and dir names, case-insensitively", () => {
    expect(resolveProfileInput("Work", profiles)?.label).toBe("work");
    expect(resolveProfileInput("WORK@example.test", profiles)?.label).toBe("work");
    expect(resolveProfileInput("~/.claude-work", profiles)?.label).toBe("work");
    expect(resolveProfileInput("default", profiles)?.label).toBe("default");
  });

  it("rejects unknown names", () => {
    expect(resolveProfileInput("personal", profiles)).toBeNull();
    expect(resolveProfileInput("  ", profiles)).toBeNull();
  });

  it("falls back to the default when the saved account is gone", () => {
    expect(pickActiveProfile(profiles, "work").active?.label).toBe("work");
    expect(pickActiveProfile(profiles, null)).toEqual({ active: profiles[0], missingSavedLabel: null });
    expect(pickActiveProfile(profiles, "old")).toEqual({ active: profiles[0], missingSavedLabel: "old" });
  });

  it("lists accounts with the active one marked and no secrets", () => {
    const text = formatProfileList(profiles, "work");
    expect(text).toContain("• (active) work — work@example.test (Acme)");
    expect(text).toContain("• default — main@example.test");
  });

  it("explains an empty list, a single account and a stale choice", () => {
    expect(formatProfileList([], null)).toContain("No signed-in Claude accounts");
    expect(formatProfileList([profiles[0]], null)).toContain("only Claude account");
    expect(formatProfileList(profiles, "old")).toContain('"old" is no longer signed in');
  });

  it("only overrides the env for a non-default profile", () => {
    expect(envWithClaudeConfigDir(undefined, { PATH: "/bin" })).toBeUndefined();
    expect(envWithClaudeConfigDir("/h/.claude-work", { PATH: "/bin", GONE: undefined })).toEqual({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/h/.claude-work",
    });
  });
});

describe("account tools are owner-only", () => {
  const original = process.env.BOOP_OWNER_NUMBERS;
  afterEach(() => {
    process.env.BOOP_OWNER_NUMBERS = original;
  });

  it("refuses a non-owner iMessage sender and a missing conversation", async () => {
    process.env.BOOP_OWNER_NUMBERS = "+15550000001";
    for (const conversationId of ["sms:+15550000002", undefined]) {
      const tools = createSelfTools(conversationId);
      for (const name of ["list_claude_accounts", "set_claude_account"]) {
        const tool = tools.find((t) => t.name === name);
        expect(tool).toBeDefined();
        const result = await tool!.handle(name === "set_claude_account" ? { account: "work" } : {});
        expect(JSON.stringify(result)).toContain("Only Boop's owner");
      }
    }
  });
});
