import express from "express";
import type { SpawnOptions, SpawnResult } from "./execution-agent.js";

// The Go orchestrator sidecar (orchestrator-go/) calls this to run one of
// Boop's own sub-agents as a task in its plan. It's the same path spawn_agent
// takes, minus the chat turn: no images, no attachments. The route sits behind
// the normal local/Access check in index.ts, so only this Mac can reach it.
//
// It also serves the sidecar's planner, llm agent and result merger: POST
// /complete runs one prompt through Boop's own model runtime (the Claude Agent
// SDK, signed in with the Claude account on this Mac) and returns the text, so
// the sidecar needs no ANTHROPIC_API_KEY. See orchestrator-llm.ts.
//
// Cancellation: the sidecar cancels a task by dropping the HTTP request. When
// the connection closes before we answer, the sub-agent (or completion) is
// aborted.

export interface OrchestratorBridgeDeps {
  spawn: (opts: SpawnOptions) => Promise<SpawnResult>;
  integrations: () => string[];
  /** Runs one completion for the sidecar. Without it POST /complete answers 503. */
  complete?: (req: BridgeCompleteRequest) => Promise<BridgeCompleteResult>;
}

export type CompletionPurpose = "planner" | "merger" | "llm-agent";

export interface BridgeCompleteBody {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  purpose?: CompletionPurpose;
}

export interface BridgeCompleteRequest extends BridgeCompleteBody {
  signal: AbortSignal;
}

export interface BridgeCompleteResult {
  text: string;
  /** Fresh input + output tokens; the sidecar charges them to the run's budget. */
  usage?: { inputTokens: number; outputTokens: number };
}

/** Thrown by a completion that hit the account's usage limit (retrying won't help). */
export class CompletionUsageLimitError extends Error {
  readonly usageLimited = true;
}

/** Caps one completion's prompt (system + every message). A merge of many long steps stays well under it. */
export const MAX_COMPLETE_CHARS = 600_000;
const MAX_COMPLETE_MESSAGES = 20;
const PURPOSES: CompletionPurpose[] = ["planner", "merger", "llm-agent"];

export const MAX_TASK_CHARS = 20_000;

export interface BridgeSpawnBody {
  task: string;
  integrations: string[];
  name?: string;
  conversationId?: string;
}

/** Checks the request body. Returns the parsed body or an error message. */
export function parseBridgeSpawnBody(
  body: unknown,
  available: string[],
): { ok: true; value: BridgeSpawnBody } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const task = typeof b.task === "string" ? b.task.trim() : "";
  if (!task) return { ok: false, error: "task is required" };
  if (task.length > MAX_TASK_CHARS) return { ok: false, error: `task is longer than ${MAX_TASK_CHARS} characters` };
  const raw = b.integrations ?? [];
  if (!Array.isArray(raw) || raw.some((i) => typeof i !== "string")) {
    return { ok: false, error: "integrations must be a list of names" };
  }
  const integrations = [...new Set((raw as string[]).map((i) => i.trim()).filter(Boolean))];
  const unknown = integrations.filter((i) => !available.includes(i));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown integrations: ${unknown.join(", ")} (available: ${available.join(", ") || "none"})` };
  }
  if (b.name !== undefined && typeof b.name !== "string") return { ok: false, error: "name must be a string" };
  if (b.conversationId !== undefined && typeof b.conversationId !== "string") {
    return { ok: false, error: "conversationId must be a string" };
  }
  return {
    ok: true,
    value: {
      task,
      integrations,
      ...(b.name ? { name: (b.name as string).slice(0, 80) } : {}),
      ...(b.conversationId ? { conversationId: b.conversationId as string } : {}),
    },
  };
}

/** Checks a POST /complete body. Returns the parsed body or an error message. */
export function parseBridgeCompleteBody(
  body: unknown,
): { ok: true; value: BridgeCompleteBody } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.system !== undefined && typeof b.system !== "string") return { ok: false, error: "system must be a string" };
  const raw = b.messages;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "messages are required" };
  if (raw.length > MAX_COMPLETE_MESSAGES) return { ok: false, error: `at most ${MAX_COMPLETE_MESSAGES} messages` };
  const messages: BridgeCompleteBody["messages"] = [];
  for (const m of raw as Array<Record<string, unknown>>) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return { ok: false, error: 'each message needs role "user" or "assistant" and string content' };
    }
    messages.push({ role: m.role, content: m.content });
  }
  if (messages[messages.length - 1].role !== "user") return { ok: false, error: "the last message must be from the user" };
  if (!messages[messages.length - 1].content.trim()) return { ok: false, error: "the last message is empty" };
  const system = typeof b.system === "string" ? b.system : "";
  const chars = system.length + messages.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_COMPLETE_CHARS) return { ok: false, error: `prompt is longer than ${MAX_COMPLETE_CHARS} characters` };
  const maxTokens = b.max_tokens;
  if (maxTokens !== undefined && (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 0)) {
    return { ok: false, error: "max_tokens must be a non-negative integer" };
  }
  const purpose = b.purpose;
  if (purpose !== undefined && !PURPOSES.includes(purpose as CompletionPurpose)) {
    return { ok: false, error: `purpose must be one of ${PURPOSES.join(", ")}` };
  }
  return {
    ok: true,
    value: {
      system,
      messages,
      ...(maxTokens ? { maxTokens: maxTokens as number } : {}),
      ...(purpose ? { purpose: purpose as CompletionPurpose } : {}),
    },
  };
}

export function createOrchestratorBridgeRouter(deps: OrchestratorBridgeDeps): express.Router {
  const router = express.Router();

  router.get("/integrations", (_req, res) => {
    res.json({ integrations: deps.integrations() });
  });

  router.post("/spawn", async (req, res) => {
    const parsed = parseBridgeSpawnBody(req.body, deps.integrations());
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const abort = new AbortController();
    // "close" fires on the response once the socket goes away; if we haven't
    // answered by then, the caller gave up (or was cancelled).
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      const result = await deps.spawn({ ...parsed.value, signal: abort.signal });
      if (abort.signal.aborted) return;
      res.json({
        agentId: result.agentId,
        status: result.status,
        result: result.result,
        ...(result.usageLimited ? { usageLimited: true } : {}),
        // A failure after the sub-agent's own retries: the sidecar shouldn't retry again.
        ...(result.autoRetries ? { autoRetries: result.autoRetries } : {}),
        // The sidecar charges these to the run's token budget.
        ...(result.usage ? { usage: result.usage } : {}),
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      res.status(500).json({ status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/complete", async (req, res) => {
    if (!deps.complete) {
      res.status(503).json({ error: "completions aren't available on this Boop" });
      return;
    }
    const parsed = parseBridgeCompleteBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      const result = await deps.complete({ ...parsed.value, signal: abort.signal });
      if (abort.signal.aborted) return;
      res.json({ text: result.text, ...(result.usage ? { usage: result.usage } : {}) });
    } catch (err) {
      if (abort.signal.aborted) return;
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof CompletionUsageLimitError ? { usageLimited: true } : {}),
      });
    }
  });

  return router;
}
