import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { cancelAgent, runningAgentActivity } from "./execution-agent.js";
import { broadcast } from "./broadcast.js";
import { isActiveInstance } from "./instance.js";
import { STALLED_AFTER_MS } from "./agent-auto-retry.js";

/** A live run older than this is stopped for good, busy or not. */
export const MAX_RUN_MS = 3 * 60 * 60 * 1000;
const ORPHANED_MS = 90 * 1000;

export type SweepAction = "keep" | "stale" | "timeout" | "orphaned";

/**
 * Live runs are judged by how long they've been quiet, not how long they've
 * run: a long upload that keeps calling tools is fine. Quiet runs are stopped
 * and resumed; only the hard limit stops one for good.
 */
export function classifyRun(
  now: number,
  startedAt: number,
  live: { startedAt: number; lastActivity: number } | undefined,
): SweepAction {
  if (!live) return now - startedAt >= ORPHANED_MS ? "orphaned" : "keep";
  if (now - live.startedAt >= MAX_RUN_MS) return "timeout";
  if (now - live.lastActivity >= STALLED_AFTER_MS) return "stale";
  return "keep";
}

export async function sweepStaleAgents(): Promise<void> {
  const runningInDb = await convex.query(api.agents.list, {
    status: "running",
    limit: 100,
  });
  const now = Date.now();
  const live = runningAgentActivity();

  for (const a of runningInDb) {
    const action = classifyRun(now, a.startedAt, live.get(a.agentId));
    if (action === "keep") continue;

    if (action === "stale" || action === "timeout") {
      // The run itself logs this, decides whether to resume, and writes its
      // final status.
      cancelAgent(a.agentId, action);
      broadcast("agent_stale", { agentId: a.agentId, action });
      continue;
    }

    await convex.mutation(api.agents.update, {
      agentId: a.agentId,
      status: "failed",
      error: `Marked failed after ${Math.round((now - a.startedAt) / 1000)}s (orphaned after backend restart).`,
    });
    broadcast("agent_stale", { agentId: a.agentId, action });
  }
}

export function startHeartbeatLoop(intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    if (!isActiveInstance()) return;
    sweepStaleAgents().catch((err) => console.error("[heartbeat] sweep error", err));
  }, intervalMs);
  return () => clearInterval(timer);
}
