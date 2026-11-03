import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, openSync, statSync, writeSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ORCHESTRATOR_URL,
  OrchestratorClient,
  parseOrchestratorUrl,
  recordOrchestratorHealth,
  type RunResultResponse,
} from "./orchestrator-client.js";

// Runs the Go orchestrator sidecar (orchestrator-go/) as a child of Boop:
// builds the binary when it's missing or older than the Go source, starts it
// on 127.0.0.1:3460, logs its output to data/orchestrator/orchestrator.log,
// restarts it with backoff if it dies and stops it when Boop shuts down.
//
// Everything here is best effort. No Go, a failed build or a sidecar that
// won't start is logged once and Boop carries on without the orchestrator
// tools. Nothing in this file throws out of start().
//
// The planner, llm agent and result merger are on whenever the sidecar runs:
// by default their model calls come back to Boop (POST /orchestrator/complete)
// and run through Boop's own Claude runtime, so no API key is needed.
// ANTHROPIC_API_KEY is an optional override: when the secret store (the Mac's
// Keychain) has it, it's handed to the child in its environment at spawn time
// and the sidecar calls the Anthropic API directly. It's never read from
// Boop's own environment or chat, never logged and never returned: status only
// says whether it's present.

export const SIDECAR_KEY_NAME = "ANTHROPIC_API_KEY";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
export const DEFAULT_SOURCE_DIR = path.join(ROOT, "orchestrator-go");
export const DEFAULT_STATE_DIR = path.join(ROOT, "data", "orchestrator");

const BUILD_TIMEOUT_MS = 5 * 60_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export type SidecarState =
  | "idle"
  | "disabled"
  | "building"
  | "starting"
  | "running"
  | "external"
  | "restarting"
  | "failed"
  | "stopped";

/** Where the sidecar's planner and merger send model calls ("" = no model). */
export type OrchestratorLlm = "boop" | "anthropic" | "";

export interface HealthRecord {
  at: number;
  ok: boolean;
  planner?: boolean;
  merger?: boolean;
  llm?: OrchestratorLlm;
  error?: string;
}

export interface SelfTestRecord {
  at: number;
  ok: boolean;
  detail: string;
  method?: string;
  runId?: string;
  ms?: number;
}

export interface SidecarStatus {
  state: SidecarState;
  /** Whether Boop runs the sidecar itself (false when disabled or another process already serves the port). */
  managed: boolean;
  url: string;
  port: number;
  pid: number | null;
  binary: string;
  logFile: string;
  /** The optional ANTHROPIC_API_KEY override is stored in the secret store (the value is never exposed). */
  keyPresent: boolean;
  /** The sidecar it's running was started with the key. */
  keyPassed: boolean;
  restarts: number;
  startedAt: number | null;
  lastHealth: HealthRecord | null;
  lastExit: { at: number; code: number | null; signal: string | null } | null;
  lastSelfTest: SelfTestRecord | null;
  problem: string | null;
  nextRestartAt: number | null;
}

// ---- pure helpers ---------------------------------------------------------------

/**
 * A hash of everything that goes into the binary: the non-test .go files and
 * go.mod/go.sum, by relative path and content. A different hash means the
 * binary is stale.
 */
export async function hashGoSources(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "testdata") await walk(child);
      } else if (entry.isFile()) {
        const goFile = entry.name.endsWith(".go") && !entry.name.endsWith("_test.go");
        if (goFile || child === "go.mod" || child === "go.sum") files.push(child);
      }
    }
  };
  await walk("");
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f).update("\0").update(await readFile(path.join(dir, f))).update("\0");
  }
  return h.digest("hex");
}

