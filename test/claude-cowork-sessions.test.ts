import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgentRuntime: vi.fn(),
  configDir: { value: "" },
}));

vi.mock("../server/runtimes/index.js", () => ({ runAgentRuntime: mocks.runAgentRuntime }));
vi.mock("../server/runtime-config.js", () => ({ getRuntimeConfig: vi.fn(async () => ({ runtime: "claude" })) }));
vi.mock("../server/claude-profiles.js", () => ({ activeClaudeConfigDir: vi.fn(async () => mocks.configDir.value) }));

import {
  claudeProjectDirName,
  createClaudeSessionTools,
  findClaudeSession,
  listClaudeSessions,
  prepareCoworkResume,
  sessionMatches,
  summarizeSessionLines,
} from "../server/claude-sessions.js";

const CODE = "11111111-1111-4111-8111-111111111111";
const COWORK = "22222222-2222-4222-8222-222222222222";
const OLD_COWORK = "33333333-3333-4333-8333-333333333333";
const DAY = 86_400_000;

const user = (text: string, cwd = "/Users/me/app") =>
  JSON.stringify({ type: "user", cwd, message: { role: "user", content: text } });

let base: string;
let code: string;
let cowork: string;
let desktop: string;
let boopConfig: string;
let picked: string;
let outputs: string;

