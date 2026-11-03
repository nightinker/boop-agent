import { mkdirSync, readdirSync, rmSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactSecrets, redactValues, type KnownSecret } from "../secrets/redact.js";
import { ciStatus, formatCheckResults, runSuite, type CheckResult } from "./checks.js";
import {
  BrowserUnavailableError,
  launchHeadlessChromium,
  type LaunchBrowser,
  type WebTestBrowser,
  type WebTestSession,
} from "./driver.js";
import {
  describeStep,
  planSecretNames,
  planSessionNames,
  type Scenario,
  type Step,
  type WebTestPlan,
} from "./plan.js";
import {
  classifyUrl,
  destructiveReason,
  effectiveBaseUrl,
  preflightPlan,
  resolvePlanUrl,
  type UrlEnvironment,
} from "./safety.js";
import {
  defaultCredentialSource,
  lockDownSessionFile,
  prepareSessionPath,
  sessionExists,
  sessionPath,
  type CredentialSource,
} from "./storage.js";

/**
 * Runs a WebTestPlan step by step in a fresh headless browser and returns a
 * pass/fail report with a screenshot per step, failure details, console and
 * network errors, and any repo/CI checks the plan asked for.
 */

export const SCREENSHOT_ROOT = path.join(tmpdir(), "boop-webtest");
const KEEP_RUNS = 20;
const POLL_INTERVAL_MS = 200;
export const DEFAULT_MAX_RUN_MS = 15 * 60_000;

export type StepStatus = "passed" | "failed" | "skipped" | "refused";

export interface StepResult {
  index: number;
  description: string;
  status: StepStatus;
  optional: boolean;
  durationMs: number;
  url?: string;
  error?: string;
  screenshot?: string;
  console: string[];
  network: string[];
}

export interface ScenarioResult {
  name: string;
  status: "passed" | "failed" | "refused";
  steps: StepResult[];
  durationMs: number;
  error?: string;
}

export interface ReportScreenshot {
  path: string;
  scenario: string;
  step: string;
  failed: boolean;
}

export interface WebTestReport {
  plan: string;
  status: "passed" | "failed" | "refused" | "unavailable" | "error";
  environment: UrlEnvironment;
  hosts: string[];
  message?: string;
  scenarios: ScenarioResult[];
  checks: CheckResult[];
  screenshots: ReportScreenshot[];
  runDir?: string;
  durationMs: number;
  savedSession?: string;
}

export interface RunOptions {
  /** Only true when the owner explicitly confirmed destructive steps on production in this conversation. */
  confirmProductionDestructive?: boolean;
  /** After the (last) scenario, save the browser's cookies/storage under this session name. */
  saveSessionAs?: string;
  launch?: LaunchBrowser;
  credentials?: CredentialSource;
  runCi?: typeof ciStatus;
  runSuiteCheck?: typeof runSuite;
  env?: NodeJS.ProcessEnv;
  screenshotRoot?: string;
  maxRunMs?: number;
  now?: () => number;
}

class StepFailure extends Error {}
class StepRefused extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

async function poll(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "step";
}