/** Missing binary or a stamp that doesn't match the source: build again. */
export async function needsBuild(binary: string, stampFile: string, sourceHash: string): Promise<boolean> {
  if (!existsSync(binary)) return true;
  try {
    const stamp = JSON.parse(await readFile(stampFile, "utf8")) as { hash?: string };
    return stamp.hash !== sourceHash;
  } catch {
    return true;
  }
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the go command: GO_BIN if set, then PATH, then the usual install
 * places (the desktop app's PATH can be thin).
 */
export function findGo(env: NodeJS.ProcessEnv = process.env, exists: (f: string) => boolean = isExecutable): string | null {
  const explicit = env.GO_BIN?.trim();
  if (explicit) return exists(explicit) ? explicit : null;
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  dirs.push("/opt/homebrew/bin", "/usr/local/go/bin", "/usr/local/bin", path.join(env.HOME || homedir(), "go", "bin"));
  for (const dir of dirs) {
    const candidate = path.join(dir, "go");
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * What the orchestrator's `hermes` agent needs, on top of the basics: where
 * Hermes is and how to run it, which Claude login the subscription provider
 * uses, and USER/LOGNAME (the claude CLI reports logged-out without them when
 * Boop runs under launchd or systemd).
 */
export const HERMES_ENV_KEYS = [
  "USER",
  "LOGNAME",
  "HERMES_BIN",
  "HERMES_HOME",
  "ORCHESTRATOR_HERMES",
  "ORCHESTRATOR_HERMES_PROVIDER",
  "ORCHESTRATOR_HERMES_MODEL",
  "ORCHESTRATOR_HERMES_TOOLSETS",
  "ORCHESTRATOR_HERMES_YOLO",
  "ORCHESTRATOR_HERMES_MAX_TURNS",
  "ORCHESTRATOR_HERMES_TIMEOUT",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND",
  "CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
] as const;

/**
 * The child's whole environment. Deliberately small: Boop's own environment
 * holds other services' keys, which the sidecar has no business seeing. The
 * API key is added only when the secret store has it.
 */
export function sidecarEnv(opts: {
  addr: string;
  boopUrl: string;
  apiKey?: string | null;
  base?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const base = opts.base ?? process.env;
  const env: NodeJS.ProcessEnv = {
    ORCHESTRATOR_ADDR: opts.addr,
    BOOP_URL: opts.boopUrl,
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "TZ", "ORCHESTRATOR_TOKEN", "ORCHESTRATOR_MODEL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", ...HERMES_ENV_KEYS]) {
    const v = base[key];
    if (v) env[key] = v;
  }
  // An ORCHESTRATOR_HERMES_* setting that is present but empty means "leave it
  // to Hermes' own config" (orchestrator-go/agents/hermes.go), so keep it.
  for (const key of HERMES_ENV_KEYS) {
    if (key.startsWith("ORCHESTRATOR_HERMES_") && base[key] === "") env[key] = "";
  }
  if (opts.apiKey) env[SIDECAR_KEY_NAME] = opts.apiKey;
  return env;
}

/** 1s, 2s, 4s … capped at 60s. */
export function restartDelayMs(failures: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, failures - 1));
}

/** A tiny hand-written plan: two echo steps whose URLs must survive the merge. */
export function selfTestPlan(nonce: string): { plan: Record<string, unknown>; urls: string[] } {
  const urls = [`https://selftest.boop.invalid/${nonce}/alpha`, `https://selftest.boop.invalid/${nonce}/beta`];
  return {
    urls,
    plan: {
      goal: "Orchestrator self-test: confirm both steps' links come back in one merged answer.",
      tasks: [
        { id: "alpha", title: "Self-test step A", agent: "echo", cost_hint: "low", input: `Step A found ${urls[0]}` },
        { id: "beta", title: "Self-test step B", agent: "echo", cost_hint: "low", input: `Step B found ${urls[1]}` },
      ],
    },
  };
}

/** Did a self-test run come back merged, with both steps' links? */
export function checkSelfTestResult(res: RunResultResponse, urls: string[]): { ok: boolean; detail: string } {
  if (!res.done) return { ok: false, detail: `the test run was still ${res.state} when the check gave up` };
  if (res.state !== "SUCCEEDED") return { ok: false, detail: `the test run ended ${res.state}${res.error ? `: ${res.error}` : ""}` };
  const r = res.result;
  if (!r || !r.answer?.trim()) return { ok: false, detail: "the run finished but no merged answer came back" };
  const found = (u: string) => r.answer.includes(u) || (r.sources ?? []).includes(u);
  const missing = urls.filter((u) => !found(u));
  if (missing.length) return { ok: false, detail: `the merged answer lost ${missing.length} of ${urls.length} step results` };
  const how =
    r.method === "llm"
      ? "merged by the model"
      : r.method === "fallback"
        ? `joined without the model${r.merge_error ? ` (${r.merge_error})` : ""}`
        : `method ${r.method}`;
  return { ok: true, detail: `merged result came back with both steps (${how})` };
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Says whether the planner and merger are on, and which model path they use. */
export function describeModelUse(h: HealthRecord | null): string {
  if (!h || !h.ok) return "unknown until the sidecar answers.";
  const parts = [h.planner ? "planner on" : "planner off", h.merger === false ? "merger off" : h.merger ? "merger on" : null]
    .filter(Boolean)
    .join(", ");
  if (h.llm === "boop") return `${parts}, via Boop's own Claude runtime (no API key needed). If a model call fails, runs fall back to a one-step plan and results are joined without the model.`;
  if (h.llm === "anthropic") return `${parts}, via the Anthropic API (${SIDECAR_KEY_NAME} override).`;
  if (!h.planner) return `${parts}: only hand-written plans work and results are joined without the model.`;
  return `${parts}.`;
}

/** The plain answer to "is the orchestrator working?". */
export function formatSidecarStatus(st: SidecarStatus, now: number = Date.now()): string {
  const up = st.lastHealth?.ok === true;
  const lines: string[] = [];
  const head =
    st.state === "running" && up
      ? `Orchestrator sidecar: running (pid ${st.pid}) on port ${st.port}.`
      : st.state === "external" && up
        ? `Orchestrator sidecar: answering on port ${st.port}, but it was started outside Boop (Boop isn't supervising it).`
        : `Orchestrator sidecar: NOT running (${st.state}) — port ${st.port}.`;
  lines.push(head);
  lines.push(`Tools: ${up ? "on" : "off"}.`);
  if (st.lastHealth) {
    lines.push(
      `Last health check: ${ago(st.lastHealth.at, now)}, ${st.lastHealth.ok ? "ok" : `failed${st.lastHealth.error ? ` (${st.lastHealth.error})` : ""}`}.`,
    );
  } else {
    lines.push("Last health check: none yet.");
  }
  lines.push(`Planner and result merger: ${describeModelUse(st.lastHealth)}`);
  if (st.keyPresent) {
    lines.push(
      st.keyPassed || st.state === "external"
        ? `${SIDECAR_KEY_NAME}: stored in the Keychain (optional override)${st.state === "external" ? "" : " and passed to the sidecar"}, so the planner and merger call the Anthropic API directly.`
        : `${SIDECAR_KEY_NAME}: stored in the Keychain, but the running sidecar started without it; until its next restart the planner and merger use Boop's Claude runtime.`,
    );
  } else {
    lines.push(`${SIDECAR_KEY_NAME}: not stored, and not needed (the planner and merger use Boop's own Claude runtime). It's only an optional override.`);
  }
  if (st.restarts) lines.push(`Restarts since boot: ${st.restarts}.`);
  if (st.lastExit) lines.push(`Last exit: ${ago(st.lastExit.at, now)} (${st.lastExit.signal ? `signal ${st.lastExit.signal}` : `code ${st.lastExit.code}`}).`);
  if (st.nextRestartAt) lines.push(`Next restart attempt in ${Math.max(0, Math.round((st.nextRestartAt - now) / 1000))}s.`);
  if (st.problem) lines.push(`Problem: ${st.problem}`);
  if (st.lastSelfTest) {
    lines.push(`Last self-test: ${ago(st.lastSelfTest.at, now)}, ${st.lastSelfTest.ok ? "passed" : "FAILED"} — ${st.lastSelfTest.detail}.`);
  }
  if (st.managed) lines.push(`Log: ${st.logFile}`);
  return lines.join("\n");
}

// ---- the supervisor ----------------------------------------------------------

type SpawnFn = (cmd: string, args: string[], opts: Parameters<typeof spawn>[2]) => ChildProcess;
type BuildFn = (goBin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ ok: boolean; output: string }>;

export interface SidecarOptions {
  sourceDir?: string;
  stateDir?: string;
  /** Where the sidecar listens. Default ORCHESTRATOR_URL or http://127.0.0.1:3460. */
  url?: string;
  /** Boop's own server, for the sidecar's bridge. */
  boopUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Reads ANTHROPIC_API_KEY from the secret store; null when it isn't stored. */
  getApiKey?: () => Promise<string | null>;
  client?: OrchestratorClient;
  log?: (msg: string) => void;
  spawn?: SpawnFn;
  build?: BuildFn;
  findGo?: () => string | null;
  /** Command line of a running pid, for clearing a sidecar a crashed Boop left behind. */
  processCommand?: (pid: number) => Promise<string | null>;
  now?: () => number;
  healthIntervalMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Ran this long without dying: the next failure starts the backoff over. */
  stableAfterMs?: number;
  /** Health checks in a row that fail before a hung sidecar is restarted. */
  maxFailedChecks?: number;
}

const defaultBuild: BuildFn = (goBin, args, opts) =>
  new Promise((resolve) => {
    execFile(goBin, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() || (err ? String(err.message) : "") });
    });
  });

