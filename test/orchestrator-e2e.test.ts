// End to end: the real Go sidecar binary, Boop's real bridge router, and
// Boop's client. Only the sub-agent itself (spawnExecutionAgent) is faked.
// Skipped where Go isn't installed.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SpawnOptions, SpawnResult } from "../server/execution-agent.js";
import { createOrchestratorBridgeRouter } from "../server/orchestrator-bridge.js";
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
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
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
    await expect(client.submitRun({ task: "plan this" })).rejects.toMatchObject({ status: 503 }); // no API key, no planner
    await expect(client.getRun("run_0000000000000000")).rejects.toMatchObject({ status: 404 });
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
