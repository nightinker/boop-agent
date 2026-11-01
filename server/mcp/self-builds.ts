#!/usr/bin/env -S npx tsx
// A read-only MCP server for Boop's self-builds, so Claude Code (or any MCP
// client) can see what Boop is building: what's running, the queue, each
// build's request, activity, checks, errors and logs, and its code changes.
//
// It only reads. Starting, shipping and cancelling builds stay with Boop,
// which checks they come from the owner.
//
// Run it with `npm run mcp:self-builds`. It talks MCP over stdio, so nothing
// else may be printed to stdout.

import "../env-setup.js";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "dotenv";
import { ConvexHttpClient } from "convex/browser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { parseGitHubRepo } from "../self-build/plan.js";
import { formatBuild, formatList, lastLines, type BuildRecord, type StatusFilter } from "./self-builds-view.js";

const run = promisify(execFile);
const boopDir = join(homedir(), "Library", "Application Support", "Boop");

// Outside a configured checkout, use the desktop app's settings.
if (!process.env.CONVEX_URL && !process.env.VITE_CONVEX_URL) {
  for (const path of [process.env.BOOP_ENV_FILE, join(boopDir, "runtime", ".env.local")]) {
    if (path && existsSync(path)) {
      config({ path });
      break;
    }
  }
}
const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
if (!convexUrl) {
  console.error(
    "[self-builds-mcp] No Convex URL. Run it from a Boop checkout with .env.local, or set BOOP_ENV_FILE to one.",
  );
  process.exit(1);
}
const convex = new ConvexHttpClient(convexUrl);

const STATUSES = [
  "running",
  "all",
  "queued",
  "coding",
  "testing",
  "pr_open",
  "failed",
  "cancelled",
  "shipping",
  "restarting",
  "shipped",
  "rolled_back",
] as const;

async function load(limit = 25): Promise<{ recent: BuildRecord[]; queued: BuildRecord[] }> {
  return (await convex.query(api.selfBuilds.forDashboard, { limit })) as {
    recent: BuildRecord[];
    queued: BuildRecord[];
  };
}

async function find(buildId: string): Promise<BuildRecord | null> {
  return (await convex.query(api.selfBuilds.get, { buildId: buildId.trim() })) as BuildRecord | null;
}

function readTail(path: string, lines: number): string | null {
  try {
    return existsSync(path) ? lastLines(readFileSync(path, "utf8"), lines) : null;
  } catch {
    return null;
  }
}

