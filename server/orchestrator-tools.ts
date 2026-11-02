import { z } from "zod";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "./runtimes/types.js";
import {
  OrchestratorClient,
  OrchestratorError,
  isTerminal,
  type RunResultResponse,
  type RunStatus,
} from "./orchestrator-client.js";
import { formatSidecarStatus, orchestratorSidecar, type OrchestratorSidecar } from "./orchestrator-sidecar.js";

// Dispatcher tools for the Go orchestrator sidecar. They're only offered on a
// turn when the sidecar answered recently (see orchestratorAvailable), so
// Boop never reaches for a tool that can't work.

export const ORCHESTRATOR_NAMESPACE = "boop-orchestrator";

export const ORCHESTRATOR_ALLOWED_TOOLS = [
  `mcp__${ORCHESTRATOR_NAMESPACE}__run_orchestration`,
  `mcp__${ORCHESTRATOR_NAMESPACE}__orchestration_status`,
  `mcp__${ORCHESTRATOR_NAMESPACE}__cancel_orchestration`,
];

/** Always offered, so "is the orchestrator working?" gets a real answer even when it's down. */
export const ORCHESTRATOR_HEALTH_TOOL = `mcp__${ORCHESTRATOR_NAMESPACE}__orchestrator_health`;

export const ORCHESTRATOR_HEALTH_PROMPT = `

Orchestrator health:
- When the owner asks whether the orchestrator is working (or why multi-step orchestration isn't available), call orchestrator_health with selfTest: true and answer from what it returns: running or not, port, last health check, whether ANTHROPIC_API_KEY is stored, and the self-test result. If it says the key isn't stored, offer to request it with request_secret("ANTHROPIC_API_KEY").`;

export const ORCHESTRATOR_DISPATCHER_PROMPT = `

Orchestrator (multi-step work):
- For a big request that splits into several separate lookups or actions (e.g. compare three sources, check email AND calendar AND the web, then write one answer), call run_orchestration with the whole task instead of several spawn_agent calls. It plans the steps, runs them as sub-agents within a token budget, and returns one merged answer with its sources. Send send_ack first.
- Use spawn_agent for single, focused tasks. If run_orchestration says the orchestrator isn't running, fall back to spawn_agent.
- If it's still running when the tool returns, tell the user and check later with orchestration_status. cancel_orchestration stops a run when the user asks.`;

const DEFAULT_WAIT_MINUTES = 10;
const MAX_WAIT_MINUTES = 30;
const MAX_ANSWER_CHARS = 12_000;

export interface OrchestratorToolDeps {
  client?: OrchestratorClient;
  /** Cleans text before it reaches the model (secrets, phone numbers). */
  redact?: (text: string) => string;
}

function errorText(err: unknown): string {
  if (err instanceof OrchestratorError) {
    if (err.unreachable) return `Orchestrator unavailable: ${err.message}. Use spawn_agent instead.`;
    return `Orchestrator error: ${err.message}`;
  }
  return `Orchestrator error: ${err instanceof Error ? err.message : String(err)}`;
}

