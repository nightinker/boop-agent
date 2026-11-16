import { copyFile, mkdir, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { activeClaudeConfigDir } from "./claude-profiles.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";

const NAMESPACE = "boop-claude-sessions";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDGE_BYTES = 96 * 1024;

export interface ClaudeSessionSummary {
  sessionId: string;
  /** "code": Claude Code (terminal / desktop Code tab). "cowork": Claude desktop Cowork task. */
  source: "code" | "cowork";
  /** Title the Claude desktop app shows (Cowork task, or a Code-tab session). */
  title?: string | null;
  /** Working folder (for Cowork: the folder picked for the task, else its outputs folder). */
  cwd: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  updatedAt: string;
  sizeKb: number;
  archived?: boolean;
}

export function claudeProjectsDir(): string {
  return process.env.BOOP_CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
}

/** The Claude desktop app's index of its Code-tab sessions (titles; transcripts stay in ~/.claude/projects). */
export function claudeDesktopCodeSessionsDir(): string {
  return (
    process.env.BOOP_CLAUDE_DESKTOP_SESSIONS_DIR ||
    join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions")
  );
}

/** Where the Claude desktop app keeps Cowork ("local agent mode") sessions on macOS. */
export function claudeCoworkDir(): string {
  return (
    process.env.BOOP_CLAUDE_COWORK_DIR ||
    join(homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions")
  );
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
  if (!text || text.startsWith("<") || text.startsWith("Caveat:") || text.startsWith("[Request interrupted")) {
    return null;
  }
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
    // Claude Code also records the latest prompt as its own entry; it survives long tool-only tails.
    if (!lastPrompt && entry.type === "last-prompt") lastPrompt = promptText(entry.lastPrompt);
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

type SessionSource = "code" | "cowork";

interface Candidate {
  source: SessionSource;
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
  cowork?: CoworkSessionMeta;
}

/** What a Cowork session's `local_<id>.json` tells us beyond the transcript. */
export interface CoworkSessionMeta {
  title: string | null;
  initialMessage: string | null;
  /** The folder the owner picked for the task, else the session's own outputs folder. */
  folder: string | null;
  /** The cwd the transcript was recorded under (the session's outputs folder). */
  transcriptCwd: string | null;
  /** The session's private Claude config dir (holds projects/<cwd>/<id>.jsonl). */
  configDir: string;
  archived: boolean;
}

/**
 * Claude Code's projects-folder name for a cwd: every non-alphanumeric char
 * becomes "-", and names over 200 chars are cut and suffixed with a hash
 * (same scheme as the Claude CLI, so `resume` finds the copied transcript).
 */
export function claudeProjectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

async function codeCandidates(root: string, cutoff: number): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
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
      candidates.push({ source: "code", path, id, mtimeMs: info.mtimeMs, size: info.size });
    }
  }
  return candidates;
}

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

interface DesktopCodeEntry {
  title: string | null;
  cwd: string | null;
}

/**
 * cliSessionId -> title and current folder, from the desktop app's
 * <root>/<account>/<org>/local_<id>.json Code-tab index. The folder there is
 * where the session lives now (a session started in a scratch folder can be
 * moved to a project), which the transcript's first lines don't reflect.
 */
async function desktopCodeIndex(root: string): Promise<Map<string, DesktopCodeEntry>> {
  const index = new Map<string, DesktopCodeEntry>();
  for (const account of await readDirSafe(root)) {
    for (const org of await readDirSafe(join(root, account))) {
      const orgDir = join(root, account, org);
      await Promise.all(
        (await readDirSafe(orgDir))
          .filter((file) => /^local_[\w-]+\.json$/.test(file))
          .map(async (file) => {
            try {
              const meta = JSON.parse(await readFile(join(orgDir, file), "utf8"));
              if (typeof meta?.cliSessionId !== "string") return;
              index.set(meta.cliSessionId, {
                title: typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : null,
                cwd: typeof meta.cwd === "string" && meta.cwd ? meta.cwd : null,
              });
            } catch {
              // unreadable / half-written index entry: no title
            }
          }),
      );
    }
  }
  return index;
}

/**
 * Cowork (Claude desktop "local agent mode") keeps each task as
 * <root>/<account>/<org>/local_<id>.json (title, folders, cliSessionId) next to
 * local_<id>/.claude/projects/<cwd>/<cliSessionId>.jsonl, a normal Claude Code
 * transcript under the session's own config dir.
 */