async function sh(cmd: string, args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run(cmd, args, { cwd, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const MAX_DIFF = 60_000;

/** The build's code changes: live from its worktree while it codes, else from its PR. */
async function buildDiff(build: BuildRecord, full: boolean): Promise<string> {
  const wt = build.worktreePath;
  const live = ["queued", "coding", "testing"].includes(build.status);
  if (wt && existsSync(wt) && (live || !build.prUrl)) {
    const base = (await sh("git", ["merge-base", "origin/main", "HEAD"], wt).catch(() => "origin/main")).trim();
    const [commits, stat, status] = await Promise.all([
      sh("git", ["log", "--oneline", `${base}..HEAD`], wt).catch(() => ""),
      sh("git", ["diff", "--stat", base], wt).catch(() => ""),
      sh("git", ["status", "--short"], wt).catch(() => ""),
    ]);
    const parts = [
      `Changes in ${wt} (against origin/main, including uncommitted work):`,
      commits.trim() ? `Commits:\n${commits.trim()}` : "No commits yet.",
      status.trim() ? `Uncommitted:\n${status.trimEnd()}` : "",
      stat.trim() ? `Files:\n${stat.trimEnd()}` : "No changes yet.",
    ];
    if (full) parts.push(await sh("git", ["diff", base], wt).catch((e) => `git diff failed: ${e.message}`));
    return clip(parts.filter(Boolean).join("\n\n"));
  }
  if (build.prUrl) {
    const repo = parseGitHubRepo(build.prUrl.replace(/\/pull\/\d+$/, ""));
    const repoArgs = repo ? ["--repo", repo] : [];
    const info = JSON.parse(
      await sh("gh", ["pr", "view", build.prUrl, ...repoArgs, "--json", "state,additions,deletions,files,commits"]),
    ) as {
      state: string;
      additions: number;
      deletions: number;
      files: { path: string; additions: number; deletions: number }[];
      commits: { oid: string; messageHeadline: string }[];
    };
    const parts = [
      `PR ${build.prUrl} (${info.state.toLowerCase()}): +${info.additions} −${info.deletions}`,
      `Commits:\n${info.commits.map((c) => `${c.oid.slice(0, 7)} ${c.messageHeadline}`).join("\n")}`,
      `Files:\n${info.files.map((f) => `${f.path} +${f.additions} −${f.deletions}`).join("\n")}`,
    ];
    if (full) parts.push(await sh("gh", ["pr", "diff", build.prUrl, ...repoArgs]).catch((e) => `gh pr diff failed: ${e.message}`));
    return clip(parts.join("\n\n"));
  }
  return `Build ${build.buildId} has no PR yet and its worktree isn't on this machine.`;
}

function clip(t: string): string {
  return t.length > MAX_DIFF ? `${t.slice(0, MAX_DIFF)}\n\n… cut at ${MAX_DIFF} characters; read the files in the worktree or PR for the rest.` : t;
}

const server = new McpServer({ name: "boop-self-builds", version: "1.0.0" });
const readOnly = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
  "list_self_builds",
  {
    description:
      "List Boop's self-builds: the ones running now (with their latest activity), the queue in order, then recent ones. Use status to filter, e.g. \"running\" or \"failed\".",
    inputSchema: {
      status: z.enum(STATUSES).optional().describe('Default "all". "running" means coding, testing, shipping or restarting.'),
      limit: z.number().int().min(1).max(100).optional().describe("How many finished builds to show (default 10)."),
    },
    annotations: readOnly,
  },
  async ({ status, limit }) => {
    const data = await load(Math.max(limit ?? 10, 25));
    return text(formatList(data, { filter: status as StatusFilter | undefined, limit, now: Date.now() }));
  },
);

server.registerTool(
  "get_self_build",
  {
    description:
      "Everything about one self-build: its request, status, branch, worktree, PR, the coding agent's summary, latest activity, failing check output, errors, and startup/restart logs. Omit buildId for the running build, or else the newest one.",
    inputSchema: { buildId: z.string().optional() },
    annotations: readOnly,
  },
  async ({ buildId }) => {
    const data = buildId ? null : await load(10);
    const build = buildId
      ? await find(buildId)
      : (data!.recent.find((b) => ["coding", "testing", "shipping", "restarting"].includes(b.status)) ?? data!.recent[0] ?? null);
    if (!build) return text(buildId ? `No self-build with id ${buildId}.` : "No self-builds yet.");
    const queued = (data ?? (await load(10))).queued.sort((a, b) => a.createdAt - b.createdAt);
    const position = queued.findIndex((b) => b.buildId === build.buildId);
    return text(
      formatBuild(
        build,
        {
          restartLogTail: readTail(join(boopDir, "self-build", `restart-${build.buildId}.log`), 20),
          worktreeHere: build.worktreePath ? existsSync(build.worktreePath) : undefined,
          queuePosition: position >= 0 ? position + 1 : null,
        },
        Date.now(),
      ),
    );
  },
);

server.registerTool(
  "self_build_changes",
  {
    description:
      "The code a self-build changed: commits and changed files, read live from its worktree while it's coding, otherwise from its PR. Set full to include the whole diff (capped at 60k characters).",
    inputSchema: {
      buildId: z.string().describe("The build's id, from list_self_builds."),
      full: z.boolean().optional().describe("Include the full diff, not just the file list."),
    },
    annotations: readOnly,
  },
  async ({ buildId, full }) => {
    const build = await find(buildId);
    if (!build) return text(`No self-build with id ${buildId}.`);
    try {
      return text(await buildDiff(build, Boolean(full)));
    } catch (err) {
      return text(`Couldn't read build ${buildId}'s changes: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error("[self-builds-mcp] ready");
