// Plain helpers for the dashboard's Self-builds page. Kept free of React so
// they can be tested on their own.

export type SelfBuildStatus =
  | "queued"
  | "coding"
  | "testing"
  | "pr_open"
  | "failed"
  | "cancelled"
  | "shipping"
  | "restarting"
  | "shipped"
  | "rolled_back";

export interface SelfBuildRow {
  buildId: string;
  request: string;
  status: SelfBuildStatus;
  branch?: string;
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

export type StatusTone = "waiting" | "active" | "ready" | "done" | "failed" | "muted";

export const STATUS_META: Record<SelfBuildStatus, { label: string; tone: StatusTone }> = {
  queued: { label: "Queued", tone: "waiting" },
  coding: { label: "Coding", tone: "active" },
  testing: { label: "Testing", tone: "active" },
  pr_open: { label: "PR open", tone: "ready" },
  shipping: { label: "Shipping", tone: "active" },
  restarting: { label: "Restarting", tone: "active" },
  shipped: { label: "Shipped", tone: "done" },
  failed: { label: "Failed", tone: "failed" },
  rolled_back: { label: "Rolled back", tone: "failed" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

/** Statuses where something is happening right now (the queue waits on these). */
const ACTIVE: SelfBuildStatus[] = ["coding", "testing", "shipping", "restarting"];

export function isActive(status: SelfBuildStatus): boolean {
  return ACTIVE.includes(status);
}

/** Statuses whose clock is still running. */
export function isOngoing(status: SelfBuildStatus): boolean {
  return status === "queued" || isActive(status);
}

export function isFailure(status: SelfBuildStatus): boolean {
  return status === "failed" || status === "rolled_back";
}

/**
 * Merges recent builds with the queue (which can hold builds older than the
 * recent window) and sorts: active first, then the queue in line order, then
 * everything else newest first. Queued builds get their place in line.
 */
export function dashboardBuilds<T extends SelfBuildRow>(
  recent: T[],
  queued: T[],
): (T & { queuePosition?: number })[] {
  const byId = new Map<string, T>();
  for (const build of [...recent, ...queued]) byId.set(build.buildId, build);
  const line = [...queued].sort((a, b) => a.createdAt - b.createdAt);
  const position = new Map(line.map((b, i) => [b.buildId, i + 1]));
  const rank = (b: T) => (isActive(b.status) ? 0 : b.status === "queued" ? 1 : 2);
  return [...byId.values()]
    .map((b): T & { queuePosition?: number } =>
      position.has(b.buildId) ? { ...b, queuePosition: position.get(b.buildId) } : b,
    )
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      if (a.status === "queued" && b.status === "queued") {
        return (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
      }
      return b.createdAt - a.createdAt;
    });
}

/** The build to highlight: the one coding, else any other active one. */
export function currentBuildId(builds: SelfBuildRow[]): string | null {
  return (builds.find((b) => b.status === "coding") ?? builds.find((b) => isActive(b.status)))?.buildId ?? null;
}

/** How long a build has been going (still running) or took (finished). */
export function elapsedMs(build: Pick<SelfBuildRow, "status" | "createdAt" | "updatedAt">, now: number): number {
  const end = isOngoing(build.status) ? now : build.updatedAt;
  return Math.max(0, end - build.createdAt);
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  return `${formatDuration(ms).split(" ")[0]} ago`;
}

/** The newest `lines` lines of a build's activity log. */
export function activityTail(activity: string | undefined, lines = 8): string[] {
  if (!activity) return [];
  return activity.split("\n").filter((l) => l.trim()).slice(-lines);
}

/**
 * Why a build failed and the log worth showing with it: the failed start's
 * log for a rollback, else the activity log, else the check output.
 */
export function failureDetails(
  build: SelfBuildRow,
): { reason: string; logLabel?: string; log?: string } | null {
  if (!isFailure(build.status)) return null;
  const reason =
    build.error?.trim() ||
    (build.status === "rolled_back"
      ? "The new version didn't start, so Boop rolled back to the previous one. The code is still merged."
      : "No reason was recorded.");
  if (build.status === "rolled_back" && build.startupLogTail?.trim()) {
    return {
      reason,
      logLabel: build.startupLogPath ? `Failed-start log · ${build.startupLogPath}` : "Failed-start log",
      log: build.startupLogTail.trimEnd(),
    };
  }
  if (build.activity?.trim()) return { reason, logLabel: "Last activity", log: build.activity.trimEnd() };
  if (build.testOutput?.trim()) return { reason, logLabel: "Check output", log: build.testOutput.trimEnd() };
  return { reason };
}

export function prNumber(prUrl: string): string | null {
  return prUrl.match(/\/pull\/(\d+)/)?.[1] ?? null;
}

/** Status filters for the Self-builds page, in the order the tabs show. */
export type SelfBuildFilter =
  | "all"
  | "running"
  | "queued"
  | "pr_open"
  | "shipped"
  | "failed"
  | "rolled_back"
  | "cancelled";

export const SELF_BUILD_FILTERS: { id: SelfBuildFilter; label: string; empty: string }[] = [
  { id: "all", label: "All", empty: "No self-builds yet." },
  { id: "running", label: "Running", empty: "Nothing is building right now." },
  { id: "queued", label: "Queued", empty: "Nothing is waiting in the queue." },
  { id: "pr_open", label: "PR open", empty: "No builds are waiting on a PR." },
  { id: "shipped", label: "Shipped", empty: "No shipped builds in this list." },
  { id: "failed", label: "Failed", empty: "No failed builds in this list." },
  { id: "rolled_back", label: "Rolled back", empty: "No rolled-back builds in this list." },
  { id: "cancelled", label: "Cancelled", empty: "No cancelled builds in this list." },
];

/** Whether a build belongs under a filter. "Running" covers every active step. */
export function matchesFilter(status: SelfBuildStatus, filter: SelfBuildFilter): boolean {
  if (filter === "all") return true;
  if (filter === "running") return isActive(status);
  return status === filter;
}

export function filterBuilds<T extends Pick<SelfBuildRow, "status">>(builds: T[], filter: SelfBuildFilter): T[] {
  return filter === "all" ? builds : builds.filter((b) => matchesFilter(b.status, filter));
}

/** How many builds each filter would show. */
export function filterCounts(builds: Pick<SelfBuildRow, "status">[]): Record<SelfBuildFilter, number> {
  const counts = Object.fromEntries(SELF_BUILD_FILTERS.map((f) => [f.id, 0])) as Record<SelfBuildFilter, number>;
  for (const build of builds) {
    for (const { id } of SELF_BUILD_FILTERS) if (matchesFilter(build.status, id)) counts[id]++;
  }
  return counts;
}