function clip(text: string, max = MAX_ANSWER_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n…(cut; full answer via orchestration_status)` : text;
}

/** Renders a finished (or still-running) run for the dispatcher. */
export function formatRunResult(res: RunResultResponse): string {
  const head = `[orchestration ${res.id} ${res.state}${res.token_budget ? `, ${res.tokens_used}/${res.token_budget} tokens` : `, ${res.tokens_used} tokens`}]`;
  if (!res.done) {
    return `${head}\nStill running. Check again with orchestration_status("${res.id}"), or cancel_orchestration to stop it.`;
  }
  const r = res.result;
  const lines = [head];
  if (r?.answer?.trim()) lines.push("", clip(r.answer.trim()));
  else lines.push("", "No step produced an answer.");
  if (r?.incomplete?.length) {
    lines.push("", "Steps that didn't complete:");
    for (const s of r.incomplete) lines.push(`- ${s.title || s.id}: ${s.state.toLowerCase()}${s.note ? ` (${s.note})` : ""}`);
  }
  if (r?.method === "fallback" && r.merge_error) lines.push("", `(Results joined without merging: ${r.merge_error})`);
  if (res.error) lines.push("", `Error: ${res.error}`);
  return lines.join("\n");
}

/** Renders a run's status with its steps. */
export function formatRunStatus(st: RunStatus): string {
  const lines = [
    `[orchestration ${st.id} ${st.state}, ${st.tokens_used}${st.token_budget ? `/${st.token_budget}` : ""} tokens]`,
  ];
  for (const t of st.tasks) {
    const why = t.error || t.reason;
    lines.push(`- ${t.title || t.id} (${t.agent}): ${t.state.toLowerCase()}${t.attempts > 1 ? `, ${t.attempts} tries` : ""}${why ? ` — ${why}` : ""}`);
  }
  if (isTerminal(st.state)) {
    const answer = st.result?.answer ?? st.output ?? "";
    lines.push("", answer.trim() ? clip(answer.trim()) : "No answer.");
  }
  if (st.error) lines.push("", `Error: ${st.error}`);
  return lines.join("\n");
}

export function createOrchestratorTools(conversationId: string, deps: OrchestratorToolDeps = {}): RuntimeTool[] {
  const client = deps.client ?? OrchestratorClient.fromEnv();
  const redact = deps.redact ?? ((t: string) => t);
  const runId = z.string().describe('The run id, like "run_0123456789abcdef".');

  return [
    defineRuntimeTool(
      ORCHESTRATOR_NAMESPACE,
      "run_orchestration",
      "Plan a multi-step task and run it with sub-agents (in parallel where possible, within a token budget), then return ONE merged answer with sources kept verbatim. Waits for the result (up to waitMinutes); if it's still running then, returns the run id to check later.",
      {
        task: z.string().describe("The whole task, in plain words, with any details the steps need (who, what, which accounts, dates)."),
        maxTokens: z.number().int().positive().max(2_000_000).optional().describe("Token budget for the run. Leave out for the default."),
        waitMinutes: z
          .number()
          .positive()
          .max(MAX_WAIT_MINUTES)
          .optional()
          .describe(`How long to wait for the answer (default ${DEFAULT_WAIT_MINUTES}).`),
      },
      async (args) => {
        try {
          const run = await client.submitRun({ task: args.task, maxTokens: args.maxTokens, conversationId });
          const res = await client.waitForResult(run.id, (args.waitMinutes ?? DEFAULT_WAIT_MINUTES) * 60_000);
          return runtimeText(redact(formatRunResult(res)));
        } catch (err) {
          return runtimeText(errorText(err), false);
        }
      },
    ),
    defineRuntimeTool(
      ORCHESTRATOR_NAMESPACE,
      "orchestration_status",
      "Status of an orchestration run: each step's state, and the merged answer once it's finished.",
      { runId },
      async (args) => {
        try {
          return runtimeText(redact(formatRunStatus(await client.getRun(args.runId))));
        } catch (err) {
          return runtimeText(errorText(err), false);
        }
      },
    ),
    defineRuntimeTool(
      ORCHESTRATOR_NAMESPACE,
      "cancel_orchestration",
      "Cancel an orchestration run. Running steps are stopped, including Boop sub-agents.",
      { runId },
      async (args) => {
        try {
          const { cancelled, run } = await client.cancelRun(args.runId);
          return runtimeText(cancelled ? `Cancelling ${run.id}.` : `${run.id} had already finished (${run.state}).`);
        } catch (err) {
          return runtimeText(errorText(err), false);
        }
      },
    ),
  ];
}

export function createOrchestratorHealthTool(deps: { sidecar?: () => OrchestratorSidecar } = {}): RuntimeTool {
  const get = deps.sidecar ?? (() => orchestratorSidecar());
  return defineRuntimeTool(
    ORCHESTRATOR_NAMESPACE,
    "orchestrator_health",
    "Is the Go orchestrator sidecar working? Checks it live and reports: running or not, port, last health check, whether ANTHROPIC_API_KEY is stored (never its value), restarts and the log file. With selfTest: true it also submits a tiny two-step test plan and confirms a merged result comes back (takes a few seconds).",
    {
      selfTest: z.boolean().optional().describe("Also run the end-to-end self-test. Default false."),
    },
    async (args) => {
      try {
        const sidecar = get();
        // Picks up a key saved since boot (restarting the sidecar with it).
        await sidecar.refreshKey();
        await sidecar.checkHealth();
        if (args.selfTest) await sidecar.selfTest();
        return runtimeText(formatSidecarStatus(sidecar.status()));
      } catch (err) {
        return runtimeText(`Couldn't check the orchestrator: ${err instanceof Error ? err.message : String(err)}`, false);
      }
    },
  );
}