function newRunDir(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
    const runs = readdirSync(root)
      .filter((d) => d.startsWith("run-"))
      .map((d) => ({ d, t: statSync(path.join(root, d)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { d } of runs.slice(0, Math.max(0, runs.length - (KEEP_RUNS - 1)))) {
      rmSync(path.join(root, d), { recursive: true, force: true });
    }
  } catch {
    // Pruning is best-effort.
  }
  const dir = path.join(root, `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Playwright errors carry a long "Call log"; the first lines are the useful part.
  return message.split("\n").filter((l) => l.trim()).slice(0, 3).join(" ").slice(0, 500);
}

interface StepContext {
  session: WebTestSession;
  baseUrl: string | undefined;
  secrets: Record<string, string>;
  timeoutMs: number;
  confirmProductionDestructive: boolean;
  env: NodeJS.ProcessEnv;
  screenshotPath: () => string;
  takeScreenshot: (file: string, fullPage: boolean) => Promise<string | undefined>;
}

async function executeStep(step: Step, ctx: StepContext): Promise<string | undefined> {
  const { session } = ctx;
  const timeoutMs = step.timeoutMs ?? ctx.timeoutMs;
  const reason = destructiveReason(step);
  if (reason && !ctx.confirmProductionDestructive) {
    const where = step.action === "request" ? resolvePlanUrl(step.url, ctx.baseUrl) : session.url();
    if (classifyUrl(where, ctx.env) === "production") {
      throw new StepRefused(
        `Refused on production (${new URL(where).host}): this step ${reason}. Not run. Use staging, or get the owner's explicit confirmation first.`,
      );
    }
  }
  switch (step.action) {
    case "goto": {
      const url = resolvePlanUrl(step.url, ctx.baseUrl);
      const { status } = await session.goto(url, Math.max(timeoutMs, 30_000));
      if (status !== null && status >= 400) throw new StepFailure(`${url} answered HTTP ${status}.`);
      return;
    }
    case "click":
      return void (await session.click(step.target, timeoutMs));
    case "hover":
      return void (await session.hover(step.target, timeoutMs));
    case "fill": {
      const value = step.secret ? ctx.secrets[step.secret] : step.value;
      if (value === undefined) throw new StepFailure(`Secret ${step.secret} is not available.`);
      return void (await session.fill(step.target, value, timeoutMs));
    }
    case "select":
      return void (await session.select(step.target, step.value, timeoutMs));
    case "check":
      return void (await session.setChecked(step.target, step.checked, timeoutMs));
    case "press":
      return void (await session.press(step.key, step.target, timeoutMs));
    case "wait":
      return void (await sleep(step.ms));
    case "waitFor": {
      const want = step.state === "visible";
      const ok = await poll(async () => (await session.isVisible(step.target)) === want, timeoutMs);
      if (!ok) throw new StepFailure(`Still ${want ? "not visible" : "visible"} after ${timeoutMs} ms.`);
      return;
    }
    case "expectVisible":
    case "expectHidden": {
      const want = step.action === "expectVisible";
      const ok = await poll(async () => (await session.isVisible(step.target)) === want, timeoutMs);
      if (!ok) throw new StepFailure(want ? "Not visible on the page." : "Still visible on the page.");
      return;
    }
    case "expectText": {
      const needle = normalizeText(step.text);
      let last = "";
      const ok = await poll(async () => {
        last = await session.readText(step.target);
        return normalizeText(last).includes(needle) !== step.absent;
      }, timeoutMs);
      if (!ok) {
        const preview = last.replace(/\s+/g, " ").trim().slice(0, 200);
        throw new StepFailure(
          step.absent
            ? `The page still shows "${step.text}".`
            : `"${step.text}" not found on ${session.url()}.${preview ? ` Visible text starts: "${preview}${last.length > 200 ? "…" : ""}"` : " The page has no visible text."}`,
        );
      }
      return;
    }
    case "expectUrl": {
      const re = step.matches ? new RegExp(step.matches) : null;
      const ok = await poll(async () => {
        const url = session.url();
        return re ? re.test(url) : url.includes(step.contains ?? "");
      }, timeoutMs);
      if (!ok) throw new StepFailure(`URL is ${session.url()}.`);
      return;
    }
    case "expectTitle": {
      let title = "";
      const ok = await poll(async () => {
        title = await session.title();
        return normalizeText(title).includes(normalizeText(step.contains));
      }, timeoutMs);
      if (!ok) throw new StepFailure(`Title is "${title}".`);
      return;
    }
    case "request": {
      const url = resolvePlanUrl(step.url, ctx.baseUrl);
      const headers: Record<string, string> = { ...(step.headers ?? {}) };
      for (const [header, name] of Object.entries(step.secretHeaders ?? {})) {
        const value = ctx.secrets[name];
        if (value === undefined) throw new StepFailure(`Secret ${name} is not available.`);
        headers[header] = value;
      }
      const res = await session.request(url, { method: step.method, headers, body: step.body, timeoutMs });
      const body = res.body.replace(/\s+/g, " ").trim();
      if (step.status && !step.status.includes(res.status)) {
        throw new StepFailure(`Expected HTTP ${step.status.join(" or ")}, got ${res.status}.${body ? ` Body: ${body.slice(0, 200)}` : ""}`);
      }
      if (!step.status && res.status >= 400) {
        throw new StepFailure(`HTTP ${res.status}.${body ? ` Body: ${body.slice(0, 200)}` : ""}`);
      }
      if (step.bodyContains && !res.body.includes(step.bodyContains)) {
        throw new StepFailure(`Response (HTTP ${res.status}) doesn't contain "${step.bodyContains}". Body: ${body.slice(0, 200)}`);
      }
      return;
    }
    case "screenshot":
      return await ctx.takeScreenshot(ctx.screenshotPath(), step.fullPage);
  }
}

