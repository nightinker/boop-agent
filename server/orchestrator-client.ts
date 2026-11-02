// Boop's side of the Go orchestrator sidecar (orchestrator-go/): submit a run
// (a task to plan, or a ready-made plan), poll its status and step results,
// fetch the merged final answer, and cancel it.
//
// The sidecar is optional. Nothing here throws at import or startup: when it
// isn't running, calls fail with an OrchestratorError whose `unreachable` is
// true. Boop starts either way; orchestrator-sidecar.ts runs and health-checks it.
//
// The sidecar only ever listens on localhost, so the URL must be a loopback
// one; anything else is refused before a request is made.

export const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:3460";
export const MAX_RUN_TASK_CHARS = 20_000;
/** The sidecar caps one long-poll at 60s; stay under it. */
export const MAX_WAIT_SECONDS = 55;
const RUN_ID_RE = /^run_[0-9a-f]{16}$/;

export type RunState = "PLANNING" | "RUNNING" | "MERGING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type TaskState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "SKIPPED" | "CANCELLED";

export interface StepNote {
  id: string;
  title?: string;
  state: TaskState;
  note?: string;
}

export interface RunResult {
  answer: string;
  /** llm = merged by the report agent; single = one-step plan; fallback = joined without a model; none = no output. */
  method: "llm" | "single" | "fallback" | "none";
  sources?: string[];
  incomplete?: StepNote[];
  tokens?: number;
  merge_error?: string;
}

export interface TaskStatus {
  id: string;
  title?: string;
  agent: string;
  state: TaskState;
  attempts: number;
  tokens: number;
  output?: string;
  error?: string;
  reason?: string;
  started_at?: string;
  finished_at?: string;
}

/** One step of a plan, as the planner wrote it. */
export interface PlanTask {
  id: string;
  title?: string;
  agent: string;
  input?: string;
  integrations?: string[];
  depends_on?: string[];
  cost_hint?: string;
}

export interface Plan {
  goal: string;
  tasks: PlanTask[];
}

export interface RunStatus {
  id: string;
  state: RunState;
  conversation_id?: string;
  task?: string;
  /** Set once the run has a plan (straight away for submitted plans, after planning otherwise). */
  plan?: Plan;
  tasks: TaskStatus[];
  token_budget: number;
  tokens_used: number;
  planner_tokens?: number;
  output?: string;
  result?: RunResult;
  error?: string;
  max_parallel?: number;
  created_at?: string;
  finished_at?: string;
}

export interface RunResultResponse {
  id: string;
  state: RunState;
  done: boolean;
  result?: RunResult;
  error?: string;
  tokens_used: number;
  token_budget: number;
}

export interface SubmitRunRequest {
  task?: string;
  plan?: unknown;
  maxTokens?: number;
  maxParallel?: number;
  conversationId?: string;
}

export class OrchestratorError extends Error {
  /** The parsed error body, when the sidecar sent one. */
  body?: Record<string, unknown>;

  constructor(
    message: string,
    readonly opts: { status?: number; problems?: string[]; unreachable?: boolean } = {},
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
  get status(): number | undefined {
    return this.opts.status;
  }
  get problems(): string[] | undefined {
    return this.opts.problems;
  }
  get unreachable(): boolean {
    return this.opts.unreachable === true;
  }
}

export function isTerminal(state: RunState): boolean {
  return state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED";
}

/** Checks that url points at this machine. Returns the normalized base URL or an error. */
export function parseOrchestratorUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `ORCHESTRATOR_URL is not a URL: ${raw}` };
  }
  if (u.protocol !== "http:") return { ok: false, error: "ORCHESTRATOR_URL must be http://" };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback) return { ok: false, error: `ORCHESTRATOR_URL must be on localhost (got ${u.hostname})` };
  if (u.username || u.password) return { ok: false, error: "ORCHESTRATOR_URL must not contain credentials" };
  return { ok: true, url: `${u.protocol}//${u.host}` };
}

