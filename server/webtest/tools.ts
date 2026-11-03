import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { redactSecrets } from "../secrets/redact.js";
import { ciStatus, execCommand, formatCheckResults, runSuite, type Exec } from "./checks.js";
import { checkHeadlessBrowser, type LaunchBrowser } from "./driver.js";
import { parsePlan, SESSION_NAME_RE, type WebTestPlan } from "./plan.js";
import { formatReport, runWebTestPlan, type RunOptions } from "./runner.js";
import { classifyUrl } from "./safety.js";
import {
  deleteSession,
  listPlans,
  listSessions,
  readPlanText,
  savePlanText,
  webtestDir,
  WEBTEST_ENV_PREFIX,
} from "./storage.js";

export const WEBTEST_NAMESPACE = "webtest";
export const WEBTEST_INTEGRATION = "webtest";

export const WEBTEST_EXECUTION_PROMPT = `

Web app testing ("webtest" tools, headless Chromium on whatever machine Boop runs on, Mac or Linux server):
- For "test/check/QA this site/flow": turn the request into a plan (YAML) and call run_browser_test. For a quick look at one page, use browser_check.
- Plan format: name, baseUrl, optional session, then scenarios: [{ name, steps: [...] }]. Each step has ONE action: goto, click, hover, fill, select, check, press, waitFor, wait, expectText, expectVisible, expectHidden, expectUrl, expectTitle, request, screenshot. Targets are a selector string or { role, name } / { text } / { label } / { placeholder } / { testId }. Example:
    name: Upgrade flow
    baseUrl: https://staging.example.com
    session: staging-monthly-user
    scenarios:
      - name: Monthly user sees lifetime offer
        steps:
          - goto: /account/subscription
          - click: { role: button, name: Upgrade }
          - expectText: Lifetime
      - name: Guest gets 409
        session: null
        steps:
          - request: { method: POST, url: /api/subscription/upgrade, status: 409 }
- Credentials: NEVER put a password or token in a plan. Use fill: { label: Password, secret: WEBTEST_SITE_PASSWORD } (a secret NAME) or a saved session (save_test_session once, then session: <name>). If a name is missing, stop and say which one.
- Default to staging/preview URLs. Production plans with destructive steps (pay, buy, upgrade, delete, cancel, non-GET requests) are refused; only pass confirmProductionDestructive: true if the owner explicitly confirmed those exact actions in this conversation.
- Use ci_status / run_repo_tests (or the plan's checks:) to include CI and repo test results.
- Report pass/fail per scenario with the failure details, and attach the screenshots the report lists (failures first) with attach_image when you have it. If the browser isn't installed, say so and give the setup step from the report (webtest_setup can install it).`;

export const WEBTEST_DISPATCHER_PROMPT = `
Web app testing:
The "webtest" integration runs a headless Chromium on the machine Boop is on (works on the Linux server too, no Mac needed). When the user asks to test, QA, smoke-test or check a web app/flow/page (e.g. a staging site), spawn_agent with ["webtest"] and pass the scenarios in the task in plain words or as the user's checklist; the sub-agent turns them into a plan, runs it, and attaches screenshots. Mention the base URL (default to staging, not production), any saved session name, and secret NAMES for test logins; never put passwords in the task. Destructive actions on production (payments, deletes) need the user's explicit confirmation first. For CI/test-suite status, include the repo (owner/name) and PR or branch.`;

const planInput = z
  .string()
  .min(1)
  .describe("The plan as YAML or JSON text (see the tool description for the format).");

const MAX_CONCURRENT_RUNS = 2;
let activeRuns = 0;

async function withRunSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (activeRuns >= MAX_CONCURRENT_RUNS) return null;
  activeRuns++;
  try {
    return await fn();
  } finally {
    activeRuns--;
  }
}

const BUSY = runtimeText(
  `${MAX_CONCURRENT_RUNS} browser tests are already running on this machine. Wait for one to finish, then try again.`,
  false,
);

export interface WebTestToolDeps {
  launch?: LaunchBrowser;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  runOptions?: Partial<RunOptions>;
}

function fail(err: unknown) {
  return runtimeText(redactSecrets(err instanceof Error ? err.message : String(err)), false);
}

