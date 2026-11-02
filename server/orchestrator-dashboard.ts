import express from "express";
import { open, stat } from "node:fs/promises";
import {
  OrchestratorClient,
  OrchestratorError,
  isTerminal,
  type RunState,
  type RunStatus,
  type TaskState,
} from "./orchestrator-client.js";
import type { SidecarState, SidecarStatus } from "./orchestrator-sidecar.js";
import { scanForSecrets } from "./secrets/redact.js";

// The dashboard's Orchestrator tab reads everything through here, so the
// browser never talks to the sidecar itself. One call gives the sidecar's
// health (from the supervisor in orchestrator-sidecar.ts), the end of its log
// and its recent runs; a second gives one run's plan as a graph.
//
// Nothing here fails the request: a sidecar that's down or an API call that
// errors comes back as `available: false` with a plain reason, and the page
// shows "orchestrator not running". Every string that came from the sidecar or
// its log is passed through the secret scrubber first, and the API key is
// only ever reported as present or not.

export type SidecarHealth = "running" | "starting" | "restarting" | "down" | "not_configured";
export type StepStatus = "pending" | "running" | "done" | "failed" | "blocked" | "skipped" | "cancelled";

export const LOG_TAIL_LINES = 40;
const LOG_TAIL_BYTES = 64 * 1024;
const MAX_LOG_LINE = 500;
export const MAX_RUNS_LISTED = 30;
const MAX_STEP_OUTPUT = 4_000;
const MAX_STEP_INPUT = 1_000;
const MAX_ANSWER = 20_000;
const RUN_ID_RE = /^run_[0-9a-f]{16}$/;

export interface SidecarView {
  health: SidecarHealth;
  /** The supervisor's own state, for the detail line. */
  state: SidecarState;
  managed: boolean;
  port: number;
  pid: number | null;
  /** Milliseconds since the running sidecar started; null when it isn't running. */
  uptimeMs: number | null;
  restarts: number;
  /** Milliseconds until the next restart attempt, while it's backing off. */
  nextRestartInMs: number | null;
  /** Whether the optional ANTHROPIC_API_KEY override is stored. Never the value. */
  keyPresent: boolean;
  /** Whether the running sidecar was started with the key. */
  keyPassed: boolean;
  planner: boolean | null;
  merger: boolean | null;
  /** Where planner and merger calls go: "boop" (Boop's Claude runtime) or "anthropic" (API key override). */
  llm: "boop" | "anthropic" | null;
  lastHealth: { at: number; ok: boolean; error?: string } | null;
  lastExit: { at: number; code: number | null; signal: string | null } | null;
  lastSelfTest: { at: number; ok: boolean; detail: string } | null;
  problem: string | null;
  logFile: string;
}

export interface RunSummary {
  id: string;
  state: RunState;
  done: boolean;
  title: string;
  createdAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  steps: number;
  counts: Record<StepStatus, number>;
  tokensUsed: number;
  tokenBudget: number;
  error?: string;
}

export interface StepView {
  id: string;
  title: string;
  agent: string;
  status: StepStatus;
  state: TaskState;
  dependsOn: string[];
  /** Column in the graph: 0 for steps with no dependencies, else one past the deepest dependency. */
  level: number;
  costHint?: string;
  integrations: string[];
  input?: string;
  attempts: number;
  tokens: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  output?: string;
  error?: string;
  reason?: string;
}

export interface RunDetail extends RunSummary {
  task?: string;
  goal?: string;
  maxParallel?: number;
  plannerTokens?: number;
  stepsDetail: StepView[];
  result?: {
    answer: string;
    method: string;
    sources: string[];
    incomplete: { id: string; title?: string; state: string; note?: string }[];
    mergeError?: string;
  };
}

export interface OrchestratorOverview {
  generatedAt: number;
  sidecar: SidecarView;
  log: string[];
  /** Whether the sidecar's API answered. */
  available: boolean;
  /** Why the runs couldn't be read, when available is false. */
  error?: string;
  runs: RunSummary[];
  totalRuns: number;
}