async function coworkCandidates(root: string, cutoff: number): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const account of await readDirSafe(root)) {
    for (const org of await readDirSafe(join(root, account))) {
      const orgDir = join(root, account, org);
      for (const file of await readDirSafe(orgDir)) {
        if (!/^local_[\w-]+\.json$/.test(file)) continue;
        let meta: Record<string, any>;
        try {
          meta = JSON.parse(await readFile(join(orgDir, file), "utf8"));
        } catch {
          continue;
        }
        const id = meta?.cliSessionId;
        if (typeof id !== "string" || !SESSION_ID.test(id)) continue;
        const configDir = join(orgDir, file.replace(/\.json$/, ""), ".claude");
        let transcript: { path: string; mtimeMs: number; size: number } | null = null;
        for (const dir of await readDirSafe(join(configDir, "projects"))) {
          const path = join(configDir, "projects", dir, `${id}.jsonl`);
          const info = await stat(path).catch(() => null);
          if (info?.isFile() && info.size > 0) {
            transcript = { path, mtimeMs: info.mtimeMs, size: info.size };
            break;
          }
        }
        if (!transcript) continue;
        const lastActivity = typeof meta.lastActivityAt === "number" ? meta.lastActivityAt : 0;
        const mtimeMs = Math.max(lastActivity, transcript.mtimeMs);
        if (mtimeMs < cutoff) continue;
        const selected = Array.isArray(meta.userSelectedFolders)
          ? meta.userSelectedFolders.find((f: unknown) => typeof f === "string" && f)
          : undefined;
        const transcriptCwd = typeof meta.cwd === "string" ? meta.cwd : null;
        candidates.push({
          source: "cowork",
          id,
          path: transcript.path,
          mtimeMs,
          size: transcript.size,
          cowork: {
            title: typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : null,
            initialMessage: promptText(meta.initialMessage),
            folder: selected ?? transcriptCwd,
            transcriptCwd,
            configDir,
            archived: meta.isArchived === true,
          },
        });
      }
    }
  }
  return candidates;
}

interface ListOptions {
  limit?: number;
  project?: string;
  /** Claude Code projects dir (defaults to ~/.claude/projects). */
  root?: string;
  /** Cowork sessions dir (defaults to the Claude desktop app's local-agent-mode-sessions). */
  coworkRoot?: string;
  /** Claude desktop Code-tab session index, for titles (defaults to the app's claude-code-sessions). */
  desktopRoot?: string;
  sinceDays?: number;
  source?: SessionSource;
}

async function allCandidates(opts: ListOptions): Promise<Candidate[]> {
  const cutoff = opts.sinceDays ? Date.now() - opts.sinceDays * 86_400_000 : 0;
  const [code, cowork] = await Promise.all([
    opts.source === "cowork" ? [] : codeCandidates(opts.root ?? claudeProjectsDir(), cutoff),
    opts.source === "code" ? [] : coworkCandidates(opts.coworkRoot ?? claudeCoworkDir(), cutoff),
  ]);
  return [...code, ...cowork].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function summarize(c: Candidate, desktop?: Map<string, DesktopCodeEntry>): Promise<ClaudeSessionSummary | null> {
  const [head, tail] = await Promise.all([readEdge(c.path, c.size, false), readEdge(c.path, c.size, true)]);
  const summary = summarizeSessionLines(head, tail);
  const base = {
    sessionId: c.id,
    updatedAt: new Date(c.mtimeMs).toISOString(),
    sizeKb: Math.round(c.size / 1024),
  };
  if (c.source === "code") {
    if (!summary.firstPrompt) return null; // subagent / observer files with no real user prompt
    const entry = desktop?.get(c.id);
    return {
      ...base,
      source: "code",
      ...(entry?.title ? { title: entry.title } : {}),
      ...summary,
      cwd: entry?.cwd ?? summary.cwd,
    };
  }
  const meta = c.cowork!;
  const firstPrompt = summary.firstPrompt ?? meta.initialMessage;
  return {
    ...base,
    source: "cowork",
    title: meta.title,
    cwd: meta.folder ?? summary.cwd,
    firstPrompt,
    lastPrompt: summary.firstPrompt ? summary.lastPrompt : firstPrompt,
    ...(meta.archived ? { archived: true } : {}),
  };
}

/** Lowercase, punctuation as spaces: "acme studio" matches the folder "acme-studio". */
function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/** Every word of the needle appears in the title, folder or prompts. */
export function sessionMatches(s: Pick<ClaudeSessionSummary, "title" | "cwd" | "firstPrompt" | "lastPrompt">, needle: string): boolean {
  const haystack = normalize(`${s.title ?? ""} ${s.cwd ?? ""} ${s.firstPrompt ?? ""} ${s.lastPrompt ?? ""}`);
  const words = normalize(needle).split(" ").filter(Boolean);
  return words.every((word) => haystack.includes(word));
}

export async function listClaudeSessions(opts: ListOptions = {}): Promise<ClaudeSessionSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30);
  const needle = opts.project?.trim();
  const out: ClaudeSessionSummary[] = [];
  const [candidates, desktop] = await Promise.all([
    allCandidates(opts),
    opts.source === "cowork" ? undefined : desktopCodeIndex(opts.desktopRoot ?? claudeDesktopCodeSessionsDir()),
  ]);
  for (const c of candidates) {
    if (out.length >= limit) break;
    const summary = await summarize(c, desktop);
    if (!summary) continue;
    if (needle && !sessionMatches(summary, needle)) continue;
    out.push(summary);
  }
  return out;
}

