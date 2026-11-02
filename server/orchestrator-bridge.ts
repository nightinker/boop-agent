import express from "express";
import type { SpawnOptions, SpawnResult } from "./execution-agent.js";

// The Go orchestrator sidecar (orchestrator-go/) calls this to run one of
// Boop's own sub-agents as a task in its plan. It's the same path spawn_agent
// takes, minus the chat turn: no images, no attachments. The route sits behind
// the normal local/Access check in index.ts, so only this Mac can reach it.
//
// Cancellation: the sidecar cancels a task by dropping the HTTP request. When
// the connection closes before we answer, the sub-agent is aborted.

export interface OrchestratorBridgeDeps {
  spawn: (opts: SpawnOptions) => Promise<SpawnResult>;
  integrations: () => string[];
}

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
        // The sidecar charges these to the run's token budget.
        ...(result.usage ? { usage: result.usage } : {}),
      });
    } catch (err) {
      if (abort.signal.aborted) return;
      res.status(500).json({ status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