async function runScenario(
  scenario: Scenario,
  scenarioIndex: number,
  browser: WebTestBrowser,
  plan: WebTestPlan,
  opts: {
    baseUrl: string | undefined;
    secrets: Record<string, string>;
    runDir: string;
    confirm: boolean;
    env: NodeJS.ProcessEnv;
    deadline: number;
    saveSessionTo?: string;
  },
  screenshots: ReportScreenshot[],
): Promise<ScenarioResult> {
  const started = Date.now();
  const sessionName = scenario.session === undefined ? plan.session : scenario.session;
  const session = await browser.newSession({
    ...(sessionName ? { storageStatePath: sessionPath(sessionName, opts.env) } : {}),
    ...(plan.device ? { device: plan.device } : {}),
    ...(plan.viewport ? { viewport: plan.viewport } : {}),
  });
  const steps: StepResult[] = [];
  let failed = false;
  let refused = false;
  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const description = describeStep(step);
      const base = { index: i + 1, description, optional: Boolean(step.optional), console: [], network: [] };
      if ((failed && plan.stopOnFailure) || refused) {
        steps.push({ ...base, status: "skipped", durationMs: 0 });
        continue;
      }
      if (Date.now() > opts.deadline) {
        steps.push({ ...base, status: "skipped", durationMs: 0, error: "Run time limit reached." });
        failed = true;
        continue;
      }
      const file = path.join(opts.runDir, `${scenarioIndex + 1}-${String(i + 1).padStart(2, "0")}-${slug(description)}.png`);
      const takeScreenshot = async (target: string, fullPage: boolean) => {
        try {
          await session.screenshot(target, fullPage);
          return target;
        } catch {
          return undefined;
        }
      };
      const t0 = Date.now();
      let status: StepStatus = "passed";
      let error: string | undefined;
      let shot: string | undefined;
      try {
        shot = await executeStep(step, {
          session,
          baseUrl: opts.baseUrl,
          secrets: opts.secrets,
          timeoutMs: plan.timeoutMs,
          confirmProductionDestructive: opts.confirm,
          env: opts.env,
          screenshotPath: () => file,
          takeScreenshot,
        });
      } catch (err) {
        status = err instanceof StepRefused ? "refused" : "failed";
        error = errorText(err);
      }
      const durationMs = Date.now() - t0;
      if (!shot && plan.screenshots !== "none" && (plan.screenshots === "each" || status !== "passed") && status !== "refused") {
        shot = await takeScreenshot(file, false);
      }
      const events = session.drainEvents();
      let url: string | undefined;
      try {
        url = session.url();
      } catch {
        url = undefined;
      }
      steps.push({
        ...base,
        status,
        durationMs,
        ...(url ? { url } : {}),
        ...(error ? { error } : {}),
        ...(shot ? { screenshot: shot } : {}),
        console: events.console,
        network: events.network,
      });
      if (shot) screenshots.push({ path: shot, scenario: scenario.name, step: `${i + 1}. ${description}`, failed: status !== "passed" });
      if (status === "refused") refused = true;
      else if (status === "failed" && !step.optional) failed = true;
    }
    if (opts.saveSessionTo && !failed && !refused) {
      await session.saveStorageState(opts.saveSessionTo);
      await lockDownSessionFile(opts.saveSessionTo);
    }
  } finally {
    await session.close();
  }
  return {
    name: scenario.name,
    status: refused ? "refused" : failed ? "failed" : "passed",
    steps,
    durationMs: Date.now() - started,
  };
}

/** Redacts every credential the run used, plus everything in the secret store. */
function redactReport(report: WebTestReport, known: KnownSecret[]): WebTestReport {
  const scrub = (s: string) => redactSecrets(redactValues(s, known));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(report) as WebTestReport;
}

