// Who is holding the Mac's wake lock, in words. Plain functions with no Node
// imports, so the dashboard (debug/src) uses the same wording as the server.

/** Self-build statuses during which Boop keeps the Mac awake on its own. */
export const WAKE_LOCK_BUILD_STATUSES = ["queued", "coding", "testing", "shipping", "restarting"] as const;

export type WakeLockSource = "user" | "build" | "both";

export interface WakeLockHolders {
  /** The owner's keep-awake toggle is on and applies to this copy. */
  userHold: boolean;
  /** A self-build is in progress. */
  buildHold: boolean;
  /** The builds in progress, oldest first. */
  buildIds: string[];
}

/** Ids of the builds that should keep the Mac awake, oldest first, no repeats. */
export function activeBuildIds(builds: { buildId: string; status: string; createdAt?: number }[]): string[] {
  const statuses: readonly string[] = WAKE_LOCK_BUILD_STATUSES;
  const ids: string[] = [];
  for (const b of [...builds].sort((a, z) => (a.createdAt ?? 0) - (z.createdAt ?? 0))) {
    if (statuses.includes(b.status) && !ids.includes(b.buildId)) ids.push(b.buildId);
  }
  return ids;
}

export function wakeLockSource(h: WakeLockHolders): WakeLockSource | null {
  if (h.userHold && h.buildHold) return "both";
  if (h.buildHold) return "build";
  if (h.userHold) return "user";
  return null;
}

/** "(build abc)", "(builds abc, def)", or "" when no ids are known. */
export function formatBuildIds(ids: string[]): string {
  if (ids.length === 0) return "";
  return ids.length === 1 ? `(build ${ids[0]})` : `(builds ${ids.join(", ")})`;
}

function agent(ids: string[]): string {
  const which = formatBuildIds(ids);
  return which ? `the self-build agent ${which}` : "the self-build agent";
}

/** The status line for a held wake lock, naming who holds it, or null when nobody does. */
export function wakeLockSourceLabel(h: WakeLockHolders): string | null {
  switch (wakeLockSource(h)) {
    case "both":
      return `Awake: you turned this on, and ${agent(h.buildIds)} is also holding it while it works`;
    case "build":
      return `Awake: held by ${agent(h.buildIds)} while it works; will release when done`;
    case "user":
      return "Awake: you turned this on";
    default:
      return null;
  }
}

/** Short "who" phrase for in-between states, e.g. "for the self-build agent (build abc)". */
export function wakeLockHolderPhrase(h: WakeLockHolders): string {
  switch (wakeLockSource(h)) {
    case "both":
      return `for you and ${agent(h.buildIds)}`;
    case "build":
      return `for ${agent(h.buildIds)}`;
    case "user":
      return "because you turned it on";
    default:
      return "";
  }
}
