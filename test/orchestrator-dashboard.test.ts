import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorClient, OrchestratorError, type RunStatus } from "../server/orchestrator-client.js";
import {
  MAX_RUNS_LISTED,
  buildOverview,
  createOrchestratorDashboardRouter,
  readLogTail,
  runDetail,
  sidecarHealth,
  sidecarView,
  stepLevels,
  summarizeRun,
  type OrchestratorDashboardDeps,
  type OrchestratorOverview,
} from "../server/orchestrator-dashboard.js";
import type { SidecarStatus } from "../server/orchestrator-sidecar.js";
import {
  NODE_W,
  countsLine,
  detailPollMs,
  formatMs,
  layoutGraph,
  overviewPollMs,
  timelineBars,
} from "../debug/src/lib/orchestrator.js";
import { OrchestratorView, RunDetailBody } from "../debug/src/components/OrchestratorPanel.js";

const FAKE_KEY = "sk-ant-test-NOT-A-REAL-KEY-0123456789abcdef";
const NOW = Date.parse("2026-11-02T12:00:00Z");
const iso = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function status(over: Partial<SidecarStatus> = {}): SidecarStatus {
  return {
    state: "running",
    managed: true,
    url: "http://127.0.0.1:3460",
    port: 3460,
    pid: 4242,
    binary: "/x/data/orchestrator/bin/orchestrator",
    logFile: "/nonexistent/data/orchestrator/orchestrator.log",
    keyPresent: true,
    keyPassed: true,
    restarts: 0,
    startedAt: NOW - 90_000,
    lastHealth: { at: NOW - 1_000, ok: true, planner: true },
    lastExit: null,
    lastSelfTest: null,
    problem: null,
    nextRestartAt: null,
    ...over,
  };
}

/** gather and check both depend on nothing; report waits on both. */
function diamondRun(over: Partial<RunStatus> = {}): RunStatus {
  return {
    id: "run_0123456789abcdef",
    state: "RUNNING",
    task: "Compare flights and hotels",
    plan: {
      goal: "Compare flights and hotels for the trip",
      tasks: [
        { id: "flights", title: "Find flights", agent: "boop", input: "search flights", cost_hint: "med" },
        { id: "hotels", title: "Find hotels", agent: "boop", input: "search hotels", cost_hint: "med" },
        { id: "report", title: "Write it up", agent: "echo", input: "combine", depends_on: ["flights", "hotels"], cost_hint: "low" },
      ],
    },
    tasks: [
      { id: "flights", title: "Find flights", agent: "boop", state: "SUCCEEDED", attempts: 1, tokens: 1200, output: "Flight A https://example.com/a", started_at: iso(60_000), finished_at: iso(30_000) },
      { id: "hotels", title: "Find hotels", agent: "boop", state: "RUNNING", attempts: 2, tokens: 0, started_at: iso(50_000) },
      { id: "report", title: "Write it up", agent: "echo", state: "PENDING", attempts: 0, tokens: 0 },
    ],
    token_budget: 100_000,
    tokens_used: 1200,
    max_parallel: 2,
    created_at: iso(61_000),
    finished_at: "0001-01-01T00:00:00Z",
    ...over,
  };
}

function fakeClient(runs: RunStatus[] | Error): OrchestratorDashboardDeps["client"] {
  return {
    listRuns: async () => {
      if (runs instanceof Error) throw runs;
      return runs;
    },
    getRun: async (id: string) => {
      if (runs instanceof Error) throw runs;
      const r = runs.find((x) => x.id === id);
      if (!r) throw new OrchestratorError("run not found", { status: 404 });
      return r;
    },
  };
}