export async function runWebTestPlan(plan: WebTestPlan, opts: RunOptions = {}): Promise<WebTestReport> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const started = now();
  const preflight = preflightPlan(plan, { confirmProductionDestructive: opts.confirmProductionDestructive, env });
  const base: Omit<WebTestReport, "status" | "durationMs"> = {
    plan: plan.name,
    environment: preflight.environment,
    hosts: preflight.hosts,
    scenarios: [],
    checks: [],
    screenshots: [],
  };
  const finish = (r: Omit<WebTestReport, "durationMs">, known: KnownSecret[] = []) =>
    redactReport({ ...r, durationMs: now() - started }, known);

  if (!preflight.ok) {
    return finish({ ...base, status: preflight.errors.length ? "error" : "refused", message: preflight.refusal });
  }

  // Credentials by name only; values go straight to the browser and are redacted from everything we return.
  const secretNames = planSecretNames(plan);
  const credentials = opts.credentials ?? defaultCredentialSource({ env });
  const { values: secrets, missing } = secretNames.length ? await credentials.getMany(secretNames) : { values: {}, missing: [] };
  const known: KnownSecret[] = Object.entries(secrets).map(([name, value]) => ({ name, value }));
  if (missing.length) return finish({ ...base, status: "error", message: credentials.missingHint(missing) }, known);

  for (const name of planSessionNames(plan)) {
    if (!(await sessionExists(name, env))) {
      return finish(
        {
          ...base,
          status: "error",
          message: `Saved session "${name}" doesn't exist on this machine. Create it with webtest_save_session (a login plan), or copy a Playwright storage-state file to ${sessionPath(name, env)}.`,
        },
        known,
      );
    }
  }

  let saveSessionTo: string | undefined;
  if (opts.saveSessionAs) saveSessionTo = await prepareSessionPath(opts.saveSessionAs, env);

  const runDir = newRunDir(opts.screenshotRoot ?? SCREENSHOT_ROOT);
  const scenarios: ScenarioResult[] = [];
  const screenshots: ReportScreenshot[] = [];
  let unavailable: string | undefined;
  let browser: WebTestBrowser | null = null;
  try {
    browser = await (opts.launch ?? (() => launchHeadlessChromium(env)))();
  } catch (err) {
    unavailable = err instanceof BrowserUnavailableError ? err.message : `Couldn't start the browser: ${errorText(err)}`;
  }

  if (browser) {
    const deadline = now() + (opts.maxRunMs ?? DEFAULT_MAX_RUN_MS);
    try {
      for (let i = 0; i < plan.scenarios.length; i++) {
        const scenario = plan.scenarios[i];
        try {
          scenarios.push(
            await runScenario(scenario, i, browser, plan, {
              baseUrl: effectiveBaseUrl(plan, env),
              secrets,
              runDir,
              confirm: Boolean(opts.confirmProductionDestructive),
              env,
              deadline,
              ...(saveSessionTo && i === plan.scenarios.length - 1 ? { saveSessionTo } : {}),
            }, screenshots),
          );
        } catch (err) {
          scenarios.push({ name: scenario.name, status: "failed", steps: [], durationMs: 0, error: errorText(err) });
        }
      }
    } finally {
      await browser.close();
    }
  }

  // Repo/CI checks don't need the browser, so they run even when it's unavailable.
  const checks: CheckResult[] = [];
  for (const ci of plan.checks?.ci ?? []) checks.push(await (opts.runCi ?? ciStatus)(ci));
  for (const suite of plan.checks?.suites ?? []) checks.push(await (opts.runSuiteCheck ?? runSuite)(suite));

  const anyFailed =
    scenarios.some((s) => s.status !== "passed") || checks.some((c) => c.status === "failed" || c.status === "error");
  const savedSession =
    saveSessionTo && scenarios.length === plan.scenarios.length && scenarios.at(-1)?.status === "passed" ? opts.saveSessionAs : undefined;
  const report: Omit<WebTestReport, "durationMs"> = {
    ...base,
    status: unavailable ? "unavailable" : scenarios.some((s) => s.status === "refused") ? "refused" : anyFailed ? "failed" : "passed",
    ...(unavailable ? { message: unavailable } : {}),
    scenarios,
    checks,
    screenshots,
    runDir,
    ...(savedSession ? { savedSession } : {}),
  };
  const redacted = finish(report, known);
  try {
    writeFileSync(path.join(runDir, "report.json"), JSON.stringify(redacted, null, 2), { mode: 0o600 });
  } catch {
    // The report file is a convenience; the returned report is what matters.
  }
  return redacted;
}