const defaultProcessCommand = (pid: number): Promise<string | null> =>
  new Promise((resolve) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "command="], (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OrchestratorSidecar {
  readonly sourceDir: string;
  readonly stateDir: string;
  readonly binary: string;
  readonly logFile: string;
  readonly url: string;
  readonly port: number;
  private readonly addr: string;
  private readonly stampFile: string;
  private readonly pidFile: string;
  private readonly opts: SidecarOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly client: OrchestratorClient;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  private state: SidecarState = "idle";
  private managed = false;
  private child: ChildProcess | null = null;
  private childExited: Promise<void> | null = null;
  private stopping = false;
  /** Set while Boop itself stops the child (shutdown or a key change), so its exit isn't treated as a crash. */
  private expectExit = false;
  private startedAt: number | null = null;
  private restarts = 0;
  private failuresInARow = 0;
  private failedChecks = 0;
  private keyPresent = false;
  private keyPassed = false;
  private keyFingerprint: string | null = null;
  private lastHealth: HealthRecord | null = null;
  private lastExit: SidecarStatus["lastExit"] = null;
  private lastSelfTest: SelfTestRecord | null = null;
  private problem: string | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private nextRestartAt: number | null = null;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private selfTestRunning: Promise<SelfTestRecord> | null = null;

  constructor(opts: SidecarOptions = {}) {
    this.opts = opts;
    this.env = opts.env ?? process.env;
    this.sourceDir = opts.sourceDir ?? DEFAULT_SOURCE_DIR;
    this.stateDir = opts.stateDir ?? DEFAULT_STATE_DIR;
    this.binary = path.join(this.stateDir, "bin", "orchestrator");
    this.stampFile = path.join(this.stateDir, "bin", "orchestrator.stamp.json");
    this.pidFile = path.join(this.stateDir, "orchestrator.pid");
    this.logFile = path.join(this.stateDir, "orchestrator.log");
    const parsed = parseOrchestratorUrl(opts.url ?? (this.env.ORCHESTRATOR_URL?.trim() || DEFAULT_ORCHESTRATOR_URL));
    this.url = parsed.ok ? parsed.url : DEFAULT_ORCHESTRATOR_URL;
    const u = new URL(this.url);
    this.port = Number(u.port || 80);
    this.addr = `${u.hostname === "localhost" ? "127.0.0.1" : u.hostname}:${this.port}`;
    this.client = opts.client ?? new OrchestratorClient({ baseUrl: this.url, token: this.env.ORCHESTRATOR_TOKEN?.trim() });
    this.log = opts.log ?? ((m) => console.log(m));
    this.now = opts.now ?? Date.now;
    if (!parsed.ok) this.problem = parsed.error;
  }

  status(): SidecarStatus {
    return {
      state: this.state,
      managed: this.managed,
      url: this.url,
      port: this.port,
      pid: this.child?.pid ?? null,
      binary: this.binary,
      logFile: this.logFile,
      keyPresent: this.keyPresent,
      keyPassed: this.keyPassed,
      restarts: this.restarts,
      startedAt: this.startedAt,
      lastHealth: this.lastHealth,
      lastExit: this.lastExit,
      lastSelfTest: this.lastSelfTest,
      problem: this.problem,
      nextRestartAt: this.nextRestartAt,
    };
  }

  /** Builds (if needed) and starts the sidecar. Never throws; resolves once it's up or has given up for now. */
  start(): Promise<void> {
    return this.serial(() => this.startUnlocked());
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(fn, fn);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  private fail(problem: string, state: SidecarState = "failed"): void {
    this.problem = problem;
    this.state = state;
    this.log(`[orchestrator] ${problem}; Boop continues without the orchestrator tools`);
  }

  private async startUnlocked(): Promise<void> {
    try {
      const mode = this.env.ORCHESTRATOR_SIDECAR?.trim().toLowerCase();
      if (mode === "off" || mode === "0" || mode === "false") {
        this.state = "disabled";
        this.managed = false;
        this.log("[orchestrator] ORCHESTRATOR_SIDECAR=off: not starting the sidecar; using one at " + this.url + " if it's there");
        this.startHealthLoop();
        await this.checkHealth();
        return;
      }
      if (this.problem && this.problem.startsWith("ORCHESTRATOR_URL")) {
        this.fail(`${this.problem}; not starting the sidecar`);
        recordOrchestratorHealth(false, this.now());
        return;
      }
      await mkdir(this.stateDir, { recursive: true });
      await this.clearLeftover();

      // Something already answers on the port (the owner ran it by hand):
      // use it rather than fight it for the port.
      if (await this.checkHealth()) {
        this.state = "external";
        this.managed = false;
        this.keyPresent = (await this.readKey()) !== null;
        this.log(`[orchestrator] a sidecar is already answering at ${this.url}; using it (not managed by Boop)`);
        this.startHealthLoop();
        return;
      }

      this.managed = true;
      if (!(await this.ensureBinary())) {
        recordOrchestratorHealth(false, this.now());
        return;
      }
      if (this.stopping) return;
      await this.spawnChild();
      this.startHealthLoop();
    } catch (err) {
      this.fail(`couldn't start the sidecar: ${err instanceof Error ? err.message : String(err)}`);
      recordOrchestratorHealth(false, this.now());
    }
  }

  /** A sidecar a crashed Boop left running would hold the port with an old binary or key. */
  private async clearLeftover(): Promise<void> {
    let pid = 0;
    try {
      pid = Number(JSON.parse(await readFile(this.pidFile, "utf8")).pid);
    } catch {
      return;
    }
    await rm(this.pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !pidAlive(pid)) return;
    const cmd = await (this.opts.processCommand ?? defaultProcessCommand)(pid);
    if (!cmd || !cmd.includes(this.binary)) return;
    this.log(`[orchestrator] stopping a sidecar left over from an earlier run (pid ${pid})`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    for (let i = 0; i < 50 && pidAlive(pid); i++) await sleep(100);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
  }

  private appendLog(text: string): void {
    try {
      const fd = openSync(this.logFile, "a");
      try {
        writeSync(fd, text.endsWith("\n") ? text : `${text}\n`);
      } finally {
        closeSync(fd);
      }
    } catch {
      // The log is a convenience; never fail over it.
    }
  }

  private async ensureBinary(): Promise<boolean> {
    const haveSource = existsSync(path.join(this.sourceDir, "go.mod"));
    const haveBinary = existsSync(this.binary);
    if (!haveSource) {
      if (haveBinary) {
        this.log(`[orchestrator] Go source not found at ${this.sourceDir}; using the existing binary`);
        return true;
      }
      this.fail(`Go source not found at ${this.sourceDir} and no built sidecar`);
      return false;
    }
    const hash = await hashGoSources(this.sourceDir);
    if (!(await needsBuild(this.binary, this.stampFile, hash))) return true;

    const goBin = (this.opts.findGo ?? (() => findGo(this.env)))();
    if (!goBin) {
      if (haveBinary) {
        this.log("[orchestrator] Go isn't installed, so the sidecar can't be rebuilt; using the existing (older) binary");
        return true;
      }
      this.fail("Go isn't installed (no `go` on PATH, /opt/homebrew/bin or /usr/local/go/bin), so the sidecar can't be built. Install it with `brew install go`");
      return false;
    }

    this.state = "building";
    this.log(`[orchestrator] building the sidecar (${haveBinary ? "source changed" : "no binary yet"})`);
    await mkdir(path.dirname(this.binary), { recursive: true });
    const tmp = `${this.binary}.${randomBytes(4).toString("hex")}.tmp`;
    const started = this.now();
    const res = await (this.opts.build ?? defaultBuild)(goBin, ["build", "-trimpath", "-o", tmp, "./cmd/orchestrator"], {
      cwd: this.sourceDir,
      env: sidecarEnv({ addr: this.addr, boopUrl: this.boopUrl(), base: this.env }),
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    this.appendLog(`${new Date(this.now()).toISOString()} [boop] go build ${res.ok ? "ok" : "FAILED"}${res.output ? `\n${res.output}` : ""}`);
    if (!res.ok || !existsSync(tmp)) {
      await rm(tmp, { force: true });
      const first = res.output.split("\n").find((l) => l.trim()) ?? "unknown error";
      if (haveBinary) {
        this.log(`[orchestrator] build failed (${first}); using the previous binary. Details in ${this.logFile}`);
        return true;
      }
      this.fail(`the sidecar build failed (${first}); details in ${this.logFile}`);
      return false;
    }
    await rename(tmp, this.binary);
    await writeFile(this.stampFile, `${JSON.stringify({ hash, builtAt: this.now() })}\n`);
    this.log(`[orchestrator] built the sidecar in ${Math.round((this.now() - started) / 100) / 10}s`);
    return true;
  }

  private async readKey(): Promise<string | null> {
    try {
      const v = await (this.opts.getApiKey ?? (async () => null))();
      return v && v.trim() ? v.trim() : null;
    } catch {
      return null;
    }
  }

  private async rotateLog(): Promise<void> {
    try {
      if ((await stat(this.logFile)).size > LOG_ROTATE_BYTES) await rename(this.logFile, `${this.logFile}.1`);
    } catch {
      // No log yet.
    }
  }

  private async spawnChild(): Promise<void> {
    if (this.stopping) return;
    const key = await this.readKey();
    this.keyPresent = key !== null;
    this.keyFingerprint = key ? createHash("sha256").update(key).digest("hex") : null;
    if (key && this.restarts === 0) {
      this.log(`[orchestrator] ${SIDECAR_KEY_NAME} is in the secret store: the planner and merger will call the Anthropic API with it instead of Boop's Claude runtime`);
    }
    await this.rotateLog();
    this.state = this.restarts > 0 ? "restarting" : "starting";
    const fd = openSync(this.logFile, "a");
    let child: ChildProcess;
    try {
      writeSync(fd, `${new Date(this.now()).toISOString()} [boop] starting sidecar on ${this.addr} (planner and merger via ${key ? "the Anthropic API" : "Boop's Claude runtime"})\n`);
      child = (this.opts.spawn ?? spawn)(this.binary, [], {
        cwd: this.stateDir,
        env: sidecarEnv({ addr: this.addr, boopUrl: this.boopUrl(), apiKey: key, base: this.env }),
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    this.child = child;
    this.keyPassed = key !== null;
    this.startedAt = this.now();
    this.problem = null;
    this.failedChecks = 0;
    this.childExited = new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
        if (done) return;
        done = true;
        this.onChildExit(child, code, signal, error);
        resolve();
      };
      child.once("exit", (code, signal) => finish(code, signal));
      child.once("error", (err) => finish(null, null, err));
    });
    if (child.pid) await writeFile(this.pidFile, `${JSON.stringify({ pid: child.pid, binary: this.binary })}\n`).catch(() => undefined);

    // Wait for it to answer, so the first turn after boot already has the tools.
    const deadline = this.now() + (this.opts.startTimeoutMs ?? 15_000);
    while (this.child === child && this.now() < deadline) {
      if (await this.checkHealth()) {
        this.state = "running";
        this.log(`[orchestrator] sidecar running on ${this.url} (pid ${child.pid}${this.lastHealth?.planner ? `, planner and merger via ${this.lastHealth.llm === "anthropic" ? "the Anthropic API" : "Boop's Claude runtime"}` : ", no planner: hand-written plans only"}); orchestrator tools on`);
        return;
      }
      await sleep(250);
    }
    if (this.child === child) {
      this.log(`[orchestrator] the sidecar started but isn't answering at ${this.url} yet; tools stay off until it does (log: ${this.logFile})`);
    }
  }

  private boopUrl(): string {
    return this.opts.boopUrl ?? `http://127.0.0.1:${this.env.PORT ?? 3456}`;
  }

  private onChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.childExited = null;
    this.keyPassed = false;
    void rm(this.pidFile, { force: true }).catch(() => undefined);
    const at = this.now();
    this.lastExit = { at, code, signal };
    this.lastHealth = { at, ok: false, error: error ? error.message : "process exited" };
    recordOrchestratorHealth(false, at);
    if (this.stopping || this.expectExit) {
      this.expectExit = false;
      this.state = "stopped";
      return;
    }
    const ranFor = this.startedAt ? at - this.startedAt : 0;
    this.failuresInARow = ranFor >= (this.opts.stableAfterMs ?? 60_000) ? 1 : this.failuresInARow + 1;
    const delay = restartDelayMs(this.failuresInARow);
    this.state = "restarting";
    this.problem = error
      ? `the sidecar couldn't be started: ${error.message}`
      : `the sidecar exited (${signal ? `signal ${signal}` : `code ${code}`}); see ${this.logFile}`;
    this.log(`[orchestrator] ${this.problem}; orchestrator tools off, restarting in ${Math.round(delay / 1000)}s`);
    this.nextRestartAt = at + delay;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.nextRestartAt = null;
      void this.serial(async () => {
        if (this.stopping || this.child) return;
        this.restarts++;
        try {
          await this.spawnChild();
        } catch (err) {
          this.fail(`couldn't restart the sidecar: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  private startHealthLoop(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => void this.healthTick(), this.opts.healthIntervalMs ?? 15_000);
    this.healthTimer.unref?.();
  }

  private async healthTick(): Promise<void> {
    if (this.stopping) return;
    const ok = await this.checkHealth();
    if (ok) {
      this.failedChecks = 0;
      if (this.child && this.state !== "running") {
        this.state = "running";
        this.log("[orchestrator] sidecar answering again; orchestrator tools on");
      }
      return;
    }
    if (this.child) {
      this.failedChecks++;
      if (this.failedChecks >= (this.opts.maxFailedChecks ?? 4)) {
        this.log(`[orchestrator] sidecar hasn't answered ${this.failedChecks} health checks in a row; restarting it`);
        this.failedChecks = 0;
        this.child.kill("SIGKILL");
      }
    } else if (this.state === "external") {
      // The sidecar we were borrowing went away: run our own.
      this.log("[orchestrator] the external sidecar stopped answering; starting Boop's own");
      void this.serial(async () => {
        if (this.stopping || this.child || this.state !== "external") return;
        this.managed = true;
        if (await this.ensureBinary()) await this.spawnChild();
      }).catch(() => undefined);
    }
  }

  /** One health check: records it and flips the tools on or off. */
  async checkHealth(): Promise<boolean> {
    const at = this.now();
    try {
      const h = await this.client.health();
      const ok = h?.ok !== false;
      this.lastHealth = {
        at,
        ok,
        planner: h?.planner === true,
        ...(typeof h?.merger === "boolean" ? { merger: h.merger } : {}),
        ...(h?.llm === "boop" || h?.llm === "anthropic" || h?.llm === "" ? { llm: h.llm } : {}),
      };
      recordOrchestratorHealth(ok, at);
      return ok;
    } catch (err) {
      this.lastHealth = { at, ok: false, error: err instanceof Error ? err.message : String(err) };
      recordOrchestratorHealth(false, at);
      return false;
    }
  }

  /**
   * Re-reads the key from the secret store. If it was added, changed or
   * removed since the running sidecar started, restarts it with the new env.
   */
  async refreshKey(): Promise<void> {
    await this.serial(async () => {
      const key = await this.readKey();
      this.keyPresent = key !== null;
      if (!this.managed || !this.child || this.stopping) return;
      const fp = key ? createHash("sha256").update(key).digest("hex") : null;
      if (fp === this.keyFingerprint) return;
      this.log(`[orchestrator] ${SIDECAR_KEY_NAME} ${key ? (this.keyFingerprint ? "changed" : "added") : "removed"} in the secret store; restarting the sidecar to pick it up`);
      await this.stopChild();
      await this.spawnChild();
    });
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    const exited = this.childExited;
    if (!child || !exited) return;
    this.expectExit = true;
    child.kill("SIGTERM");
    const timeout = this.opts.stopTimeoutMs ?? 5_000;
    const killed = await Promise.race([exited.then(() => false), sleep(timeout).then(() => true)]);
    if (killed) {
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(1_000)]);
    }
  }

  /** Stops the sidecar and the loops. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.nextRestartAt = null;
    await this.stopChild();
    this.child = null;
    if (this.managed) this.state = "stopped";
    await rm(this.pidFile, { force: true }).catch(() => undefined);
    recordOrchestratorHealth(false, this.now());
  }

  /**
   * Submits a two-step echo plan and checks a merged result comes back with
   * both steps in it. Uses no Boop sub-agents; with the key, the merge is a
   * small model call.
   */
  selfTest(opts: { maxWaitMs?: number } = {}): Promise<SelfTestRecord> {
    this.selfTestRunning ??= this.runSelfTest(opts.maxWaitMs ?? 60_000).finally(() => {
      this.selfTestRunning = null;
    });
    return this.selfTestRunning;
  }

  private async runSelfTest(maxWaitMs: number): Promise<SelfTestRecord> {
    const started = this.now();
    const record = (r: Omit<SelfTestRecord, "at" | "ms">): SelfTestRecord => {
      this.lastSelfTest = { ...r, at: this.now(), ms: this.now() - started };
      return this.lastSelfTest;
    };
    if (!(await this.checkHealth())) {
      return record({ ok: false, detail: `the sidecar isn't answering at ${this.url}${this.lastHealth?.error ? ` (${this.lastHealth.error})` : ""}` });
    }
    const { plan, urls } = selfTestPlan(randomBytes(6).toString("hex"));
    try {
      const run = await this.client.submitRun({ plan, maxTokens: 20_000, maxParallel: 2 });
      const res = await this.client.waitForResult(run.id, maxWaitMs);
      const verdict = checkSelfTestResult(res, urls);
      return record({ ...verdict, runId: run.id, method: res.result?.method });
    } catch (err) {
      return record({ ok: false, detail: `the test run failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

let sidecar: OrchestratorSidecar | null = null;

/** The one supervisor for this Boop process. */
export function orchestratorSidecar(opts?: SidecarOptions): OrchestratorSidecar {
  sidecar ??= new OrchestratorSidecar(opts);
  return sidecar;
}

/** For tests. */
export function setOrchestratorSidecarForTests(s: OrchestratorSidecar | null): void {
  sidecar = s;
}