describe("sidecar status for the dashboard", () => {
  it("maps the supervisor's states to running, starting, restarting, down and not configured", () => {
    expect(sidecarHealth(status())).toBe("running");
    expect(sidecarHealth(status({ state: "external" }))).toBe("running");
    expect(sidecarHealth(status({ state: "restarting", lastHealth: { at: NOW, ok: false } }))).toBe("restarting");
    expect(sidecarHealth(status({ state: "building", lastHealth: null }))).toBe("starting");
    expect(sidecarHealth(status({ state: "failed", lastHealth: { at: NOW, ok: false } }))).toBe("down");
    expect(sidecarHealth(status({ state: "running", lastHealth: { at: NOW, ok: false } }))).toBe("down");
    expect(sidecarHealth(status({ state: "stopped", lastHealth: { at: NOW, ok: false } }))).toBe("down");
    expect(sidecarHealth(status({ state: "idle", lastHealth: null }))).toBe("not_configured");
    expect(sidecarHealth(status({ state: "disabled", lastHealth: { at: NOW, ok: false } }))).toBe("not_configured");
    // ORCHESTRATOR_SIDECAR=off but one is running by hand: that's running.
    expect(sidecarHealth(status({ state: "disabled" }))).toBe("running");
    expect(sidecarHealth(status({ state: "failed", problem: "ORCHESTRATOR_URL must be on localhost (got x)" }))).toBe("not_configured");
  });

  it("reports uptime, restarts and the backoff, and only whether the key is present", () => {
    const v = sidecarView(status({ restarts: 3 }), NOW);
    expect(v.uptimeMs).toBe(90_000);
    expect(v.restarts).toBe(3);
    expect(v.keyPresent).toBe(true);
    expect(v.planner).toBe(true);
    const backing = sidecarView(status({ state: "restarting", lastHealth: { at: NOW, ok: false }, nextRestartAt: NOW + 4_000 }), NOW);
    expect(backing.uptimeMs).toBeNull();
    expect(backing.nextRestartInMs).toBe(4_000);
    expect(Object.keys(v)).not.toContain("binary");
  });

  it("scrubs anything that looks like a key from the problem and health error", () => {
    const v = sidecarView(
      status({ state: "failed", problem: `exited with ANTHROPIC_API_KEY=${FAKE_KEY}`, lastHealth: { at: NOW, ok: false, error: `bad ${FAKE_KEY}` } }),
      NOW,
    );
    expect(JSON.stringify(v)).not.toContain(FAKE_KEY);
  });
});

describe("log tail", () => {
  it("returns the last lines, scrubbed, and an empty list when there's no log", async () => {
    const d = mkdtempSync(join(tmpdir(), "boop-orch-log-"));
    dirs.push(d);
    const file = join(d, "orchestrator.log");
    expect(await readLogTail(file)).toEqual([]);
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    lines.push(`leaked ${FAKE_KEY}`, "");
    writeFileSync(file, lines.join("\n"));
    const tail = await readLogTail(file, 5);
    expect(tail).toHaveLength(5);
    expect(tail.slice(0, 4)).toEqual(["line 56", "line 57", "line 58", "line 59"]);
    expect(tail[4]).not.toContain(FAKE_KEY);
    expect(tail[4]).toContain("leaked");
  });

  it("drops the first, probably cut, line when reading from the middle of a big log", async () => {
    const d = mkdtempSync(join(tmpdir(), "boop-orch-log-"));
    dirs.push(d);
    const file = join(d, "orchestrator.log");
    writeFileSync(file, `${"x".repeat(100)}\nsecond\nthird\n`);
    expect(await readLogTail(file, 10, 20)).toEqual(["second", "third"]);
  });
});

