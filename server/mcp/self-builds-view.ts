// Plain text views of self-builds for the self-builds MCP server. Kept free of
// Convex and the file system so they're easy to test.

import type { BuildStatus } from "../self-build/queue.js";

export interface BuildRecord {
  buildId: string;
  status: BuildStatus;
  request: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  summary?: string;
  testsPassed?: boolean;
  testOutput?: string;
  error?: string;
  startupLogPath?: string;
  startupLogTail?: string;
  activity?: string;
  createdAt: number;
  updatedAt: number;
}

/** Builds whose coding agent or ship is running right now. */
export const RUNNING: BuildStatus[] = ["coding", "testing", "shipping", "restarting"];

export type StatusFilter = BuildStatus | "running" | "all";

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function lastLines(text: string | undefined, n: number): string {
  if (!text) return "";
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function matchesFilter(build: BuildRecord, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "running") return RUNNING.includes(build.status);
  return build.status === filter;
}

export function formatRow(build: BuildRecord, now: number): string {
  const parts = [
    build.buildId,
    build.status,
    `started ${ago(build.createdAt, now)}`,
    `updated ${ago(build.updatedAt, now)}`,
  ];
  if (build.prUrl) parts.push(build.prUrl);
  return `- ${parts.join(" · ")}\n  ${oneLine(build.request, 140)}`;
}

/** The list view: running builds first, then the queue in order, then the rest. */
export function formatList(
  input: { recent: BuildRecord[]; queued: BuildRecord[] },
  opts: { filter?: StatusFilter; limit?: number; now: number },
): string {
  const filter = opts.filter ?? "all";
  const limit = opts.limit ?? 10;
  const seen = new Set<string>();
  const all = [...input.queued, ...input.recent].filter((b) => {
    if (seen.has(b.buildId)) return false;
    seen.add(b.buildId);
    return matchesFilter(b, filter);
  });
  if (all.length === 0) {
    return filter === "all" ? "No self-builds yet." : `No self-builds are ${filter === "running" ? "running" : filter} right now.`;
  }

  const running = all.filter((b) => RUNNING.includes(b.status));
  const queued = all.filter((b) => b.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
  const rest = all
    .filter((b) => !RUNNING.includes(b.status) && b.status !== "queued")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  const sections: string[] = [];
  if (running.length) {
    sections.push(
      `Running (${running.length}):\n${running
        .map((b) => {
          const latest = lastLines(b.activity, 1);
          return formatRow(b, opts.now) + (latest ? `\n  latest: ${oneLine(latest, 160)}` : "");
        })
        .join("\n")}`,
    );
  }
  if (queued.length) {
    sections.push(`Queued, next first (${queued.length}):\n${queued.map((b) => formatRow(b, opts.now)).join("\n")}`);
  }
  if (rest.length) sections.push(`Recent:\n${rest.map((b) => formatRow(b, opts.now)).join("\n")}`);
  if (!running.length && filter === "all") sections.unshift("Nothing is running right now.");
  return sections.join("\n\n");
}

export interface BuildExtras {
  /** Tail of the restart log, when it's on this machine. */
  restartLogTail?: string | null;
  /** Whether the build's worktree exists on this machine. */
  worktreeHere?: boolean;
  queuePosition?: number | null;
}

/** Everything known about one build, newest details last. */
export function formatBuild(build: BuildRecord, extras: BuildExtras, now: number): string {
  const out: string[] = [
    `Build ${build.buildId}: ${build.status}`,
    `Started ${ago(build.createdAt, now)} (${new Date(build.createdAt).toISOString()}), updated ${ago(build.updatedAt, now)}.`,
  ];
  if (extras.queuePosition) out.push(`Queue position: ${extras.queuePosition}.`);
  if (build.branch) out.push(`Branch: ${build.branch}`);
  if (build.worktreePath) {
    out.push(`Worktree: ${build.worktreePath}${extras.worktreeHere === false ? " (not on this machine)" : ""}`);
  }
  if (build.prUrl) out.push(`PR: ${build.prUrl}`);
  if (build.testsPassed !== undefined) out.push(`Checks: ${build.testsPassed ? "passed" : "failed"}`);

  out.push("", "Request:", build.request.trim());
  if (build.summary) out.push("", "Summary from the coding agent:", build.summary.trim());
  if (build.error) out.push("", "Error:", build.error.trim());
  if (build.activity) out.push("", "Latest activity:", lastLines(build.activity, 25));
  if (build.testOutput && build.testsPassed === false) {
    out.push("", "Check output (last 40 lines):", lastLines(build.testOutput, 40));
  }
  if (build.startupLogTail) {
    out.push("", `Failed start log${build.startupLogPath ? ` (${build.startupLogPath})` : ""}:`, lastLines(build.startupLogTail, 40));
  }
  if (extras.restartLogTail) out.push("", "Restart log (last 20 lines):", lastLines(extras.restartLogTail, 20));
  return out.join("\n");
}