/** Validates a run request before it's sent. Returns an error message, or null. */
export function validateSubmit(req: SubmitRunRequest): string | null {
  const task = req.task?.trim() ?? "";
  const hasPlan = req.plan !== undefined && req.plan !== null;
  if (!task === !hasPlan) return 'send exactly one of "task" or "plan"';
  if (task.length > MAX_RUN_TASK_CHARS) return `task is longer than ${MAX_RUN_TASK_CHARS} characters`;
  if (hasPlan && (typeof req.plan !== "object" || Array.isArray(req.plan))) return "plan must be an object";
  for (const [name, v] of [
    ["maxTokens", req.maxTokens],
    ["maxParallel", req.maxParallel],
  ] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v <= 0)) return `${name} must be a positive whole number`;
  }
  return null;
}

type FetchLike = typeof fetch;

export interface OrchestratorClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: FetchLike;
  /** Timeout for calls that don't long-poll. */
  timeoutMs?: number;
}

export class OrchestratorClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly configError?: string;

  constructor(opts: OrchestratorClientOptions = {}) {
    const parsed = parseOrchestratorUrl(opts.baseUrl ?? DEFAULT_ORCHESTRATOR_URL);
    this.baseUrl = parsed.ok ? parsed.url : DEFAULT_ORCHESTRATOR_URL;
    if (!parsed.ok) this.configError = parsed.error;
    this.token = opts.token || undefined;
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn?: FetchLike): OrchestratorClient {
    return new OrchestratorClient({
      baseUrl: env.ORCHESTRATOR_URL?.trim() || DEFAULT_ORCHESTRATOR_URL,
      token: env.ORCHESTRATOR_TOKEN?.trim(),
      fetch: fetchFn,
    });
  }

  async health(): Promise<{ ok: boolean; planner: boolean }> {
    return this.request("GET", "/healthz", undefined, 2_000);
  }

  async submitRun(req: SubmitRunRequest): Promise<RunStatus> {
    const problem = validateSubmit(req);
    if (problem) throw new OrchestratorError(problem, { status: 400 });
    const body: Record<string, unknown> = {};
    if (req.task?.trim()) body.task = req.task.trim();
    else body.plan = req.plan;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.maxParallel) body.max_parallel = req.maxParallel;
    if (req.conversationId) body.conversation_id = req.conversationId;
    return this.request("POST", "/v1/runs", body);
  }

  /** Every run the sidecar has in memory, newest first. */
  async listRuns(): Promise<RunStatus[]> {
    const res = await this.request<{ runs?: RunStatus[] }>("GET", "/v1/runs");
    return Array.isArray(res.runs) ? res.runs : [];
  }

  async getRun(id: string, opts: { waitSeconds?: number; signal?: AbortSignal } = {}): Promise<RunStatus> {
    return this.request("GET", `/v1/runs/${checkId(id)}${waitQuery(opts.waitSeconds)}`, undefined, pollTimeout(opts.waitSeconds, this.timeoutMs), opts.signal);
  }

  /** The merged answer; `done` is false while the run is still going. */
  async getResult(id: string, opts: { waitSeconds?: number; signal?: AbortSignal } = {}): Promise<RunResultResponse> {
    return this.request("GET", `/v1/runs/${checkId(id)}/result${waitQuery(opts.waitSeconds)}`, undefined, pollTimeout(opts.waitSeconds, this.timeoutMs), opts.signal);
  }

  /** Cancels a run. Resolves with the run either way; `cancelled` is false if it had already finished. */
  async cancelRun(id: string): Promise<{ cancelled: boolean; run: RunStatus }> {
    try {
      const run = await this.request<RunStatus>("POST", `/v1/runs/${checkId(id)}/cancel`);
      return { cancelled: true, run };
    } catch (err) {
      if (err instanceof OrchestratorError && err.status === 409 && err.body?.run) {
        return { cancelled: false, run: err.body.run as RunStatus };
      }
      throw err;
    }
  }

  /**
   * Long-polls until the run finishes or `maxWaitMs` passes. Returns the last
   * result response (check `done`).
   */
  async waitForResult(id: string, maxWaitMs: number, signal?: AbortSignal): Promise<RunResultResponse> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const left = Math.max(0, deadline - Date.now());
      const res = await this.getResult(id, { waitSeconds: Math.min(MAX_WAIT_SECONDS, left / 1000), signal });
      if (res.done || Date.now() >= deadline || signal?.aborted) return res;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<T> {
    if (this.configError) throw new OrchestratorError(this.configError);
    const timeout = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw new OrchestratorError("request cancelled");
      const timedOut = timeout.aborted;
      throw new OrchestratorError(
        timedOut
          ? `the orchestrator at ${this.baseUrl} didn't answer in ${Math.round(timeoutMs / 1000)}s`
          : `the orchestrator isn't running at ${this.baseUrl} (Boop starts it on boot; ask "is the orchestrator working" for why it isn't up)`,
        { unreachable: !timedOut },
      );
    }
    const text = await res.text();
    let json: Record<string, unknown> | undefined;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok && res.status !== 202) {
      const problems = Array.isArray(json?.problems) ? (json!.problems as unknown[]).map(String) : undefined;
      const msg = typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
      const err = new OrchestratorError(problems ? `${msg}: ${problems.join("; ")}` : msg, { status: res.status, problems });
      err.body = json;
      throw err;
    }
    if (!json) throw new OrchestratorError(`the orchestrator answered HTTP ${res.status} without JSON`, { status: res.status });
    return json as T;
  }
}