describe("run views", () => {
  it("puts steps in graph columns by dependency depth, and survives cycles and unknown ids", () => {
    const levels = stepLevels([
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a", "b"] },
    ]);
    expect(Object.fromEntries(levels)).toEqual({ a: 0, b: 1, c: 2 });
    const odd = stepLevels([
      { id: "x", dependsOn: ["y"] },
      { id: "y", dependsOn: ["x"] },
      { id: "z", dependsOn: ["ghost"] },
    ]);
    expect(odd.get("z")).toBe(0);
    expect(odd.size).toBe(3);
  });

  it("builds a run's detail: statuses, dependencies, agents, durations", () => {
    const d = runDetail(diamondRun(), NOW);
    expect(d.title).toBe("Compare flights and hotels for the trip");
    expect(d.done).toBe(false);
    expect(d.finishedAt).toBeNull();
    expect(d.durationMs).toBe(61_000);
    expect(d.counts).toMatchObject({ done: 1, running: 1, pending: 1 });
    const byId = Object.fromEntries(d.stepsDetail.map((s) => [s.id, s]));
    expect(byId.flights).toMatchObject({ status: "done", level: 0, agent: "boop", durationMs: 30_000, costHint: "med" });
    expect(byId.hotels).toMatchObject({ status: "running", level: 0, attempts: 2, durationMs: 50_000 });
    expect(byId.report).toMatchObject({ status: "pending", level: 1, dependsOn: ["flights", "hotels"], startedAt: null, durationMs: null });
  });

  it("includes the merged result and scrubs secrets from outputs", () => {
    const d = runDetail(
      diamondRun({
        state: "SUCCEEDED",
        finished_at: iso(0),
        tasks: diamondRun().tasks.map((t) => ({ ...t, state: "SUCCEEDED" as const, output: `${t.output ?? "ok"} ${FAKE_KEY}` })),
        result: { answer: `Flights and hotels https://example.com/a`, method: "llm", sources: ["https://example.com/a"] },
      }),
      NOW,
    );
    expect(d.done).toBe(true);
    expect(d.result).toMatchObject({ method: "llm", sources: ["https://example.com/a"], incomplete: [] });
    expect(JSON.stringify(d)).not.toContain(FAKE_KEY);
    expect(d.stepsDetail[0].output).toContain("https://example.com/a");
  });

  it("handles a run that's still planning (no plan, no tasks)", () => {
    const s = summarizeRun({ id: "run_aaaaaaaaaaaaaaaa", state: "PLANNING", task: "do things", tasks: [], token_budget: 0, tokens_used: 0, created_at: iso(5_000) }, NOW);
    expect(s).toMatchObject({ title: "do things", steps: 0, done: false, durationMs: 5_000 });
    expect(runDetail({ id: "run_aaaaaaaaaaaaaaaa", state: "PLANNING", tasks: [], token_budget: 0, tokens_used: 0 }, NOW).stepsDetail).toEqual([]);
  });
});

describe("overview", () => {
  it("lists recent runs when the sidecar answers, newest first and capped", async () => {
    const runs = Array.from({ length: MAX_RUNS_LISTED + 5 }, (_, i) => diamondRun({ id: `run_${i.toString(16).padStart(16, "0")}` }));
    let checked = 0;
    const o = await buildOverview({
      status: () => status(),
      checkHealth: async () => (checked++, true),
      client: fakeClient(runs),
      readLog: async () => ["hello"],
      now: () => NOW,
    });
    expect(checked).toBe(1);
    expect(o.available).toBe(true);
    expect(o.runs).toHaveLength(MAX_RUNS_LISTED);
    expect(o.totalRuns).toBe(MAX_RUNS_LISTED + 5);
    expect(o.runs[0].id).toBe(runs[0].id);
    expect(o.log).toEqual(["hello"]);
    expect(o.sidecar.health).toBe("running");
  });

  it("says the orchestrator isn't running instead of throwing when the API fails", async () => {
    const o = await buildOverview({
      status: () => status({ state: "restarting", lastHealth: { at: NOW, ok: false, error: "connection refused" }, nextRestartAt: NOW + 2_000 }),
      checkHealth: async () => {
        throw new Error("boom");
      },
      client: fakeClient(new OrchestratorError("the orchestrator isn't running at http://127.0.0.1:3460", { unreachable: true })),
      readLog: async () => {
        throw new Error("no log");
      },
      now: () => NOW,
    });
    expect(o.available).toBe(false);
    expect(o.error).toContain("isn't running");
    expect(o.runs).toEqual([]);
    expect(o.log).toEqual([]);
    expect(o.sidecar.health).toBe("restarting");
  });

  it("doesn't call the sidecar at all when it isn't configured", async () => {
    let listed = false;
    const o = await buildOverview({
      status: () => status({ state: "disabled", managed: false, pid: null, lastHealth: { at: NOW, ok: false } }),
      client: { listRuns: async () => ((listed = true), []), getRun: async () => diamondRun() },
      readLog: async () => [],
      now: () => NOW,
    });
    expect(listed).toBe(false);
    expect(o.available).toBe(false);
    expect(o.sidecar.health).toBe("not_configured");
  });
});