// ---- pure helpers ---------------------------------------------------------------

/** Scrubs anything that looks like a credential or a stored secret. */
export function scrub(text: string): string;
export function scrub(text: string | undefined): string | undefined;
export function scrub(text: string | undefined): string | undefined {
  if (!text) return text;
  return scanForSecrets(text).redacted;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

/** Turns the supervisor's state into the four the page shows. */
export function sidecarHealth(st: SidecarStatus): SidecarHealth {
  const answering = st.lastHealth?.ok === true;
  if (st.problem?.startsWith("ORCHESTRATOR_URL")) return "not_configured";
  if (answering && (st.state === "running" || st.state === "external" || st.state === "disabled")) return "running";
  if (st.state === "disabled" || st.state === "idle") return "not_configured";
  if (st.state === "restarting") return "restarting";
  if (st.state === "building" || st.state === "starting") return "starting";
  if (answering) return "running";
  return "down";
}

export function sidecarView(st: SidecarStatus, now: number = Date.now()): SidecarView {
  const health = sidecarHealth(st);
  return {
    health,
    state: st.state,
    managed: st.managed,
    port: st.port,
    pid: st.pid,
    uptimeMs: health === "running" && st.startedAt ? Math.max(0, now - st.startedAt) : null,
    restarts: st.restarts,
    nextRestartInMs: st.nextRestartAt ? Math.max(0, st.nextRestartAt - now) : null,
    keyPresent: st.keyPresent,
    keyPassed: st.keyPassed,
    planner: st.lastHealth?.ok ? st.lastHealth.planner === true : null,
    merger: st.lastHealth?.ok && typeof st.lastHealth.merger === "boolean" ? st.lastHealth.merger : null,
    llm: st.lastHealth?.ok && (st.lastHealth.llm === "boop" || st.lastHealth.llm === "anthropic") ? st.lastHealth.llm : null,
    lastHealth: st.lastHealth
      ? { at: st.lastHealth.at, ok: st.lastHealth.ok, ...(st.lastHealth.error ? { error: scrub(st.lastHealth.error) } : {}) }
      : null,
    lastExit: st.lastExit,
    lastSelfTest: st.lastSelfTest ? { at: st.lastSelfTest.at, ok: st.lastSelfTest.ok, detail: scrub(st.lastSelfTest.detail) } : null,
    problem: st.problem ? scrub(st.problem) : null,
    logFile: st.logFile,
  };
}

/** The last `maxLines` lines of a log, scrubbed. A missing file is an empty list. */
export async function readLogTail(file: string, maxLines = LOG_TAIL_LINES, maxBytes = LOG_TAIL_BYTES): Promise<string[]> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return [];
  }
  if (size === 0) return [];
  const start = Math.max(0, size - maxBytes);
  const fh = await open(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    text = buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
  let lines = text.split(/\r?\n/);
  // Reading from the middle of the file: the first line is probably cut.
  if (start > 0) lines = lines.slice(1);
  lines = lines.filter((l) => l.trim() !== "");
  return lines.slice(-maxLines).map((l) => scrub(l.length > MAX_LOG_LINE ? `${l.slice(0, MAX_LOG_LINE)}…` : l));
}

export function stepStatus(state: TaskState): StepStatus {
  switch (state) {
    case "PENDING":
      return "pending";
    case "RUNNING":
      return "running";
    case "SUCCEEDED":
      return "done";
    case "FAILED":
      return "failed";
    case "BLOCKED":
      return "blocked";
    case "SKIPPED":
      return "skipped";
    case "CANCELLED":
      return "cancelled";
    default:
      return "pending";
  }
}

function time(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  // Go's zero time ("0001-01-01T00:00:00Z") means "not set".
  return Number.isFinite(t) && t > 0 ? t : null;
}

