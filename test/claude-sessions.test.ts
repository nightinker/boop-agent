import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listClaudeSessions, summarizeSessionLines } from "../server/claude-sessions.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const user = (text: unknown, extra = {}) =>
  JSON.stringify({ type: "user", cwd: "/Users/me/app", message: { role: "user", content: text }, ...extra });

describe("summarizeSessionLines", () => {
  it("skips injected reminders and picks first and last real prompt", () => {
    const s = summarizeSessionLines(
      [user("<system-reminder>x</system-reminder>"), user("fix the login bug")],
      [user([{ type: "text", text: "now add a test" }]), "{broken json"],
    );
    expect(s).toEqual({ cwd: "/Users/me/app", firstPrompt: "fix the login bug", lastPrompt: "now add a test" });
  });
  it("ignores sidechain prompts", () => {
    const s = summarizeSessionLines([user("sub task", { isSidechain: true })], []);
    expect(s.firstPrompt).toBeNull();
  });
});

describe("listClaudeSessions", () => {
  it("returns newest first, skips non-session and promptless files, filters by project", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-sessions-"));
    await mkdir(join(root, "-Users-me-app"));
    await writeFile(join(root, "-Users-me-app", `${A}.jsonl`), [user("older work"), user("older end")].join("\n") + "\n");
    await writeFile(join(root, "-Users-me-app", `${B}.jsonl`), [user("newer work")].join("\n") + "\n");
    await writeFile(join(root, "-Users-me-app", "notes.jsonl"), user("ignored") + "\n");
    await writeFile(join(root, "-Users-me-app", "33333333-3333-4333-8333-333333333333.jsonl"), '{"type":"queue-operation"}\n');
    await utimes(join(root, "-Users-me-app", `${A}.jsonl`), new Date(1_000_000), new Date(1_000_000));

    const all = await listClaudeSessions({ root });
    expect(all.map((s) => s.sessionId)).toEqual([B, A]);
    expect(all[1].lastPrompt).toBe("older end");
    expect((await listClaudeSessions({ root, project: "older" })).map((s) => s.sessionId)).toEqual([A]);
    expect(await listClaudeSessions({ root: join(root, "missing") })).toEqual([]);
  });
});
