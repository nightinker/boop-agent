/**
 * Lets the owner ask Boop, in chat, which agent runs failed and to retry one:
 * the same retry the dashboard's Retry button starts (startAgentRetry), with
 * the answer texted back to the conversation the run came from.
 */
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { notifyConversation } from "./notify.js";
import { retryAgent } from "./execution-agent.js";
import { RETRYABLE_STATUSES, startAgentRetry, type RetryDeps } from "./agent-retry.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";

export const AGENT_RETRY_NAMESPACE = "boop-agent-retry";
export const AGENT_RETRY_ALLOWED_TOOLS = [
  `mcp__${AGENT_RETRY_NAMESPACE}__list_failed_agents`,
  `mcp__${AGENT_RETRY_NAMESPACE}__retry_agent`,
];

export interface AgentRow {
  agentId: string;
  name: string;
  status: string;
  conversationId?: string;
  error?: string;
  startedAt: number;
  retryOf?: string;
}

export interface AgentRetryToolDeps extends RetryDeps {
  /** Recent runs, newest first. */
  recentAgents: (limit: number) => Promise<AgentRow[]>;
  now?: () => number;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The failed and cancelled runs, newest first, each with the newest retry of
 * it (if any), so "retry the ones that still failed" can be answered.
 */
export function describeFailedAgents(rows: AgentRow[], limit: number, now: number): string {
  const retries = new Map<string, AgentRow>();
  for (const row of rows) {
    if (row.retryOf && !retries.has(row.retryOf)) retries.set(row.retryOf, row);
  }
  const failed = rows.filter((row) => RETRYABLE_STATUSES.has(row.status)).slice(0, limit);
  if (failed.length === 0) return "No failed or cancelled agent runs in the recent history.";
  const lines = failed.map((row) => {
    const reason = (row.error ?? "").split("\n")[0].slice(0, 160) || "(no error text)";
    const retry = retries.get(row.agentId);
    const retried = retry ? ` — retried as ${retry.agentId} (${retry.status})` : "";
    return `- ${row.agentId} "${row.name}" ${row.status} ${ago(now - row.startedAt)}: ${reason}${retried}`;
  });
  return `${failed.length} failed/cancelled run(s), newest first:\n${lines.join("\n")}`;
}

export function createAgentRetryTools(deps: AgentRetryToolDeps = defaultDeps()): RuntimeTool[] {
  return [
    defineRuntimeTool(
      AGENT_RETRY_NAMESPACE,
      "list_failed_agents",
      "List recent sub-agent runs that failed or were cancelled (newest first), with their agentId, label, error and whether a retry of each already ran. Use when the user asks what failed, which requests didn't go through, or before retry_agent.",
      {
        limit: z.number().int().min(1).max(50).optional().describe("How many to list (default 10)."),
      },
      async (args) => {
        const limit = args.limit ?? 10;
        const rows = await deps.recentAgents(Math.max(100, limit * 4));
        return runtimeText(describeFailedAgents(rows, limit, (deps.now ?? Date.now)()));
      },
    ),
    defineRuntimeTool(
      AGENT_RETRY_NAMESPACE,
      "retry_agent",
      "Retry a failed or cancelled sub-agent run by its agentId (from list_failed_agents): it re-runs with the same task, integrations and model, and its answer is texted to the user when it finishes. Returns at once with the new run's id; do not wait for it or spawn the task again yourself.",
      {
        agentId: z.string().describe("The agentId of the failed run, e.g. agent_mw0vpzmp_5z0rcn."),
      },
      async (args) => {
        const result = await startAgentRetry(args.agentId.trim(), deps);
        if (!result.ok) return runtimeText(`Couldn't retry ${args.agentId}: ${result.error}`, false);
        return runtimeText(
          `Retry started as ${result.agentId}. Its answer will be sent to the user when it finishes.`,
        );
      },
    ),
  ];
}

function defaultDeps(): AgentRetryToolDeps {
  return {
    getAgent: (agentId) => convex.query(api.agents.get, { agentId }),
    retry: retryAgent,
    notify: (conversationId, text) => notifyConversation(conversationId, text, "agent_retried"),
    recentAgents: async (limit) => (await convex.query(api.agents.list, { limit })) as AgentRow[],
  };
}
