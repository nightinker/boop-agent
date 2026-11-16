import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";

const NAMESPACE = "boop-claude-sessions";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDGE_BYTES = 96 * 1024;

export interface ClaudeSessionSummary {
  sessionId: string;
  cwd: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  updatedAt: string;
  sizeKb: number;
}

export function claudeProjectsDir(): string {
  return process.env.BOOP_CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
}

function promptText(content: unknown): string | null {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              block && typeof block === "object" && (block as { type?: string }).type === "text"
                ? String((block as { text?: string }).text ?? "")
                : "",
            )
            .join(" ")
        : "";
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return null;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Pulls cwd and the first / last real user prompt out of the head and tail of one session file. */
export function summarizeSessionLines(head: string[], tail: string[]) {
  let cwd: string | null = null;
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  const parse = (line: string): Record<string, any> | null => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  };
  for (const line of head) {
    const entry = parse(line);
    if (!entry) continue;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (!firstPrompt && entry.type === "user" && !entry.isSidechain) {
      firstPrompt = promptText(entry.message?.content);
    }
    if (cwd && firstPrompt) break;
  }
  for (const line of [...tail].reverse()) {
    const entry = parse(line);
    if (!entry) continue;
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (!lastPrompt && entry.type === "user" && !entry.isSidechain) {
      lastPrompt = promptText(entry.message?.content);
    }
    if (cwd && lastPrompt) break;
  }
  return { cwd, firstPrompt, lastPrompt: lastPrompt ?? firstPrompt };
}

async function readEdge(path: string, size: number, fromEnd: boolean): Promise<string[]> {
  const length = Math.min(size, EDGE_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, fromEnd ? size - length : 0);
    const lines = buffer.toString("utf8").split("\n");
    // The first line of a tail read and the last of a head read may be cut mid-record.
    return fromEnd ? lines.slice(1) : lines.slice(0, -1);
  } finally {
    await handle.close();
  }
}

export async function listClaudeSessions(
  opts: { limit?: number; project?: string; root?: string; sinceDays?: number } = {},
): Promise<ClaudeSessionSummary[]> {
  const root = opts.root ?? claudeProjectsDir();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30);
  const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86_400_000 : 0;
  const needle = opts.project?.toLowerCase();

  const candidates: Array<{ path: string; id: string; mtimeMs: number; size: number }> = [];
  let folders: string[] = [];
  try {
    folders = await readdir(root);
  } catch {
    return [];
  }
  for (const folder of folders) {
    let files: string[];
    try {
      files = await readdir(join(root, folder));
    } catch {
      continue;
    }
    for (const file of files) {
      const id = file.replace(/\.jsonl$/, "");
      if (!file.endsWith(".jsonl") || !SESSION_ID.test(id)) continue;
      const path = join(root, folder, file);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs < cutoff || info.size === 0) continue;
      candidates.push({ path, id, mtimeMs: info.mtimeMs, size: info.size });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: ClaudeSessionSummary[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    const [head, tail] = await Promise.all([
      readEdge(c.path, c.size, false),
      readEdge(c.path, c.size, true),
    ]);
    const summary = summarizeSessionLines(head, tail);
    if (!summary.firstPrompt) continue; // subagent / observer files with no real user prompt
    if (needle && !`${summary.cwd ?? ""} ${summary.firstPrompt} ${summary.lastPrompt}`.toLowerCase().includes(needle)) {
      continue;
    }
    out.push({
      sessionId: c.id,
      ...summary,
      updatedAt: new Date(c.mtimeMs).toISOString(),
      sizeKb: Math.round(c.size / 1024),
    });
  }
  return out;
}

export function createClaudeSessionTools(): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "list_claude_sessions",
      "List the owner's recent Claude Code sessions (started in the terminal or the Claude desktop app on this Mac): session id, project folder, first and last prompt, last activity. Use when the user asks what they were working on in Claude, wants to pick something back up, or says 'continue that session'. After listing, SUGGEST the most likely session by its last prompt and ask before continuing it with continue_claude_session. Filter with `project` (matches folder or prompt text).",
      {
        project: z.string().optional().describe("Case-insensitive text to match against the project folder or prompts."),
        limit: z.number().int().min(1).max(30).optional().default(8),
        sinceDays: z.number().int().min(1).max(90).optional().describe("Only sessions active in the last N days."),
      },
      async ({ project, limit, sinceDays }) => {
        const sessions = await listClaudeSessions({ project, limit, sinceDays });
        if (sessions.length === 0) {
          return runtimeText("No Claude Code sessions found on this Mac for that filter.");
        }
        return runtimeText(JSON.stringify(sessions, null, 2));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "continue_claude_session",
      "Continue an earlier Claude Code session with a new instruction and return its answer. Only call after the user has confirmed which session. Defaults to FORKING: the original session is left untouched and the work lands in a copy (a new session id is returned). Pass fork=false only if the user explicitly wants to append to the original AND that session is not open in Claude right now. Runs under Boop's Claude login and permission settings, not the original session's. Needs the Claude runtime.",
      {
        sessionId: z.string().describe("Session id from list_claude_sessions."),
        instruction: z.string().min(1).describe("What the resumed session should do next."),
        cwd: z.string().optional().describe("Project folder; defaults to the session's own cwd."),
        fork: z.boolean().optional().default(true),
      },
      async ({ sessionId, instruction, cwd, fork }) => {
        if (!SESSION_ID.test(sessionId)) {
          return runtimeText("That is not a valid session id. Use list_claude_sessions first.", false);
        }
        const config = await getRuntimeConfig();
        if (config.runtime !== "claude") {
          return runtimeText("Continuing a Claude session needs the Claude runtime; Boop is on another one.", false);
        }
        const known = (await listClaudeSessions({ limit: 30 })).find((s) => s.sessionId === sessionId);
        const folder = cwd ?? known?.cwd;
        if (!folder) {
          return runtimeText("Could not work out the session's project folder; pass cwd.", false);
        }
        let newSessionId: string | undefined;
        const result = await runAgentRuntime(config, {
          prompt: instruction,
          systemPrompt: "",
          tools: [],
          cwd: folder,
          mode: "execution",
          resumeSessionId: sessionId,
          forkSession: fork,
          onSessionId: (id) => {
            newSessionId = id;
          },
        });
        const header = fork
          ? `Continued as a fork${newSessionId ? ` (new session ${newSessionId})` : ""}; the original is unchanged.`
          : "Appended to the original session.";
        return runtimeText(`${header}\n\n${result.text}`);
      },
    ),
  ];
}
