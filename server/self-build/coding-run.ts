/**
 * The self-build coding run, with the same hardening execution agents have:
 * - a dropped connection (network, 5xx, overloaded) waits and resumes the same
 *   Claude session up to 3 times (agent-auto-retry), so a long build isn't
 *   thrown away; the worktree keeps every edit made so far
 * - a usage/spend limit fails at once with a plain message, never retried
 * - usage is added up across attempts and recorded even when the run fails
 */
import {
  addUsage,
  AUTO_RETRY_DELAYS_MS,
  isTransientAgentError,
  RESUME_PROMPT,
  retryNotice,
  waitUnlessAborted,
} from "../agent-auto-retry.js";
import type { RuntimeRunRequest, RuntimeRunResult } from "../runtimes/types.js";
import { EMPTY_USAGE, type UsageTotals } from "../usage.js";
import { isUsageLimitError } from "../usage-limit.js";
import { redactSecrets, redactValues, type KnownSecret } from "../secrets/redact.js";

export class SelfBuildUsageLimitError extends Error {
  constructor(detail: string) {
    super(
      `The coding model hit its usage limit, so the build stopped. Retry it once the limit resets. (${detail.split("\n")[0].slice(0, 200)})`,
    );
    this.name = "SelfBuildUsageLimitError";
  }
}

export interface CodingRunDeps {
  run: (request: Omit<RuntimeRunRequest, "model" | "reasoningEffort">) => Promise<RuntimeRunResult>;
  /** Called once with the run's total usage, whether it succeeded or not. */
  recordUsage: (usage: UsageTotals) => Promise<void>;
  /** Shown on the build's activity line before each automatic retry. */
  onRetry?: (notice: string) => Promise<void> | void;
  delaysMs?: readonly number[];
}

export type CodingRunRequest = Omit<RuntimeRunRequest, "model" | "reasoningEffort" | "abortController"> & {
  abortController: AbortController;
};

export async function runCodingWithRetries(
  request: CodingRunRequest,
  deps: CodingRunDeps,
): Promise<{ summary: string; retries: number }> {
  const delays = deps.delaysMs ?? AUTO_RETRY_DELAYS_MS;
  const signal = request.abortController.signal;
  let usage: UsageTotals = { ...EMPTY_USAGE };
  let sessionId: string | undefined;
  let attempt = 0;
  try {
    for (;;) {
      const resumeSessionId = attempt > 0 ? sessionId : undefined;
      try {
        const result = await deps.run({
          ...request,
          ...(resumeSessionId ? { prompt: RESUME_PROMPT, resumeSessionId } : {}),
          onSessionId: (id) => {
            sessionId = id;
            request.onSessionId?.(id);
          },
        });
        usage = addUsage(usage, result.usage);
        if (isUsageLimitError(result.text, result.errorCode)) {
          throw new SelfBuildUsageLimitError(result.text);
        }
        if (result.errorCode && isTransientAgentError(result.text, result.errorCode)) {
          throw new Error(`${result.errorCode}: ${result.text.trim().slice(0, 500)}`);
        }
        return { summary: result.text.trim(), retries: attempt };
      } catch (err) {
        if (err instanceof SelfBuildUsageLimitError) throw err;
        if (isUsageLimitError(err)) throw new SelfBuildUsageLimitError(String(err));
        const delay = delays[attempt];
        // The worktree keeps every edit, so starting over without a session
        // is safe here (the agent sees its own changes); unlike execution
        // agents, a build never sends anything until it opens its PR.
        if (delay === undefined || signal.aborted || !isTransientAgentError(err)) throw err;
        attempt++;
        await deps.onRetry?.(retryNotice(attempt, delay, String(err)));
        if (!(await waitUnlessAborted(delay, signal))) throw err;
      }
    }
  } finally {
    if (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.costUsd > 0) {
      await deps.recordUsage(usage).catch(() => undefined);
    }
  }
}

/** Env names whose values are credentials (the ones codingEnv keeps from the agent). */
export const SECRET_ENV_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|SENDBLUE|CONVEX|COMPOSIO|DATABASE_URL/i;

/**
 * Scrubs a build's text before it is saved, texted or put in a PR body (which
 * is public on GitHub): stored secrets, plus the credential values in Boop's
 * own environment, which the coding agent may have printed from a file.
 */
export function redactBuildText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;
  const fromEnv: KnownSecret[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.trim().length >= 8 && SECRET_ENV_NAME.test(name)) fromEnv.push({ name, value });
  }
  return redactValues(redactSecrets(text), fromEnv);
}