function checkId(id: string): string {
  if (!RUN_ID_RE.test(id)) throw new OrchestratorError(`bad run id "${id}" (expected run_ and 16 hex characters)`, { status: 400 });
  return id;
}

function waitQuery(waitSeconds?: number): string {
  if (!waitSeconds || waitSeconds <= 0) return "";
  return `?wait=${Math.min(MAX_WAIT_SECONDS, Math.round(waitSeconds * 10) / 10)}`;
}

function pollTimeout(waitSeconds: number | undefined, base: number): number {
  return base + Math.min(MAX_WAIT_SECONDS, Math.max(0, waitSeconds ?? 0)) * 1000;
}

// ---- Startup probe and availability -----------------------------------------

let lastProbe: { at: number; up: boolean } | null = null;
const PROBE_TTL_MS = 60_000;

/**
 * Checks once whether the sidecar is up and logs the answer. Never throws and
 * never blocks startup for more than a couple of seconds; Boop runs fine
 * without the sidecar.
 */
export async function probeOrchestrator(
  client: OrchestratorClient = OrchestratorClient.fromEnv(),
  log: (msg: string) => void = (m) => console.log(m),
): Promise<boolean> {
  try {
    const h = await client.health();
    lastProbe = { at: Date.now(), up: true };
    log(`[orchestrator] sidecar up at ${client.baseUrl}${h.planner ? "" : " (no planner: plans only)"}`);
    return true;
  } catch (err) {
    lastProbe = { at: Date.now(), up: false };
    log(`[orchestrator] sidecar not available (${err instanceof Error ? err.message : String(err)}); continuing without it`);
    return false;
  }
}

/** Whether the sidecar answered recently. Re-checks quietly at most once a minute. */
export async function orchestratorAvailable(client: OrchestratorClient = OrchestratorClient.fromEnv()): Promise<boolean> {
  if (lastProbe && Date.now() - lastProbe.at < PROBE_TTL_MS) return lastProbe.up;
  return probeOrchestrator(client, () => {});
}

/**
 * Records a health check made elsewhere (the sidecar supervisor checks every
 * few seconds), so the dispatcher's tools switch on as soon as the sidecar
 * answers and off as soon as it goes down, instead of waiting out the cache.
 */
export function recordOrchestratorHealth(up: boolean, at: number = Date.now()): void {
  lastProbe = { at, up };
}

/** For tests. */
export function resetOrchestratorProbe(): void {
  lastProbe = null;
}
