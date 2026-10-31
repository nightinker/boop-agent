// Plain helpers for the self-build queue: what Boop says, and when shipping
// has to wait. The queue itself lives in convex/selfBuilds.ts.

export type BuildStatus =
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

interface BuildSummary {
  buildId: string;
  status: BuildStatus;
  request: string;
  prUrl?: string;
  testsPassed?: boolean;
}

export const CANCELLABLE: BuildStatus[] = ["queued", "coding", "testing", "pr_open"];

export function queuedMessage(input: {
  buildId: string;
  position: number;
  blockedBy: { buildId: string; status: string } | null;
}): string {
  const waitingOn = input.blockedBy ? `Build ${input.blockedBy.buildId} is still ${input.blockedBy.status}, so ` : "";
  const place = input.position === 1 ? "next in line" : `#${input.position} in line`;
  return `${waitingOn}I queued this as build ${input.buildId} (${place}). It starts on its own when the builds ahead of it finish, and I'll text you when it does.`;
}

/**
 * Why a build can't ship right now, or null if it can. Another build that's
 * shipping or restarting always blocks. On the desktop app shipping restarts
 * Boop, which would kill a build that's still coding or testing.
 */
export function shipBlocker(
  builds: Pick<BuildSummary, "buildId" | "status">[],
  shippingBuildId: string,
  restartsBoop: boolean,
): string | null {
  const blocking = builds.find((b) => {
    if (b.buildId === shippingBuildId) return false;
    if (b.status === "shipping" || b.status === "restarting") return true;
    return restartsBoop && (b.status === "coding" || b.status === "testing");
  });
  if (!blocking) return null;
  if (blocking.status === "coding" || blocking.status === "testing") {
    return `Build ${blocking.buildId} is still ${blocking.status}. Shipping now would restart Boop and stop it, so wait for it to finish, or cancel it first.`;
  }
  return `Build ${blocking.buildId} is still ${blocking.status}. Wait for it to finish before shipping another.`;
}

function line(b: BuildSummary): string {
  const checks = b.testsPassed === false ? " (checks failing)" : "";
  return `${b.buildId} · ${b.status}${checks} · ${b.request.slice(0, 80)}${b.prUrl ? ` · ${b.prUrl}` : ""}`;
}

export function formatBuildList(recent: BuildSummary[], queued: BuildSummary[]): string {
  const queuedIds = new Set(queued.map((b) => b.buildId));
  const others = recent.filter((b) => !queuedIds.has(b.buildId));
  if (others.length === 0 && queued.length === 0) return "No self-builds yet.";
  const parts = others.map(line);
  if (queued.length > 0) {
    parts.push(`Queued (${queued.length}), next first:`);
    queued.forEach((b, i) => parts.push(`${i + 1}. ${b.buildId} · ${b.request.slice(0, 80)}`));
  }
  return parts.join("\n");
}