function duration(start: number | null, end: number | null, now: number): number | null {
  if (start === null) return null;
  return Math.max(0, (end ?? now) - start);
}

/**
 * Graph columns: a step with no dependencies is column 0, any other is one
 * past its deepest dependency. Unknown ids and cycles (a validated plan has
 * neither) are ignored rather than looping.
 */
export function stepLevels(steps: { id: string; dependsOn: string[] }[]): Map<string, number> {
  const deps = new Map(steps.map((s) => [s.id, s.dependsOn]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const level = (id: string): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id) || !deps.has(id)) return -1;
    visiting.add(id);
    let l = 0;
    for (const d of deps.get(id) ?? []) l = Math.max(l, level(d) + 1);
    visiting.delete(id);
    levels.set(id, l);
    return l;
  };
  for (const s of steps) level(s.id);
  return levels;
}

function emptyCounts(): Record<StepStatus, number> {
  return { pending: 0, running: 0, done: 0, failed: 0, blocked: 0, skipped: 0, cancelled: 0 };
}

function runTitle(run: RunStatus): string {
  const raw = run.plan?.goal?.trim() || run.task?.trim() || run.tasks[0]?.title || run.id;
  const oneLine = raw.replace(/\s+/g, " ");
  return scrub(oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine);
}

export function summarizeRun(run: RunStatus, now: number = Date.now()): RunSummary {
  const counts = emptyCounts();
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  for (const t of tasks) counts[stepStatus(t.state)]++;
  const createdAt = time(run.created_at);
  const finishedAt = time(run.finished_at);
  return {
    id: run.id,
    state: run.state,
    done: isTerminal(run.state),
    title: runTitle({ ...run, tasks }),
    createdAt,
    finishedAt,
    durationMs: duration(createdAt, finishedAt, now),
    steps: Math.max(tasks.length, run.plan?.tasks?.length ?? 0),
    counts,
    tokensUsed: run.tokens_used ?? 0,
    tokenBudget: run.token_budget ?? 0,
    ...(run.error ? { error: scrub(run.error) } : {}),
  };
}

export function runDetail(run: RunStatus, now: number = Date.now()): RunDetail {
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const planTasks = run.plan?.tasks ?? [];
  const byId = new Map(planTasks.map((t) => [t.id, t]));
  const statusById = new Map(tasks.map((t) => [t.id, t]));
  // Plan order first, then any status the plan didn't list.
  const ids = [...planTasks.map((t) => t.id), ...tasks.map((t) => t.id).filter((id) => !byId.has(id))];
  const known = new Set(ids);
  const base = ids.map((id) => ({ id, dependsOn: (byId.get(id)?.depends_on ?? []).filter((d) => known.has(d)) }));
  const levels = stepLevels(base);
  const steps: StepView[] = base.map(({ id, dependsOn }) => {
    const p = byId.get(id);
    const s = statusById.get(id);
    const state: TaskState = s?.state ?? "PENDING";
    const startedAt = time(s?.started_at);
    const finishedAt = time(s?.finished_at);
    return {
      id,
      title: scrub(s?.title || p?.title || id),
      agent: s?.agent || p?.agent || "?",
      status: stepStatus(state),
      state,
      dependsOn,
      level: Math.max(0, levels.get(id) ?? 0),
      ...(p?.cost_hint ? { costHint: p.cost_hint } : {}),
      integrations: p?.integrations ?? [],
      ...(p?.input ? { input: scrub(clip(p.input, MAX_STEP_INPUT)) } : {}),
      attempts: s?.attempts ?? 0,
      tokens: s?.tokens ?? 0,
      startedAt,
      finishedAt,
      durationMs: duration(startedAt, finishedAt, now),
      ...(s?.output ? { output: scrub(clip(s.output, MAX_STEP_OUTPUT)) } : {}),
      ...(s?.error ? { error: scrub(s.error) } : {}),
      ...(s?.reason ? { reason: scrub(s.reason) } : {}),
    };
  });
  const r = run.result;
  return {
    ...summarizeRun(run, now),
    ...(run.task ? { task: scrub(clip(run.task, MAX_STEP_INPUT * 4)) } : {}),
    ...(run.plan?.goal ? { goal: scrub(run.plan.goal) } : {}),
    ...(run.max_parallel ? { maxParallel: run.max_parallel } : {}),
    ...(run.planner_tokens ? { plannerTokens: run.planner_tokens } : {}),
    stepsDetail: steps,
    ...(r
      ? {
          result: {
            answer: scrub(clip(r.answer ?? "", MAX_ANSWER)) ?? "",
            method: r.method,
            sources: (r.sources ?? []).map((u) => scrub(u)),
            incomplete: (r.incomplete ?? []).map((n) => ({ id: n.id, title: scrub(n.title), state: n.state, note: scrub(n.note) })),
            ...(r.merge_error ? { mergeError: scrub(r.merge_error) } : {}),
          },
        }
      : {}),
  };
}