/** Writes one Cowork task the way the Claude desktop app lays it out. */
async function addCoworkSession(opts: {
  local: string;
  cliSessionId: string;
  title: string;
  lines: string[];
  folders?: string[];
  lastActivityAt?: number;
  archived?: boolean;
}) {
  const orgDir = join(cowork, "acct", "org");
  const sessionDir = join(orgDir, opts.local);
  const cwd = join(sessionDir, "outputs");
  await mkdir(cwd, { recursive: true });
  const projectDir = join(sessionDir, ".claude", "projects", claudeProjectDirName(cwd));
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, `${opts.cliSessionId}.jsonl`), opts.lines.join("\n") + "\n");
  await writeFile(
    join(orgDir, `${opts.local}.json`),
    JSON.stringify({
      sessionId: opts.local,
      cliSessionId: opts.cliSessionId,
      cwd,
      userSelectedFolders: opts.folders ?? [],
      lastActivityAt: opts.lastActivityAt ?? Date.now(),
      isArchived: opts.archived ?? false,
      title: opts.title,
      initialMessage: "first thing I asked",
    }),
  );
  return { cwd, transcript: join(projectDir, `${opts.cliSessionId}.jsonl`) };
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "claude-cowork-")));
  code = join(base, "code-projects");
  cowork = join(base, "local-agent-mode-sessions");
  desktop = join(base, "claude-code-sessions");
  boopConfig = join(base, "boop-claude");
  picked = join(base, "Sites", "acme-studio");
  await mkdir(picked, { recursive: true });
  await mkdir(join(code, "-Users-me-app"), { recursive: true });
  await writeFile(join(code, "-Users-me-app", `${CODE}.jsonl`), [user("fix the login bug")].join("\n") + "\n");
  await utimes(join(code, "-Users-me-app", `${CODE}.jsonl`), new Date(Date.now() - DAY), new Date(Date.now() - DAY));
  const created = await addCoworkSession({
    local: "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    cliSessionId: COWORK,
    title: "Acme Studio launch plan",
    folders: [picked],
    lines: [
      user("<system-reminder>x</system-reminder>"),
      user("draft the launch plan"),
      JSON.stringify({ type: "last-prompt", lastPrompt: "tighten the timeline" }),
    ],
  });
  outputs = created.cwd;
  await addCoworkSession({
    local: "local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    cliSessionId: OLD_COWORK,
    title: "Old archived task",
    lines: [user("something old")],
    lastActivityAt: Date.now() - 40 * DAY,
    archived: true,
  });
  // The Cowork transcript file is touched now; age it so lastActivityAt decides.
  const oldDir = join(cowork, "acct", "org", "local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ".claude", "projects");
  const [oldProject] = await readdir(oldDir);
  const old = new Date(Date.now() - 40 * DAY);
  await utimes(join(oldDir, oldProject, `${OLD_COWORK}.jsonl`), old, old);
  // Desktop Code-tab index: a title and the folder the session was moved to.
  await mkdir(join(desktop, "acct", "org"), { recursive: true });
  await writeFile(
    join(desktop, "acct", "org", "local_cccccccc-cccc-4ccc-8ccc-cccccccccccc.json"),
    JSON.stringify({ cliSessionId: CODE, title: "Login fixes", cwd: "/Users/me/app-moved" }),
  );
  mocks.configDir.value = boopConfig;
  mocks.runAgentRuntime.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

const roots = () => ({ root: code, coworkRoot: cowork, desktopRoot: desktop });

describe("claudeProjectDirName", () => {
  it("matches Claude Code's folder naming, including the hash suffix for long paths", () => {
    expect(claudeProjectDirName("/Users/me/my app.v2")).toBe("-Users-me-my-app-v2");
    const long = `/Users/example-user/Library/Application Support/Claude/local-agent-mode-sessions/${"0".repeat(36)}/${"1".repeat(36)}/local_${"2".repeat(36)}/outputs`;
    const name = claudeProjectDirName(long);
    expect(name).toHaveLength(207);
    expect(name.endsWith("-v64qwl")).toBe(true);
  });
});

describe("summarizeSessionLines", () => {
  it("uses the last-prompt entry and skips interruption markers", () => {
    const s = summarizeSessionLines(
      [user("start here")],
      [JSON.stringify({ type: "last-prompt", lastPrompt: "the real last ask" }), user("[Request interrupted by user]")],
    );
    expect(s.lastPrompt).toBe("the real last ask");
  });
});

describe("sessionMatches", () => {
  it("ignores punctuation and needs every word", () => {
    const s = { title: null, cwd: "/Users/me/Sites/acme-studio", firstPrompt: "hi", lastPrompt: null };
    expect(sessionMatches(s, "acme studio")).toBe(true);
    expect(sessionMatches(s, "Studio Acme")).toBe(true);
    expect(sessionMatches(s, "acme museum")).toBe(false);
  });
});

describe("listClaudeSessions with Cowork", () => {
  it("lists Code and Cowork sessions together, labelled by source, newest first", async () => {
    const all = await listClaudeSessions(roots());
    expect(all.map((s) => [s.source, s.sessionId])).toEqual([
      ["cowork", COWORK],
      ["code", CODE],
      ["cowork", OLD_COWORK],
    ]);
    expect(all[0]).toMatchObject({
      title: "Acme Studio launch plan",
      cwd: picked,
      firstPrompt: "draft the launch plan",
      lastPrompt: "tighten the timeline",
    });
    expect(all[0].archived).toBeUndefined();
    expect(all[2]).toMatchObject({ title: "Old archived task", archived: true, cwd: join(cowork, "acct", "org", "local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "outputs") });
    // Code session gets the desktop app's title and current folder.
    expect(all[1]).toMatchObject({ title: "Login fixes", cwd: "/Users/me/app-moved" });
  });

  it("finds a Cowork session by its title, and filters by source and age", async () => {
    expect((await listClaudeSessions({ ...roots(), project: "acme studio" })).map((s) => s.sessionId)).toEqual([COWORK]);
    expect((await listClaudeSessions({ ...roots(), source: "code" })).map((s) => s.sessionId)).toEqual([CODE]);
    expect((await listClaudeSessions({ ...roots(), source: "cowork", sinceDays: 7 })).map((s) => s.sessionId)).toEqual([COWORK]);
  });

  it("copes with a missing Cowork folder", async () => {
    const list = await listClaudeSessions({ ...roots(), coworkRoot: join(base, "nope"), desktopRoot: join(base, "nope") });
    expect(list.map((s) => [s.source, s.title])).toEqual([["code", undefined]]);
  });
});

describe("findClaudeSession", () => {
  it("finds a Cowork session by id with its metadata", async () => {
    const found = await findClaudeSession(OLD_COWORK, roots());
    expect(found?.summary.source).toBe("cowork");
    expect(found?.cowork?.archived).toBe(true);
    expect(await findClaudeSession("44444444-4444-4444-8444-444444444444", roots())).toBeNull();
  });
});

describe("prepareCoworkResume", () => {
  it("copies the transcript into Boop's config dir under the picked folder and cleans up after", async () => {
    const found = (await findClaudeSession(COWORK, roots()))!;
    const original = await readFile(found.path, "utf8");
    const staged = await prepareCoworkResume({
      sessionId: COWORK,
      transcriptPath: found.path,
      meta: found.cowork!,
      configDir: boopConfig,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.cwd).toBe(picked);
    const copy = join(boopConfig, "projects", claudeProjectDirName(picked), `${COWORK}.jsonl`);
    expect(await readFile(copy, "utf8")).toBe(original);
    await staged.cleanup();
    expect(await stat(copy).catch(() => null)).toBeNull();
    expect(await readFile(found.path, "utf8")).toBe(original);
  });

  it("falls back to the session's outputs folder, and fails clearly when no folder exists", async () => {
    const found = (await findClaudeSession(COWORK, roots()))!;
    await rm(picked, { recursive: true });
    const staged = await prepareCoworkResume({ sessionId: COWORK, transcriptPath: found.path, meta: found.cowork!, configDir: boopConfig });
    expect(staged.ok && staged.cwd).toBe(outputs);
    if (staged.ok) await staged.cleanup();

    const missing = await prepareCoworkResume({
      sessionId: COWORK,
      transcriptPath: found.path,
      meta: { ...found.cowork!, folder: join(base, "gone"), transcriptCwd: join(base, "gone2") },
      configDir: boopConfig,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/no longer exists/);
  });
});

describe("continue_claude_session", () => {
  const tool = () => createClaudeSessionTools().find((t) => t.name === "continue_claude_session")!;

  beforeEach(() => {
    vi.stubEnv("BOOP_CLAUDE_PROJECTS_DIR", code);
    vi.stubEnv("BOOP_CLAUDE_COWORK_DIR", cowork);
    vi.stubEnv("BOOP_CLAUDE_DESKTOP_SESSIONS_DIR", desktop);
  });

  it("resumes a Cowork session as a fork in its own folder, even if fork=false", async () => {
    const copy = join(boopConfig, "projects", claudeProjectDirName(picked), `${COWORK}.jsonl`);
    let copiedDuringRun = false;
    mocks.runAgentRuntime.mockImplementation(async (_config, request) => {
      copiedDuringRun = !!(await stat(copy).catch(() => null));
      request.onSessionId?.("55555555-5555-4555-8555-555555555555");
      return { text: "done", usage: {} };
    });
    const result = await tool().handle({ sessionId: COWORK, instruction: "keep going", fork: false });
    expect(result.success).toBe(true);
    expect(mocks.runAgentRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resumeSessionId: COWORK, forkSession: true, cwd: picked, prompt: "keep going" }),
    );
    expect(copiedDuringRun).toBe(true);
    expect(await stat(copy).catch(() => null)).toBeNull();
    expect(result.text).toContain("Cowork session \"Acme Studio launch plan\"");
    expect(result.text).toContain("55555555-5555-4555-8555-555555555555");
    expect(result.text).toContain("always forked");
  });

  it("fails gracefully when the resume throws or returns an API error", async () => {
    mocks.runAgentRuntime.mockRejectedValueOnce(new Error("No conversation found"));
    const thrown = await tool().handle({ sessionId: COWORK, instruction: "go" });
    expect(thrown.success).toBe(false);
    expect(thrown.text).toMatch(/Could not resume .*No conversation found.*original session was not changed/);

    mocks.runAgentRuntime.mockResolvedValueOnce({ text: "billing problem", usage: {}, errorCode: "billing_error" });
    const apiError = await tool().handle({ sessionId: COWORK, instruction: "go" });
    expect(apiError.success).toBe(false);
    expect(apiError.text).toContain("billing_error");
  });

  it("explains when the session is unknown", async () => {
    const result = await tool().handle({ sessionId: "44444444-4444-4444-8444-444444444444", instruction: "go" });
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/No Claude Code or Cowork session/);
    expect(mocks.runAgentRuntime).not.toHaveBeenCalled();
  });

  it("still continues a Code session in its folder with the requested fork setting", async () => {
    mocks.runAgentRuntime.mockResolvedValueOnce({ text: "ok", usage: {} });
    const result = await tool().handle({ sessionId: CODE, instruction: "go", fork: false });
    expect(result.text).toContain("Appended to the original session.");
    expect(mocks.runAgentRuntime).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resumeSessionId: CODE, forkSession: false, cwd: "/Users/me/app-moved" }),
    );
  });
});
