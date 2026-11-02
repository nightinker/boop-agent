// Plain helpers for the dashboard's Orchestrator page: status labels, the
// plan graph's layout and the step timeline. Kept free of React so they can be
// tested on their own. The data comes from GET /api/orchestrator/dashboard,
// which Boop builds from the sidecar (server/orchestrator-dashboard.ts).

import type {
  OrchestratorOverview,
  RunDetail,
  RunSummary,
  SidecarHealth,
  StepStatus,
  StepView,
} from "../../../server/orchestrator-dashboard.js";

export type { OrchestratorOverview, RunDetail, RunSummary, SidecarHealth, StepStatus, StepView };

export type Tone = "waiting" | "active" | "done" | "failed" | "muted";

export const HEALTH_META: Record<SidecarHealth, { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "done" },
  starting: { label: "Starting", tone: "active" },
  restarting: { label: "Restarting", tone: "waiting" },
  down: { label: "Down", tone: "failed" },
  not_configured: { label: "Not configured", tone: "muted" },
};

export const STEP_META: Record<StepStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "muted" },
  running: { label: "Running", tone: "active" },
  done: { label: "Done", tone: "done" },
  failed: { label: "Failed", tone: "failed" },
  blocked: { label: "Blocked", tone: "failed" },
  skipped: { label: "Skipped", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export const RUN_META: Record<string, { label: string; tone: Tone }> = {
  PLANNING: { label: "Planning", tone: "active" },
  RUNNING: { label: "Running", tone: "active" },
  MERGING: { label: "Merging", tone: "active" },
  SUCCEEDED: { label: "Succeeded", tone: "done" },
  FAILED: { label: "Failed", tone: "failed" },
  CANCELLED: { label: "Cancelled", tone: "muted" },
};

export function runMeta(state: string): { label: string; tone: Tone } {
  return RUN_META[state] ?? { label: state, tone: "muted" };
}

/** "3h 2m", "4m 05s", "12s", or "<1s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return ms <= 0 ? "0s" : "<1s";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatAgo(at: number | null | undefined, now: number): string {
  if (!at) return "—";
  const ms = Math.max(0, now - at);
  if (ms < 5_000) return "just now";
  return `${formatMs(ms).split(" ")[0]} ago`;
}

/** Poll faster while a run is going, slower when idle or down. */
export function overviewPollMs(o: OrchestratorOverview | null | undefined): number {
  if (!o || !o.available) return 5_000;
  return o.runs.some((r) => !r.done) ? 2_000 : 5_000;
}

/** Keep polling one run until it's finished. */
export function detailPollMs(run: RunDetail | null | undefined): number | null {
  if (!run) return 2_000;
  return run.done ? null : 1_500;
}

/** "3 done · 1 running · 1 failed", leaving out zero counts. */
export function countsLine(counts: Record<StepStatus, number>): string {
  const order: StepStatus[] = ["done", "running", "pending", "failed", "blocked", "skipped", "cancelled"];
  const parts = order.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${STEP_META[s].label.toLowerCase()}`);
  return parts.join(" · ") || "no steps yet";
}

// ---- the plan graph -------------------------------------------------------------

export const NODE_W = 188;
export const NODE_H = 68;
export const COL_GAP = 52;
export const ROW_GAP = 14;
const PAD = 6;

export interface GraphNode {
  step: StepView;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** SVG path data. */
  d: string;
  status: StepStatus;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Lays the plan out left to right: one column per dependency level, steps in
 * plan order within a column, with a curved edge from each dependency to the
 * step that waits on it. The edge takes the upstream step's status, so a
 * finished dependency reads as a finished line.
 */
export function layoutGraph(steps: StepView[]): GraphLayout {
  const columns = new Map<number, StepView[]>();
  for (const s of steps) {
    const col = columns.get(s.level) ?? [];
    col.push(s);
    columns.set(s.level, col);
  }
  const levels = [...columns.keys()].sort((a, b) => a - b);
  const colIndex = new Map(levels.map((l, i) => [l, i]));
  const nodes: GraphNode[] = [];
  const pos = new Map<string, GraphNode>();
  let maxRows = 0;
  for (const l of levels) {
    const col = columns.get(l)!;
    maxRows = Math.max(maxRows, col.length);
    col.forEach((step, row) => {
      const node = { step, x: PAD + colIndex.get(l)! * (NODE_W + COL_GAP), y: PAD + row * (NODE_H + ROW_GAP) };
      nodes.push(node);
      pos.set(step.id, node);
    });
  }
  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    for (const dep of n.step.dependsOn) {
      const from = pos.get(dep);
      if (!from) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = n.x;
      const y2 = n.y + NODE_H / 2;
      const bend = Math.max(16, (x2 - x1) / 2);
      edges.push({
        from: dep,
        to: n.step.id,
        d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        status: from.step.status,
      });
    }
  }
  const cols = levels.length;
  return {
    width: cols ? PAD * 2 + cols * NODE_W + (cols - 1) * COL_GAP : 0,
    height: maxRows ? PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP : 0,
    nodes,
    edges,
  };
}

// ---- the timeline ---------------------------------------------------------------

export interface TimelineBar {
  step: StepView;
  /** Percent of the run's span. */
  left: number;
  width: number;
  started: boolean;
}

/**
 * One bar per step, placed on the run's own clock: from when the run was
 * created to when it finished (or now, while it's going). Steps that never
 * started get no bar.
 */
export function timelineBars(run: RunDetail, now: number): { spanMs: number; bars: TimelineBar[] } {
  const starts = run.stepsDetail.map((s) => s.startedAt).filter((t): t is number => t !== null);
  const begin = run.createdAt ?? (starts.length ? Math.min(...starts) : now);
  const ends = run.stepsDetail.map((s) => s.finishedAt ?? (s.startedAt !== null ? now : null)).filter((t): t is number => t !== null);
  const end = run.finishedAt ?? (run.done ? Math.max(begin, ...ends) : now);
  const spanMs = Math.max(1, end - begin);
  const bars = run.stepsDetail.map((step) => {
    if (step.startedAt === null) return { step, left: 0, width: 0, started: false };
    const s = Math.max(0, step.startedAt - begin);
    const e = Math.max(s, (step.finishedAt ?? (run.done ? end : now)) - begin);
    const left = Math.min(100, (s / spanMs) * 100);
    const width = Math.max(0.75, Math.min(100 - left, ((e - s) / spanMs) * 100));
    return { step, left, width, started: true };
  });
  return { spanMs, bars };
}
