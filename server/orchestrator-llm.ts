import type { RuntimeConfig } from "./runtime-config.js";
import type { RuntimeRunRequest, RuntimeRunResult } from "./runtimes/types.js";
import { isUsageLimitError } from "./usage-limit.js";
import type { UsageTotals } from "./usage.js";
import {
  CompletionUsageLimitError,
  type BridgeCompleteBody,
  type BridgeCompleteRequest,
  type BridgeCompleteResult,
} from "./orchestrator-bridge.js";

// The Go orchestrator sidecar's planner, llm agent and result merger call
// POST /orchestrator/complete; this runs that prompt through Boop's own model
// runtime, the same one every other background call uses (the Claude Agent
// SDK by default, signed in with the Claude account on this Mac). No
// ANTHROPIC_API_KEY is needed. A key stored for the sidecar still overrides
// this: the sidecar then calls the API itself and never comes here.
//
// The call has no tools: the prompt can carry text sub-agents fetched from the
// web, so it must not be able to act on anything.

/** Built-in tools a completion must never use. */
export const COMPLETION_DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Task",
  "Skill",
  "TodoWrite",
];

/**
 * The runtimes take one prompt, not a message list. A single user message is
 * sent as it is; a longer exchange (the planner's "that plan was rejected,
 * try again") is written out as a transcript ending with the latest message.
 */
export function formatCompletionPrompt(messages: BridgeCompleteBody["messages"]): string {
  if (messages.length === 1) return messages[0].content;
  const earlier = messages.slice(0, -1).map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`);
  return [
    "The conversation so far:",
    "",
    ...earlier,
    "",
    "Reply to this latest message:",
    "",
    messages[messages.length - 1].content,
  ].join("\n");
}

/**
 * The runtime can't cap output tokens, so the sidecar's limit (sized to what's
 * left of the run's token budget) goes into the system prompt instead.
 */
export function completionSystemPrompt(system: string, maxTokens?: number): string {
  if (!maxTokens) return system;
  const words = Math.max(50, Math.floor(maxTokens * 0.7));
  return `${system}\n\nKeep your reply under ${maxTokens} tokens (about ${words} words).`;
}

export interface CompletionDeps {
  runtimeConfig: () => Promise<RuntimeConfig>;
  run: (config: RuntimeConfig, request: Omit<RuntimeRunRequest, "model" | "reasoningEffort">) => Promise<RuntimeRunResult>;
  /** Records the call's usage (best effort). */
  recordUsage?: (u: { purpose: string; usage: UsageTotals; config: RuntimeConfig; durationMs: number }) => Promise<void>;
  now?: () => number;
}

export async function completeWithRuntime(req: BridgeCompleteRequest, deps: CompletionDeps): Promise<BridgeCompleteResult> {
  const now = deps.now ?? Date.now;
  const config = await deps.runtimeConfig();
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (req.signal.aborted) abortController.abort();
  else req.signal.addEventListener("abort", onAbort, { once: true });
  const started = now();
  try {
    let result: RuntimeRunResult;
    try {
      result = await deps.run(config, {
        prompt: formatCompletionPrompt(req.messages),
        systemPrompt: completionSystemPrompt(req.system, req.maxTokens),
        tools: [],
        disallowedTools: COMPLETION_DISALLOWED_TOOLS,
        mode: "background",
        abortController,
      });
    } catch (err) {
      if (isUsageLimitError(err)) throw new CompletionUsageLimitError(`usage limit: ${errorMessage(err).slice(0, 300)}`);
      throw err;
    }
    await deps
      .recordUsage?.({ purpose: req.purpose ?? "orchestrator", usage: result.usage, config, durationMs: now() - started })
      .catch(() => undefined);
    if (isUsageLimitError(result.text, result.errorCode)) {
      throw new CompletionUsageLimitError(`usage limit: ${result.text.trim().slice(0, 300)}`);
    }
    if (result.errorCode) throw new Error(`model error (${result.errorCode}): ${result.text.trim().slice(0, 300)}`);
    const text = result.text.trim();
    if (!text) throw new Error("the model returned an empty answer");
    return {
      text,
      usage: {
        inputTokens: Math.max(0, result.usage.inputTokens),
        outputTokens: Math.max(0, result.usage.outputTokens),
      },
    };
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
