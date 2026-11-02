import express from "express";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  OrchestratorClient,
  OrchestratorError,
  orchestratorAvailable,
  parseOrchestratorUrl,
  probeOrchestrator,
  resetOrchestratorProbe,
  validateSubmit,
} from "../server/orchestrator-client.js";

const RUN = "run_0123456789abcdef";

async function fakeSidecar(setup: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  setup(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

/** A localhost port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

afterEach(() => resetOrchestratorProbe());

describe("parseOrchestratorUrl", () => {
  it("accepts loopback http URLs only", () => {
    expect(parseOrchestratorUrl("http://127.0.0.1:3460/")).toEqual({ ok: true, url: "http://127.0.0.1:3460" });
    expect(parseOrchestratorUrl("http://localhost:1").ok).toBe(true);
    expect(parseOrchestratorUrl("http://[::1]:1").ok).toBe(true);
    for (const bad of ["http://192.168.1.2:3460", "https://127.0.0.1:1", "http://example.com", "nope", "http://u:p@127.0.0.1:1"]) {
      expect(parseOrchestratorUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe("validateSubmit", () => {
  it("needs exactly one of task or plan, and sane limits", () => {
    expect(validateSubmit({ task: "x" })).toBeNull();
    expect(validateSubmit({ plan: { tasks: [] } })).toBeNull();
    expect(validateSubmit({})).toMatch(/exactly one/);
    expect(validateSubmit({ task: "  " })).toMatch(/exactly one/);
    expect(validateSubmit({ task: "x", plan: {} })).toMatch(/exactly one/);
    expect(validateSubmit({ plan: [] })).toMatch(/object/);
    expect(validateSubmit({ task: "x".repeat(20_001) })).toMatch(/longer/);
    expect(validateSubmit({ task: "x", maxTokens: 0 })).toMatch(/maxTokens/);
    expect(validateSubmit({ task: "x", maxParallel: 1.5 })).toMatch(/maxParallel/);
  });
});

describe("OrchestratorClient", () => {
  it("submits, polls, fetches the result and cancels", async () => {
    const seen: unknown[] = [];
    const { base, close } = await fakeSidecar((app) => {
      app.post("/v1/runs", (req, res) => {
        seen.push({ body: req.body, auth: req.headers.authorization });
        res.status(202).json({ id: RUN, state: "PLANNING", tasks: [], token_budget: 1000, tokens_used: 0 });
      });
      let polls = 0;
      app.get(`/v1/runs/${RUN}/result`, (req, res) => {
        seen.push({ wait: req.query.wait });
        if (++polls < 2) res.status(202).json({ id: RUN, state: "RUNNING", done: false, tokens_used: 10, token_budget: 1000 });
        else res.json({ id: RUN, state: "SUCCEEDED", done: true, result: { answer: "hi", method: "llm" }, tokens_used: 20, token_budget: 1000 });
      });
      app.post(`/v1/runs/${RUN}/cancel`, (_req, res) => {
        res.status(409).json({ error: "run already finished", run: { id: RUN, state: "SUCCEEDED", tasks: [] } });
      });
    });
    try {
      const client = new OrchestratorClient({ baseUrl: base, token: "tok" });
      const run = await client.submitRun({ task: " find it ", maxTokens: 1000, conversationId: "sms:1" });
      expect(run.id).toBe(RUN);
      expect(seen[0]).toEqual({ body: { task: "find it", max_tokens: 1000, conversation_id: "sms:1" }, auth: "Bearer tok" });

      const res = await client.waitForResult(RUN, 60_000);
      expect(res).toMatchObject({ done: true, result: { answer: "hi" } });
      expect((seen[1] as { wait: string }).wait).toBe("55");

      expect(await client.cancelRun(RUN)).toMatchObject({ cancelled: false, run: { state: "SUCCEEDED" } });
    } finally {
      await close();
    }
  });

  it("turns sidecar errors into clear OrchestratorErrors", async () => {
    const { base, close } = await fakeSidecar((app) => {
      app.post("/v1/runs", (_req, res) => {
        res.status(422).json({ error: "invalid plan", problems: ["task a: unknown agent"] });
      });
    });
    try {
      const client = new OrchestratorClient({ baseUrl: base });
      const err = await client.submitRun({ plan: { tasks: [] } }).catch((e) => e);
      expect(err).toBeInstanceOf(OrchestratorError);
      expect(err.status).toBe(422);
      expect(err.problems).toEqual(["task a: unknown agent"]);
      expect(err.message).toContain("unknown agent");

      await expect(client.getRun("../etc")).rejects.toThrow(/bad run id/);
      await expect(client.submitRun({})).rejects.toThrow(/exactly one/);
    } finally {
      await close();
    }
  });

  it("refuses a non-local URL without making a request", async () => {
    let called = false;
    const client = new OrchestratorClient({
      baseUrl: "http://10.0.0.5:3460",
      fetch: (async () => {
        called = true;
        return new Response("{}");
      }) as typeof fetch,
    });
    await expect(client.health()).rejects.toThrow(/localhost/);
    expect(called).toBe(false);
  });

  it("reports an unreachable sidecar without throwing at startup", async () => {
    const port = await closedPort();
    const client = new OrchestratorClient({ baseUrl: `http://127.0.0.1:${port}` });
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(OrchestratorError);
    expect(err.unreachable).toBe(true);
    expect(err.message).toContain("isn't running");

    const logs: string[] = [];
    await expect(probeOrchestrator(client, (m) => logs.push(m))).resolves.toBe(false);
    expect(logs[0]).toContain("continuing without it");
    // Cached: the next check doesn't hit the network.
    await expect(orchestratorAvailable(client)).resolves.toBe(false);
  });

  it("probes a running sidecar", async () => {
    const { base, close } = await fakeSidecar((app) => {
      app.get("/healthz", (_req, res) => {
        res.json({ ok: true, planner: false });
      });
    });
    try {
      const logs: string[] = [];
      expect(await probeOrchestrator(new OrchestratorClient({ baseUrl: base }), (m) => logs.push(m))).toBe(true);
      expect(logs[0]).toContain("sidecar up");
      expect(logs[0]).toContain("plans only");
    } finally {
      await close();
    }
  });
});