function errorMessage(err: unknown): string {
  return scrub(err instanceof Error ? err.message : String(err));
}

// ---- the routes ---------------------------------------------------------------

export interface OrchestratorDashboardDeps {
  status: () => SidecarStatus;
  /** A fresh health check, so the page isn't up to 15s behind. */
  checkHealth?: () => Promise<boolean>;
  client?: Pick<OrchestratorClient, "listRuns" | "getRun">;
  readLog?: (file: string) => Promise<string[]>;
  now?: () => number;
}

export async function buildOverview(deps: OrchestratorDashboardDeps): Promise<OrchestratorOverview> {
  const now = deps.now ?? Date.now;
  const client = deps.client ?? OrchestratorClient.fromEnv();
  try {
    await deps.checkHealth?.();
  } catch {
    // The status below says what happened.
  }
  const st = deps.status();
  const sidecar = sidecarView(st, now());
  const log = await (deps.readLog ?? ((f) => readLogTail(f)))(st.logFile).catch(() => []);
  const base = { generatedAt: now(), sidecar, log };
  if (sidecar.health === "not_configured" && st.lastHealth?.ok !== true) {
    return { ...base, available: false, error: st.problem ? scrub(st.problem) : "the orchestrator sidecar isn't set up", runs: [], totalRuns: 0 };
  }
  try {
    const all = await client.listRuns();
    return { ...base, available: true, runs: all.slice(0, MAX_RUNS_LISTED).map((r) => summarizeRun(r, now())), totalRuns: all.length };
  } catch (err) {
    return { ...base, available: false, error: errorMessage(err), runs: [], totalRuns: 0 };
  }
}

export function createOrchestratorDashboardRouter(deps: OrchestratorDashboardDeps): express.Router {
  const router = express.Router();
  const client = deps.client ?? OrchestratorClient.fromEnv();
  const now = deps.now ?? Date.now;

  router.get("/", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await buildOverview({ ...deps, client }));
    } catch (err) {
      // Even reading Boop's own status failed: still answer, never a 500 page.
      res.json({ generatedAt: now(), sidecar: null, log: [], available: false, error: errorMessage(err), runs: [], totalRuns: 0 });
    }
  });

  router.get("/runs/:id", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const id = req.params.id;
    if (!RUN_ID_RE.test(id)) {
      res.status(400).json({ error: "bad run id" });
      return;
    }
    try {
      const run = await client.getRun(id);
      res.json({ run: runDetail(run, now()) });
    } catch (err) {
      if (err instanceof OrchestratorError && err.status === 404) {
        res.status(404).json({ error: "run not found (runs are kept in memory and lost when the sidecar restarts)" });
        return;
      }
      res.status(503).json({ error: errorMessage(err), unreachable: true });
    }
  });

  return router;
}