describe("dashboard routes", () => {
  async function serve(deps: OrchestratorDashboardDeps) {
    const app = express();
    app.use("/orchestrator/dashboard", createOrchestratorDashboardRouter(deps));
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/orchestrator/dashboard`;
    return { base, close: () => new Promise((r) => server.close(r)) };
  }

  it("serves the overview and one run, and maps errors to 400/404/503", async () => {
    const run = diamondRun();
    const ok = await serve({ status: () => status(), client: fakeClient([run]), readLog: async () => [], now: () => NOW });
    try {
      const o = (await (await fetch(ok.base)).json()) as OrchestratorOverview;
      expect(o.available).toBe(true);
      expect(o.runs[0].id).toBe(run.id);
      const detail = await fetch(`${ok.base}/runs/${run.id}`);
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as { run: { stepsDetail: unknown[] } }).run.stepsDetail).toHaveLength(3);
      expect((await fetch(`${ok.base}/runs/not-a-run`)).status).toBe(400);
      expect((await fetch(`${ok.base}/runs/run_ffffffffffffffff`)).status).toBe(404);
    } finally {
      await ok.close();
    }

    const down = await serve({
      status: () => {
        throw new Error("status broke");
      },
      client: fakeClient(new OrchestratorError("not running", { unreachable: true })),
    });
    try {
      const res = await fetch(down.base);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ available: false, sidecar: null });
      const detail = await fetch(`${down.base}/runs/${run.id}`);
      expect(detail.status).toBe(503);
      expect(await detail.json()).toMatchObject({ unreachable: true });
    } finally {
      await down.close();
    }
  });
});

describe("client.listRuns", () => {
  it("reads GET /v1/runs and tolerates a missing list", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(calls.length === 1 ? { runs: [diamondRun()] } : {}), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new OrchestratorClient({ fetch: fetchFn });
    expect(await c.listRuns()).toHaveLength(1);
    expect(await c.listRuns()).toEqual([]);
    expect(calls[0]).toBe("http://127.0.0.1:3460/v1/runs");
  });
});

describe("dashboard helpers", () => {
  it("formats durations and step counts", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(400)).toBe("<1s");
    expect(formatMs(65_000)).toBe("1m 05s");
    expect(formatMs(3 * 3600_000 + 120_000)).toBe("3h 2m");
    expect(countsLine({ pending: 1, running: 1, done: 2, failed: 0, blocked: 0, skipped: 0, cancelled: 0 })).toBe("2 done · 1 running · 1 pending");
  });

  it("polls faster while a run is going and stops polling a finished run", () => {
    const d = runDetail(diamondRun(), NOW);
    expect(overviewPollMs(null)).toBe(5_000);
    expect(overviewPollMs({ available: true, runs: [d] } as unknown as OrchestratorOverview)).toBe(2_000);
    expect(overviewPollMs({ available: true, runs: [{ ...d, done: true }] } as unknown as OrchestratorOverview)).toBe(5_000);
    expect(detailPollMs(d)).toBe(1_500);
    expect(detailPollMs({ ...d, done: true })).toBeNull();
  });

  it("lays the plan out in columns with an edge per dependency", () => {
    const g = layoutGraph(runDetail(diamondRun(), NOW).stepsDetail);
    const x = Object.fromEntries(g.nodes.map((n) => [n.step.id, n.x]));
    expect(x.flights).toBe(x.hotels);
    expect(x.report).toBeGreaterThan(x.flights + NODE_W);
    expect(g.edges.map((e) => `${e.from}->${e.to}:${e.status}`).sort()).toEqual(["flights->report:done", "hotels->report:running"]);
    expect(g.width).toBeGreaterThan(2 * NODE_W);
    expect(layoutGraph([])).toEqual({ width: 0, height: 0, nodes: [], edges: [] });
  });

  it("places timeline bars on the run's clock", () => {
    const { spanMs, bars } = timelineBars(runDetail(diamondRun(), NOW), NOW);
    expect(spanMs).toBe(61_000);
    const flights = bars.find((b) => b.step.id === "flights")!;
    expect(flights.started).toBe(true);
    expect(flights.left).toBeCloseTo((1_000 / 61_000) * 100, 3);
    expect(flights.width).toBeCloseTo((30_000 / 61_000) * 100, 3);
    expect(bars.find((b) => b.step.id === "report")!.started).toBe(false);
  });
});

describe("Orchestrator page", () => {
  const overview = (over: Partial<OrchestratorOverview> = {}): OrchestratorOverview => ({
    generatedAt: NOW,
    sidecar: sidecarView(status(), NOW),
    log: ["2026-11-02T11:59:00Z [boop] starting sidecar on 127.0.0.1:3460 (planner key present)"],
    available: true,
    runs: [summarizeRun(diamondRun(), NOW)],
    totalRuns: 1,
    ...over,
  });

  it("shows a clear 'not running' state when the sidecar is down", () => {
    const html = renderToStaticMarkup(
      createElement(OrchestratorView, {
        isDark: true,
        now: NOW,
        overview: overview({
          sidecar: sidecarView(status({ state: "restarting", pid: null, lastHealth: { at: NOW, ok: false }, nextRestartAt: NOW + 8_000, restarts: 2 }), NOW),
          available: false,
          error: "the orchestrator isn't running at http://127.0.0.1:3460",
          runs: [],
          totalRuns: 0,
        }),
      }),
    );
    expect(html).toContain('data-orchestrator-state="not-running"');
    expect(html).toContain("Orchestrator not running");
    expect(html).toContain('data-sidecar-health="restarting"');
    expect(html).toContain("next in 8s");
  });

  it("shows health, key presence (never a value), the log and the run list", () => {
    const html = renderToStaticMarkup(createElement(OrchestratorView, { isDark: false, now: NOW, overview: overview(), selectedId: "run_0123456789abcdef" }));
    expect(html).toContain('data-sidecar-health="running"');
    expect(html).toContain('data-key-present="true"');
    expect(html).toContain("1m 30s");
    expect(html).toContain("starting sidecar on 127.0.0.1:3460");
    expect(html).toContain('data-run-id="run_0123456789abcdef"');
    expect(html).toContain("Compare flights and hotels for the trip");
    expect(html).not.toContain("sk-ant");
  });

  it("says when Boop's own server can't be reached", () => {
    const html = renderToStaticMarkup(createElement(OrchestratorView, { isDark: false, overview: null, loadError: "HTTP 502" }));
    expect(html).toContain('data-orchestrator-state="boop-unreachable"');
  });

  it("draws the plan graph, timeline, steps and merged result for a run", () => {
    const run = runDetail(
      diamondRun({ result: { answer: "Merged answer here", method: "fallback", merge_error: "no key", sources: [] } }),
      NOW,
    );
    const html = renderToStaticMarkup(createElement(RunDetailBody, { run, isDark: true, now: NOW }));
    expect(html).toContain("data-plan-graph");
    for (const id of ["flights", "hotels", "report"]) expect(html).toContain(`data-step="${id}"`);
    expect(html).toContain('data-step-status="running"');
    expect(html).toContain('data-edge="flights-&gt;report"');
    expect(html).toContain("data-timeline");
    expect(html).toContain("Merged answer here");
    expect(html).toContain("joined without the model");
  });
});
