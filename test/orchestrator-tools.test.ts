import { describe, expect, it } from "vitest";
import { OrchestratorClient, OrchestratorError, type RunResultResponse } from "../server/orchestrator-client.js";
import { createOrchestratorTools, formatRunResult, formatRunStatus, ORCHESTRATOR_ALLOWED_TOOLS } from "../server/orchestrator-tools.js";

const RUN = "run_0123456789abcdef";

function fakeClient(over: Partial<OrchestratorClient>): OrchestratorClient {
  return Object.assign(Object.create(OrchestratorClient.prototype), over) as OrchestratorClient;
}

const finished: RunResultResponse = {
  id: RUN,
  state: "FAILED",
  done: true,
  tokens_used: 900,
  token_budget: 10_000,
  result: {
    answer: "Flights from $120: https://flights.example/deal?id=7",
    method: "llm",
    incomplete: [{ id: "cal", title: "Calendar", state: "FAILED", note: "usage limit" }],
  },
};

describe("formatting", () => {
  it("shows the answer, sources and incomplete steps", () => {
    const text = formatRunResult(finished);
    expect(text).toContain(`[orchestration ${RUN} FAILED, 900/10000 tokens]`);
    expect(text).toContain("https://flights.example/deal?id=7");
    expect(text).toContain("- Calendar: failed (usage limit)");
  });

  it("says when a run is still going", () => {
    expect(formatRunResult({ ...finished, state: "RUNNING", done: false, result: undefined })).toContain("Still running");
  });

  it("lists steps in a status", () => {
    const text = formatRunStatus({
      id: RUN,
      state: "SUCCEEDED",
      tasks: [{ id: "a", agent: "boop", state: "SUCCEEDED", attempts: 2, tokens: 5 }],
      token_budget: 0,
      tokens_used: 5,
      result: { answer: "done", method: "single" },
    });
    expect(text).toContain("- a (boop): succeeded, 2 tries");
    expect(text).toContain("done");
  });
});

describe("orchestrator tools", () => {
  it("runs a task tied to the conversation and returns the merged answer", async () => {
    const submitted: unknown[] = [];
    const client = fakeClient({
      submitRun: async (req) => {
        submitted.push(req);
        return { id: RUN, state: "PLANNING", tasks: [], token_budget: 0, tokens_used: 0 };
      },
      waitForResult: async () => finished,
    });
    const tools = createOrchestratorTools("sms:+15550000000", { client, redact: (t) => t.replace("$120", "$X") });
    expect(tools.map((t) => `mcp__${t.namespace}__${t.name}`)).toEqual(ORCHESTRATOR_ALLOWED_TOOLS);
    const run = tools.find((t) => t.name === "run_orchestration")!;
    const res = await run.handle({ task: "Plan my trip", maxTokens: 5000 });
    expect(submitted[0]).toEqual({ task: "Plan my trip", maxTokens: 5000, conversationId: "sms:+15550000000" });
    expect(res.text).toContain("Flights from $X");
    expect(res.success).toBe(true);
  });

  it("tells the dispatcher to fall back to spawn_agent when the sidecar is down", async () => {
    const client = fakeClient({
      submitRun: async () => {
        throw new OrchestratorError("the orchestrator isn't running at http://127.0.0.1:3460", { unreachable: true });
      },
    });
    const run = createOrchestratorTools("c", { client }).find((t) => t.name === "run_orchestration")!;
    const res = await run.handle({ task: "x" });
    expect(res.success).toBe(false);
    expect(res.text).toContain("spawn_agent");
  });

  it("cancels and rejects bad input", async () => {
    const client = fakeClient({
      cancelRun: async () => ({ cancelled: true, run: { id: RUN, state: "RUNNING", tasks: [], token_budget: 0, tokens_used: 0 } }),
    });
    const tools = createOrchestratorTools("c", { client });
    const cancel = tools.find((t) => t.name === "cancel_orchestration")!;
    expect((await cancel.handle({ runId: RUN })).text).toBe(`Cancelling ${RUN}.`);
    await expect(tools.find((t) => t.name === "run_orchestration")!.handle({ task: "x", waitMinutes: 999 })).rejects.toThrow();
  });
});
