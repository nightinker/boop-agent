/**
 * Retry from the dashboard: re-runs a finished agent with the same task,
 * integrations and model, and texts the new answer to the conversation the
 * original run came from, the way other background jobs report back.
 *
 * startAgentRetry resolves as soon as the new run exists (so the dashboard can
 * open it); the run itself carries on in the background.
 */
import type { SpawnOptions, SpawnResult } from "./execution-agent.js";

/** Only finished runs that didn't produce an answer can be retried. */
export const RETRYABLE_STATUSES = new Set(["failed", "cancelled"]);

export interface RetryDeps {
  getAgent: (agentId: string) => Promise<{ status: string; name: string; conversationId?: string } | null>;
  retry: (agentId: string, extra: Pick<SpawnOptions, "onStarted">) => Promise<SpawnResult | null>;
  notify: (conversationId: string, text: string) => Promise<void>;
  log?: Pick<Console, "error">;
}

export type StartRetryResult =
  | { ok: true; agentId: string }
  | { ok: false; status: 404 | 409 | 500; error: string };

export function retriedMessage(name: string, result: string): string {
  return `Retried "${name}":\n\n${result.trim()}`;
}

export async function startAgentRetry(agentId: string, deps: RetryDeps): Promise<StartRetryResult> {
  const original = await deps.getAgent(agentId);
  if (!original) return { ok: false, status: 404, error: "agent not found" };
  if (!RETRYABLE_STATUSES.has(original.status)) {
    return { ok: false, status: 409, error: `only failed or cancelled runs can be retried (this one is ${original.status})` };
  }

  return await new Promise<StartRetryResult>((resolve) => {
    let started = false;
    deps
      .retry(agentId, {
        onStarted: (newId) => {
          started = true;
          resolve({ ok: true, agentId: newId });
        },
      })
      .then(async (result) => {
        if (!started) {
          resolve({ ok: false, status: 500, error: "the retry didn't start" });
          return;
        }
        if (!result || result.status !== "completed" || result.usageLimited) return;
        if (!original.conversationId || !result.result.trim()) return;
        await deps.notify(original.conversationId, retriedMessage(original.name, result.result));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!started) resolve({ ok: false, status: 500, error: message });
        else (deps.log ?? console).error(`[agent-retry] retry of ${agentId} failed`, err);
      });
  });
}