async function loadPlan(args: { plan?: string; planName?: string }, env: NodeJS.ProcessEnv): Promise<WebTestPlan> {
  if (args.plan && args.planName) throw new Error("Pass either plan or planName, not both.");
  if (args.planName) {
    const text = await readPlanText(args.planName, env);
    if (text === null) throw new Error(`No saved plan named "${args.planName}". list_test_plans shows the saved ones.`);
    return parsePlan(text);
  }
  if (!args.plan) throw new Error("Pass a plan (YAML/JSON) or the name of a saved plan.");
  return parsePlan(args.plan);
}

export function createWebTestTools(deps: WebTestToolDeps = {}, namespace = WEBTEST_NAMESPACE): RuntimeTool[] {
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? execCommand;
  const runOpts = (extra: Partial<RunOptions>): RunOptions => ({
    env,
    ...(deps.launch ? { launch: deps.launch } : {}),
    runCi: (c) => ciStatus(c, exec),
    runSuiteCheck: (s) => runSuite(s, { exec }),
    ...deps.runOptions,
    ...extra,
  });

  return [
    defineRuntimeTool(
      namespace,
      "run_browser_test",
      [
        "Run a web test plan in a fresh headless Chromium (works on the Mac and on Boop's Linux server) and get a pass/fail report: per-step results, a screenshot per step, failure details, console and network errors, plus CI/test-suite checks if the plan lists them.",
        "Plan = YAML/JSON: name, baseUrl, session (saved login), device (iphone/ipad/desktop…), screenshots (each|failures|none), stopOnFailure, timeoutMs, scenarios [{name, session (null = logged out), steps}] (or top-level steps), checks {ci: [{repo, pr|branch|commit}], suites: [{cwd, script}]}.",
        "Step actions (one per step, plus optional name/optional/destructive/timeoutMs): goto: url | click/hover/expectVisible/expectHidden: target | fill: {<target>, value | secret: NAME} | select: {<target>, value} | check: {<target>, checked} | press: key or {key, <target>} | waitFor: {<target>, state} | wait: ms | expectText: text or {text, in: target, absent} | expectUrl: substring or {matches} | expectTitle: text | request: {method, url, status, bodyContains, body, headers, secretHeaders: {Header: NAME}} | screenshot: label or {label, fullPage}.",
        "Target = CSS/Playwright selector string, or {role, name} | {text} | {label} | {placeholder} | {testId}, with optional exact/nth.",
        "Secrets are NAMES only. Production URLs with destructive steps are refused unless confirmProductionDestructive is true.",
      ].join(" "),
      {
        plan: planInput.optional(),
        planName: z.string().optional().describe("Run a plan saved with save_test_plan instead."),
        confirmProductionDestructive: z
          .boolean()
          .optional()
          .describe("Only true if the owner explicitly confirmed these destructive actions on production in this conversation."),
      },
      async (args) => {
        try {
          const plan = await loadPlan(args, env);
          const report = await withRunSlot(() =>
            runWebTestPlan(plan, runOpts({ confirmProductionDestructive: args.confirmProductionDestructive })),
          );
          if (!report) return BUSY;
          return runtimeText(formatReport(report), report.status === "passed");
        } catch (err) {
          return fail(err);
        }
      },
    ),
    defineRuntimeTool(
      namespace,
      "browser_check",
      "Quick headless check of one page: open the URL, optionally assert texts are shown (and others are not), capture console/network errors and a screenshot. Read-only. Use run_browser_test for flows.",
      {
        url: z.string().min(1).describe("Full URL, e.g. https://staging.example.com/privacy"),
        expectTexts: z.array(z.string().min(1)).max(20).optional().describe("Texts that must be visible on the page."),
        absentTexts: z.array(z.string().min(1)).max(20).optional().describe("Texts that must NOT be on the page."),
        session: z.string().regex(SESSION_NAME_RE).optional().describe("Saved session to load (logged-in view)."),
        device: z.string().optional().describe("Device preset, e.g. iphone, ipad, desktop."),
        fullPage: z.boolean().optional().describe("Screenshot the whole page instead of the viewport."),
      },
      async (args) => {
        try {
          const steps: unknown[] = [{ goto: args.url }];
          for (const text of args.expectTexts ?? []) steps.push({ expectText: text });
          for (const text of args.absentTexts ?? []) steps.push({ expectText: { text, absent: true } });
          steps.push({ screenshot: { label: "page", fullPage: args.fullPage ?? false } });
          const plan = parsePlan({
            name: `Check ${args.url}`,
            screenshots: "failures",
            stopOnFailure: false,
            ...(args.session ? { session: args.session } : {}),
            ...(args.device ? { device: args.device } : {}),
            steps,
          });
          const report = await withRunSlot(() => runWebTestPlan(plan, runOpts({})));
          if (!report) return BUSY;
          return runtimeText(formatReport(report), report.status === "passed");
        } catch (err) {
          return fail(err);
        }
      },
    ),
    defineRuntimeTool(
      namespace,
      "save_test_session",
      `Log in once and save the browser session (cookies + local storage) under a name, so later plans can use session: <name> without credentials. Pass a plan whose steps log in (use fill with secret: NAME for the password; secrets come from the secret store on the Mac or ${WEBTEST_ENV_PREFIX}* environment variables on the server). The session is saved only if every step passes. Sessions are stored privately on this machine (not synced between Mac and server).`,
      {
        name: z.string().regex(SESSION_NAME_RE).describe("Session name, e.g. staging-monthly-user."),
        plan: planInput.describe("Login plan as YAML/JSON, e.g. goto /login, fill email, fill password via secret, click Log in, expectUrl /dashboard."),
      },
      async (args) => {
        try {
          const plan = parsePlan(args.plan);
          if (plan.scenarios.length !== 1) throw new Error("A login plan has exactly one scenario (or top-level steps).");
          const report = await withRunSlot(() => runWebTestPlan(plan, runOpts({ saveSessionAs: args.name })));
          if (!report) return BUSY;
          const text = formatReport(report);
          return report.savedSession
            ? runtimeText(text)
            : runtimeText(`${text}\n\nThe session was NOT saved because the login didn't pass.`, false);
        } catch (err) {
          return fail(err);
        }
      },
    ),
    defineRuntimeTool(
      namespace,
      "list_test_sessions",
      "List saved browser sessions (names and when they were saved). Never shows cookies.",
      {},
      async () => {
        const sessions = await listSessions(env);
        if (!sessions.length) return runtimeText("No saved sessions on this machine. Create one with save_test_session.");
        return runtimeText(
          `Saved sessions:\n${sessions.map((s) => `- ${s.name} (saved ${new Date(s.updatedAt).toISOString().slice(0, 16)}Z)`).join("\n")}`,
        );
      },
    ),
    defineRuntimeTool(
      namespace,
      "delete_test_session",
      "Delete a saved browser session (e.g. after a test account's password changed).",
      { name: z.string().regex(SESSION_NAME_RE) },
      async (args) => {
        try {
          return (await deleteSession(args.name, env))
            ? runtimeText(`Deleted session ${args.name}.`)
            : runtimeText(`No session named ${args.name}.`, false);
        } catch (err) {
          return fail(err);
        }
      },
    ),
    defineRuntimeTool(
      namespace,
      "save_test_plan",
      "Validate and save a reusable test plan under a name, so it can be re-run later with run_browser_test { planName }. Saving the same name replaces it.",
      {
        name: z.string().regex(SESSION_NAME_RE).describe("Plan name, e.g. staging-smoke."),
        plan: planInput,
      },
      async (args) => {
        try {
          const plan = parsePlan(args.plan);
          if (/\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*["']?[^\s"'{}]{6,}/i.test(args.plan)) {
            throw new Error("The plan looks like it contains a credential. Use secret: NAME in fill steps (or a saved session) instead.");
          }
          const file = await savePlanText(args.name, args.plan, env);
          const steps = plan.scenarios.reduce((n, s) => n + s.steps.length, 0);
          return runtimeText(`Saved plan "${args.name}" (${plan.scenarios.length} scenarios, ${steps} steps) to ${file}.`);
        } catch (err) {
          return fail(err);
        }
      },
    ),
    defineRuntimeTool(
      namespace,
      "list_test_plans",
      "List saved test plans. Pass name to show one plan's contents.",
      { name: z.string().regex(SESSION_NAME_RE).optional() },
      async (args) => {
        if (args.name) {
          const text = await readPlanText(args.name, env);
          return text === null ? runtimeText(`No saved plan named ${args.name}.`, false) : runtimeText(text);
        }
        const plans = await listPlans(env);
        if (!plans.length) return runtimeText("No saved test plans yet. Save one with save_test_plan.");
        return runtimeText(`Saved plans:\n${plans.map((p) => `- ${p.name}`).join("\n")}`);
      },
    ),
    defineRuntimeTool(
      namespace,
      "ci_status",
      "Summarize GitHub CI status for a PR, branch or commit with the gh CLI (read-only), including the tail of failed job logs.",
      {
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("owner/name"),
        pr: z.number().int().positive().optional(),
        branch: z.string().regex(/^[\w][\w./-]*$/).optional(),
        commit: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
      },
      async (args) => {
        const result = await ciStatus(args, exec);
        return runtimeText(formatCheckResults([result]), result.status !== "error");
      },
    ),
    defineRuntimeTool(
      namespace,
      "run_repo_tests",
      "Run a repo's own test/check script from its package.json (e.g. test, test:e2e, lint, typecheck) in a local checkout inside the home folder, and summarize the result.",
      {
        cwd: z.string().min(1).describe("Path to the repo checkout, e.g. ~/Sites/my-app"),
        script: z.string().regex(/^[\w:.-]+$/).describe("package.json script name, e.g. test"),
        args: z.array(z.string().regex(/^[\w@./:=,-]+$/)).max(20).optional().describe("Extra args, e.g. a test file filter."),
        timeoutMinutes: z.number().int().positive().max(30).optional(),
      },
      async (args) => {
        const result = await runSuite(
          { cwd: args.cwd, script: args.script, ...(args.args ? { args: args.args } : {}) },
          { exec, ...(args.timeoutMinutes ? { timeoutMs: args.timeoutMinutes * 60_000 } : {}) },
        );
        return runtimeText(formatCheckResults([result]), result.status === "passed");
      },
    ),
    defineRuntimeTool(
      namespace,
      "webtest_setup",
      "Check whether headless browser testing works on this machine, and with install: true download Chromium for Patchright if it's missing. Also shows where sessions/plans live and how URLs are classified.",
      {
        install: z.boolean().optional().describe("Download the browser if it's missing (takes a minute or two)."),
        url: z.string().optional().describe("Optionally show whether this URL counts as production."),
      },
      async (args) => {
        const lines: string[] = [];
        let check = await checkHeadlessBrowser(deps.launch);
        if (!check.ok && args.install) {
          const withDeps = process.platform === "linux" && process.getuid?.() === 0;
          lines.push(`Installing Chromium${withDeps ? " and its system libraries" : ""}…`);
          const r = await exec(
            process.platform === "win32" ? "npx.cmd" : "npx",
            ["-y", "patchright", "install", ...(withDeps ? ["--with-deps"] : []), "chromium"],
            { timeoutMs: 10 * 60_000 },
          );
          const out = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-6).join("\n");
          lines.push(r.code === 0 ? "Install finished." : `Install failed (exit ${r.code ?? r.spawnError}).`, out);
          check = await checkHeadlessBrowser(deps.launch);
        }
        lines.push(check.ok ? `Ready: ${check.message}` : `Not ready: ${check.message}`);
        if (!check.ok && !args.install) lines.push("Call webtest_setup with install: true to download it.");
        if (!check.ok && process.platform === "linux") {
          lines.push("If it still fails on Linux, the owner needs to run once as root: sudo npx patchright install-deps chromium");
        }
        lines.push(`Sessions and plans: ${webtestDir(env)}`);
        if (args.url) {
          try {
            lines.push(`${args.url} counts as: ${classifyUrl(new URL(args.url).toString(), env)}`);
          } catch {
            lines.push(`${args.url} is not a valid URL.`);
          }
        }
        return runtimeText(lines.filter(Boolean).join("\n"), check.ok);
      },
    ),
  ];
}

export function createWebTestMcp() {
  return createClaudeMcpServer(WEBTEST_NAMESPACE, createWebTestTools({}, WEBTEST_NAMESPACE));
}