/** One session by id, from either source (no recency limit). Cowork wins if both hold the id. */
export async function findClaudeSession(
  sessionId: string,
  opts: Pick<ListOptions, "root" | "coworkRoot" | "desktopRoot"> = {},
): Promise<{ summary: ClaudeSessionSummary; cowork?: CoworkSessionMeta; path: string } | null> {
  const hits = (await allCandidates(opts)).filter((c) => c.id === sessionId);
  const hit = hits.find((c) => c.source === "cowork") ?? hits[0];
  if (!hit) return null;
  const desktop =
    hit.source === "code" ? await desktopCodeIndex(opts.desktopRoot ?? claudeDesktopCodeSessionsDir()) : undefined;
  const summary = (await summarize(hit, desktop)) ?? {
    sessionId,
    source: hit.source,
    cwd: null,
    firstPrompt: null,
    lastPrompt: null,
    updatedAt: new Date(hit.mtimeMs).toISOString(),
    sizeKb: Math.round(hit.size / 1024),
  };
  return { summary, cowork: hit.cowork, path: hit.path };
}

async function isDirectory(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  return (await stat(path).catch(() => null))?.isDirectory() ?? false;
}

/**
 * Makes a Cowork transcript resumable by Boop's Claude runtime. The SDK looks
 * sessions up under <CLAUDE_CONFIG_DIR>/projects/<cwd>/<id>.jsonl, and Cowork
 * keeps them under its own per-session config dir, so we copy the transcript
 * (read-only on the original) into Boop's config dir under the folder the
 * resumed run will use. Pointing CLAUDE_CONFIG_DIR at the Cowork dir instead
 * would lose Boop's Claude login. Call `cleanup` once the run is over; the
 * fork it produced is its own session and stays.
 */
export async function prepareCoworkResume(opts: {
  sessionId: string;
  transcriptPath: string;
  meta: CoworkSessionMeta;
  configDir: string;
  cwd?: string;
}): Promise<{ ok: true; cwd: string; cleanup: () => Promise<void> } | { ok: false; error: string }> {
  const choices = opts.cwd ? [opts.cwd] : [opts.meta.folder, opts.meta.transcriptCwd];
  let folder: string | undefined;
  for (const choice of choices) {
    if (await isDirectory(choice)) {
      folder = choice!;
      break;
    }
  }
  if (!folder) {
    return {
      ok: false,
      error: opts.cwd
        ? `The folder ${opts.cwd} does not exist on this Mac.`
        : "That Cowork session's working folder no longer exists on this Mac; pass cwd to run it somewhere else.",
    };
  }
  const cwd = await realpath(folder).catch(() => folder!);
  const target = join(opts.configDir, "projects", claudeProjectDirName(cwd), `${opts.sessionId}.jsonl`);
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(opts.transcriptPath, target);
  } catch (err) {
    return { ok: false, error: `Could not stage the Cowork transcript for resuming: ${(err as Error).message}` };
  }
  return { ok: true, cwd, cleanup: () => rm(target, { force: true }) };
}

