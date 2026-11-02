// End to end: the real Go sidecar binary, Boop's real bridge router, and
// Boop's client. Only the sub-agent itself (spawnExecutionAgent) and the model
// behind POST /orchestrator/complete are faked. No ANTHROPIC_API_KEY anywhere:
// the planner and merger come back to Boop.
// Skipped where Go isn't installed.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SpawnOptions, SpawnResult } from "../server/execution-agent.js";
import {
  createOrchestratorBridgeRouter,
  type BridgeCompleteRequest,
  type BridgeCompleteResult,
} from "../server/orchestrator-bridge.js";
import { OrchestratorClient, probeOrchestrator } from "../server/orchestrator-client.js";

function hasGo(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe.skipIf(!hasGo())("orchestrator sidecar end to end", () => {
  let dir = "";
  let sidecar: ChildProcess | null = null;
  let boop: import("node:http").Server | null = null;
  let client: OrchestratorClient;
  const spawned: SpawnOptions[] = [];
  const completions: BridgeCompleteRequest[] = [];
  // The model behind Boop's runtime. Unavailable unless a test says otherwise,
  // so the planner falls back and the merger joins without it.
  let model: (req: BridgeCompleteRequest) => Promise<BridgeCompleteResult> = async () => {
    throw new Error("model unavailable in this test");
  };
  const logs: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "boop-orch-e2e-"));
    const bin = join(dir, "orchestrator");
    execFileSync("go", ["build", "-o", bin, "./cmd/orchestrator"], { cwd: join(process.cwd(), "orchestrator-go"), stdio: "pipe" });

    // Boop's side: the real bridge router with a fake sub-agent.
    const app = express();
    app.use(express.json());
    app.use(
      "/orchestrator",
      createOrchestratorBridgeRouter({
        integrations: () => ["gmail", "browser"],
        complete: (req) => {
          completions.push(req);
          return model(req);
        },
        spawn: async (opts): Promise<SpawnResult> => {
          spawned.push(opts);
          if (opts.task.includes("slow")) {
            return new Promise((resolve) =>
              opts.signal!.addEventListener("abort", () =>
                resolve({ agentId: "agent_slow", status: "cancelled", result: "", attachments: [] }),
              ),
            );
          }
          if (opts.task.includes("calendar")) {
            return { agentId: "agent_cal", status: "failed", result: "usage limit", attachments: [], usageLimited: true };
          }
          return {
            agentId: "agent_web",
            status: "completed",
            result: "Cheapest flight $120 at https://flights.example/deal?id=7&src=boop",
            attachments: [],
            usage: { inputTokens: 700, outputTokens: 300, cacheReadTokens: 50_000, cacheCreationTokens: 0 },
          };
        },
      }),
    );
    boop = app.listen(0, "127.0.0.1");
    await new Promise((r) => boop!.once("listening", r));
    const boopUrl = `http://127.0.0.1:${(boop.address() as AddressInfo).port}`;

    const port = await freePort();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME }; // no ANTHROPIC_API_KEY
    sidecar = spawn(bin, ["-addr", `127.0.0.1:${port}`, "-boop-url", boopUrl, "-max-tokens", "50000"], { env });
    sidecar.stderr?.on("data", (d) => logs.push(String(d)));
    client = new OrchestratorClient({ baseUrl: `http://127.0.0.1:${port}` });
    for (let i = 0; i < 100; i++) {
      if (await probeOrchestrator(client, () => {})) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`sidecar didn't start: ${logs.join("")}`);
  }, 120_000);

  afterAll(async () => {
    sidecar?.kill("SIGTERM");
    await new Promise((r) => boop?.close(r) ?? r(null));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs a plan through Boop's sub-agents and returns one result", async () => {
    const run = await client.submitRun({
      conversationId: "sms:test",
      maxTokens: 40_000,
      plan: {
        goal: "Plan a weekend trip",
        tasks: [
          { id: "web", title: "Flights", agent: "boop", input: "Find flights", integrations: ["browser"], cost_hint: "med" },
          { id: "cal", title: "Calendar", agent: "boop", input: "Check my calendar", integrations: ["gmail"], cost_hint: "low" },
          { id: "all", title: "Collect", agent: "join", input: "collect", depends_on: ["web"], cost_hint: "low" },
        ],
      },
    });
    expect(run.state).toBe("RUNNING");
    const res = await client.waitForResult(run.id, 20_000);
    expect(res.done).toBe(true);
    // The calendar sub-agent hit a usage limit: the run fails, but the result
    // still carries what worked, the URL verbatim, and what didn't.
    expect(res.state).toBe("FAILED");
    expect(res.result?.answer).toContain("https://flights.example/deal?id=7&src=boop");
    expect(res.result?.answer).toContain("Not completed:");
    expect(res.result?.incomplete).toEqual([expect.objectContaining({ id: "cal", state: "FAILED" })]);
    expect(res.result?.sources).toEqual(["https://flights.example/deal?id=7&src=boop"]);

    const st = await client.getRun(run.id);
    const web = st.tasks.find((t) => t.id === "web")!;
    expect(web.tokens).toBe(1000); // real usage over the bridge, not the 8k estimate
    expect(st.tasks.find((t) => t.id === "cal")!.attempts).toBe(1); // usage limits aren't retried
    expect(spawned.every((s) => s.conversationId === "sms:test")).toBe(true);
    expect(spawned.find((s) => s.task.includes("Find flights"))?.integrations).toEqual(["browser"]);
  });

  it("validates requests and rejects plans that can't run", async () => {
    await expect(
      client.submitRun({ plan: { tasks: [{ id: "a", agent: "boop", input: "x", integrations: ["slack"], cost_hint: "low" }] } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(client.getRun("run_0000000000000000")).rejects.toMatchObject({ status: 404 });
  });

  it("reports the planner and merger on via Boop with no API key", async () => {
    expect(await client.health()).toEqual({ ok: true, planner: true, merger: true, llm: "boop" });
  });

  it("plans and merges through Boop's runtime, charging its tokens to the budget", async () => {
    completions.length = 0;
    model = async (req) => {
      if (req.purpose === "planner") {
        return {
          text: JSON.stringify({
            goal: "Compare flights",
            tasks: [
              { id: "a", title: "Airline A", agent: "boop", input: "Find flights on A", integrations: ["browser"], cost_hint: "low" },
              { id: "b", title: "Airline B", agent: "boop", input: "Find flights on B", integrations: ["browser"], cost_hint: "low" },
            ],
          }),
          usage: { inputTokens: 900, outputTokens: 100 },
        };
      }
      return { text: "Best deal: $120 at https://flights.example/deal?id=7&src=boop", usage: { inputTokens: 400, outputTokens: 50 } };
    };
    const run = await client.submitRun({ task: "Compare flights on A and B", maxTokens: 40_000 });
    const res = await client.waitForResult(run.id, 20_000);
    expect(res.state).toBe("SUCCEEDED");
    expect(res.result?.method).toBe("llm");
    expect(res.result?.answer).toContain("https://flights.example/deal?id=7&src=boop");
    expect(res.plan_fallback).toBeUndefined();
    expect(completions.map((c) => c.purpose)).toEqual(["planner", "merger"]);
    expect(completions[1].maxTokens).toBeGreaterThan(0);
    expect(completions[1].maxTokens).toBeLessThanOrEqual(4_000);
    // Planner 1000 + two sub-agents at 1000 each + merger 450.
    expect(res.tokens_used).toBe(3_450);
    const st = await client.getRun(run.id);
    expect(st.planner_tokens).toBe(1_000);
  });

  it("falls back to a one-step plan and a plain join when Boop's model fails", async () => {
    completions.length = 0;
    model = async () => {
      throw new Error("Claude Code process exited with code 1");
    };
    const before = spawned.length;
    const run = await client.submitRun({ task: "Find a cheap flight to Lisbon" });
    const res = await client.waitForResult(run.id, 20_000);
    expect(res.state).toBe("SUCCEEDED");
    expect(res.plan_fallback).toContain("Claude Code process exited");
    const sub = spawned.slice(before);
    expect(sub).toHaveLength(1);
    expect(sub[0].task).toContain("Find a cheap flight to Lisbon");
    expect(res.result?.answer).toContain("https://flights.example/deal?id=7&src=boop");
    expect(completions.every((c) => c.purpose === "planner")).toBe(true);
  });

  it("cancels a run and the Boop sub-agent with it", async () => {
    const run = await client.submitRun({
      plan: { tasks: [{ id: "s", agent: "boop", input: "slow job", cost_hint: "low" }] },
    });
    for (let i = 0; i < 100 && !spawned.some((s) => s.task.includes("slow")); i++) await new Promise((r) => setTimeout(r, 20));
    const slow = spawned.find((s) => s.task.includes("slow"))!;
    expect((await client.cancelRun(run.id)).cancelled).toBe(true);
    const res = await client.waitForResult(run.id, 10_000);
    expect(res.state).toBe("CANCELLED");
    for (let i = 0; i < 100 && !slow.signal!.aborted; i++) await new Promise((r) => setTimeout(r, 20));
    expect(slow.signal!.aborted).toBe(true);
  });
});