// --- formatting ----------------------------------------------------------------

const STATUS_LINE: Record<WebTestReport["status"], string> = {
  passed: "PASSED",
  failed: "FAILED",
  refused: "REFUSED",
  unavailable: "COULDN'T RUN (browser unavailable)",
  error: "COULDN'T RUN",
};

const ENV_LABEL: Record<UrlEnvironment, string> = {
  local: "local",
  "non-production": "non-production",
  production: "PRODUCTION",
};

const STEP_ICON: Record<StepStatus, string> = { passed: "✓", failed: "✗", skipped: "–", refused: "⛔" };

/** Picks the screenshots most worth attaching: failures first, then each scenario's last step. */
export function screenshotsToAttach(report: WebTestReport, max = 5): ReportScreenshot[] {
  const failed = report.screenshots.filter((s) => s.failed);
  const lastPerScenario = report.scenarios
    .map((sc) => [...report.screenshots].reverse().find((s) => s.scenario === sc.name && !s.failed))
    .filter((s): s is ReportScreenshot => Boolean(s));
  const out: ReportScreenshot[] = [];
  for (const s of [...failed, ...lastPerScenario]) {
    if (out.length >= max) break;
    if (!out.some((o) => o.path === s.path)) out.push(s);
  }
  return out;
}

export function formatReport(report: WebTestReport): string {
  const lines: string[] = [];
  const passedCount = report.scenarios.filter((s) => s.status === "passed").length;
  lines.push(
    `Web test "${report.plan}": ${STATUS_LINE[report.status]}${report.scenarios.length ? ` — ${passedCount}/${report.scenarios.length} scenarios passed` : ""} (${Math.round(report.durationMs / 1000)}s)`,
  );
  if (report.hosts.length) lines.push(`Target: ${report.hosts.join(", ")} (${ENV_LABEL[report.environment]})`);
  if (report.message) lines.push("", report.message);
  for (const sc of report.scenarios) {
    lines.push("", `${sc.status === "passed" ? "✅" : sc.status === "refused" ? "⛔" : "❌"} ${sc.name} (${(sc.durationMs / 1000).toFixed(1)}s)`);
    if (sc.error) lines.push(`  Error: ${sc.error}`);
    for (const st of sc.steps) {
      const opt = st.optional && st.status === "failed" ? " (optional)" : "";
      lines.push(`  ${STEP_ICON[st.status]} ${st.index}. ${st.description}${opt}`);
      if (st.error) lines.push(`      ${st.error}`);
      if (st.status !== "passed" && st.status !== "skipped") {
        if (st.url) lines.push(`      At: ${st.url}`);
        if (st.screenshot) lines.push(`      Screenshot: ${st.screenshot}`);
      }
      if (st.console.length) lines.push(`      Console errors: ${st.console.slice(0, 3).join(" | ")}${st.console.length > 3 ? ` (+${st.console.length - 3})` : ""}`);
      if (st.network.length) lines.push(`      Network errors: ${st.network.slice(0, 3).join(" | ")}${st.network.length > 3 ? ` (+${st.network.length - 3})` : ""}`);
    }
  }
  if (report.checks.length) lines.push("", "Repo checks:", formatCheckResults(report.checks));
  if (report.savedSession) lines.push("", `Saved session "${report.savedSession}" for later runs.`);
  const attach = screenshotsToAttach(report);
  if (attach.length) {
    lines.push("", "Screenshots to attach (attach_image):");
    for (const s of attach) lines.push(`- ${s.path}  [${s.failed ? "FAILED " : ""}${s.scenario} — ${s.step}]`);
  }
  if (report.runDir && report.screenshots.length) {
    lines.push(`All ${report.screenshots.length} screenshots and report.json: ${report.runDir}`);
  }
  return lines.join("\n");
}