async function boopClaudeConfigDir(): Promise<string> {
  return (await activeClaudeConfigDir()) ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function createClaudeSessionTools(): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "list_claude_sessions",
      "List the owner's recent Claude sessions on this Mac, newest first: Claude Code sessions (terminal or the desktop app's Code tab, source \"code\") and Claude desktop Cowork tasks (source \"cowork\", with their title). Each has session id, source, working folder, first and last prompt, last activity. Use when the user asks what they were working on in Claude / Claude Code / Cowork, wants to pick something back up, or says 'continue that session'. When you show them, say which are Code and which are Cowork. After listing, SUGGEST the most likely session by its title / last prompt and ask before continuing it with continue_claude_session. Filter with `project` (matches Cowork title, folder or prompt text) and `source`.",
      {
        project: z.string().optional().describe("Case-insensitive text to match against the Cowork title, working folder or prompts."),
        source: z.enum(["code", "cowork"]).optional().describe("Only Claude Code sessions or only Cowork tasks."),
        limit: z.number().int().min(1).max(30).optional().default(8),
        sinceDays: z.number().int().min(1).max(90).optional().describe("Only sessions active in the last N days."),
      },
      async ({ project, source, limit, sinceDays }) => {
        const sessions = await listClaudeSessions({ project, source, limit, sinceDays });
        if (sessions.length === 0) {
          return runtimeText("No Claude Code or Cowork sessions found on this Mac for that filter.");
        }
        return runtimeText(JSON.stringify(sessions, null, 2));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "continue_claude_session",
      "Continue an earlier Claude Code session or Cowork task with a new instruction and return its answer. Only call after the user has confirmed which session. Defaults to FORKING: the original session is left untouched and the work lands in a copy (a new session id is returned). Pass fork=false only if the user explicitly wants to append to the original AND that session is not open in Claude right now; Cowork tasks are always forked (the desktop app owns the original). Runs in the session's own working folder under Boop's Claude login and permission settings, not the original session's (a Cowork task's connectors and plugins are not loaded). Needs the Claude runtime.",
      {
        sessionId: z.string().describe("Session id from list_claude_sessions."),
        instruction: z.string().min(1).describe("What the resumed session should do next."),
        cwd: z.string().optional().describe("Working folder; defaults to the session's own."),
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
        const found = await findClaudeSession(sessionId);
        if (!found) {
          return runtimeText(
            `No Claude Code or Cowork session ${sessionId} was found on this Mac (it may have been deleted). Use list_claude_sessions to pick another.`,
            false,
          );
        }
        const isCowork = found.summary.source === "cowork" && !!found.cowork;
        const forked = isCowork ? true : fork;
        let folder: string | undefined;
        let cleanup: (() => Promise<void>) | undefined;
        if (isCowork) {
          const staged = await prepareCoworkResume({
            sessionId,
            transcriptPath: found.path,
            meta: found.cowork!,
            configDir: await boopClaudeConfigDir(),
            cwd,
          });
          if (!staged.ok) return runtimeText(`Could not continue that Cowork session: ${staged.error}`, false);
          folder = staged.cwd;
          cleanup = staged.cleanup;
        } else {
          folder = cwd ?? found.summary.cwd ?? undefined;
          if (!folder) {
            return runtimeText("Could not work out the session's project folder; pass cwd.", false);
          }
        }
        const label = isCowork ? `Cowork session "${found.summary.title ?? sessionId}"` : "Claude Code session";
        let newSessionId: string | undefined;
        let result: Awaited<ReturnType<typeof runAgentRuntime>>;
        try {
          result = await runAgentRuntime(config, {
            prompt: instruction,
            systemPrompt: "",
            tools: [],
            cwd: folder,
            mode: "execution",
            resumeSessionId: sessionId,
            forkSession: forked,
            onSessionId: (id) => {
              newSessionId = id;
            },
          });
        } catch (err) {
          return runtimeText(
            `Could not resume that ${label}: ${(err as Error).message || String(err)}. The original session was not changed.`,
            false,
          );
        } finally {
          await cleanup?.().catch(() => undefined);
        }
        if (result.errorCode) {
          return runtimeText(`Could not resume that ${label} (${result.errorCode}): ${result.text}`, false);
        }
        const header = forked
          ? `Continued the ${label} as a fork${newSessionId ? ` (new session ${newSessionId})` : ""} in ${folder}; the original is unchanged.${
              isCowork ? " The fork is a Claude Code session now (it shows under source \"code\"), not a Cowork task." : ""
            }${isCowork && !fork ? " (Cowork tasks are always forked.)" : ""}`
          : "Appended to the original session.";
        return runtimeText(`${header}\n\n${result.text}`);
      },
    ),
  ];
}
