import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requestsWebTesting, resolveSpawnIntegrations } from "../server/interaction-agent.js";
import { ciStatus, runSuite, summarizeTestOutput, type Exec } from "../server/webtest/checks.js";
import {
  BrowserUnavailableError,
  checkHeadlessBrowser,
  explainLaunchError,
  launchHeadlessChromium,
  type SessionOptions,
  type WebTestBrowser,
  type WebTestSession,
} from "../server/webtest/driver.js";
import { describeStep, parsePlan, planSecretNames, planSessionNames, type Target } from "../server/webtest/plan.js";
import { formatReport, runWebTestPlan, screenshotsToAttach, type RunOptions } from "../server/webtest/runner.js";
import { classifyUrl, destructiveReason, preflightPlan, resolvePlanUrl } from "../server/webtest/safety.js";
import { defaultCredentialSource, sessionPath, type CredentialSource } from "../server/webtest/storage.js";
import { createWebTestTools } from "../server/webtest/tools.js";

// --- a fake browser ------------------------------------------------------------

interface FakePage {
  text: string;
  title?: string;
  status?: number;
  visible?: string[];
  /** click target text/name → URL it navigates to */
  links?: Record<string, string>;
  /** Echo filled values into the page text (to prove the report redacts them). */
  echoFills?: boolean;
  console?: string[];
  redirect?: string;
}

function targetKey(t: Target): string {
  return t.name ?? t.text ?? t.label ?? t.placeholder ?? t.testId ?? t.selector ?? "";
}

class FakeSession implements WebTestSession {
  current = "about:blank";
  filled: Record<string, string> = {};
  pending: { console: string[]; network: string[] } = { console: [], network: [] };
  constructor(
    private readonly site: Record<string, FakePage>,
    readonly opts: SessionOptions,
    private readonly log: FakeBrowser,
    private readonly requests: Record<string, { status: number; body: string }>,
  ) {}
  private page(): FakePage {
    return this.site[this.current] ?? { text: "", status: 404 };
  }
  async goto(url: string) {
    this.current = this.site[url]?.redirect ?? url;
    const page = this.page();
    this.pending.console.push(...(page.console ?? []));
    return { status: page.status ?? 200 };
  }
  async click(t: Target) {
    const dest = this.page().links?.[targetKey(t)];
    if (!dest) throw new Error(`locator.click: Timeout exceeded waiting for ${targetKey(t)}\nCall log:\n  - waiting`);
    this.log.clicks.push(targetKey(t));
    this.current = dest;
    this.pending.console.push(...(this.page().console ?? []));
  }
  async hover() {}
  async fill(t: Target, value: string) {
    this.filled[targetKey(t)] = value;
    this.log.fills.push(value);
    const page = this.page();
    if (page.echoFills) page.text += ` ${value}`;
  }
  async select() {}
  async setChecked() {}
  async press() {}
  async readText(t: Target | undefined) {
    return t ? (this.page().visible?.includes(targetKey(t)) ? targetKey(t) : "") : this.page().text;
  }
  async isVisible(t: Target) {
    return this.page().visible?.includes(targetKey(t)) ?? false;
  }
  url() {
    return this.current;
  }
  async title() {
    return this.page().title ?? "";
  }
  async request(url: string, opts: { method: string; headers?: Record<string, string> }) {
    this.log.requests.push({ url, method: opts.method, headers: opts.headers ?? {} });
    return this.requests[`${opts.method} ${url}`] ?? { status: 404, body: "not found" };
  }
  async screenshot(file: string) {
    writeFileSync(file, "png");
    this.log.screenshots.push(file);
  }
  async saveStorageState(file: string) {
    writeFileSync(file, JSON.stringify({ cookies: [{ name: "sid", value: "abc" }], origins: [] }));
  }
  drainEvents() {
    const out = this.pending;
    this.pending = { console: [], network: [] };
    return out;
  }
  async close() {
    this.log.closed++;
  }
}

class FakeBrowser implements WebTestBrowser {
  clicks: string[] = [];
  fills: string[] = [];
  screenshots: string[] = [];
  requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  sessions: FakeSession[] = [];
  closed = 0;
  browserClosed = false;
  constructor(
    private readonly site: Record<string, FakePage>,
    private readonly apis: Record<string, { status: number; body: string }> = {},
  ) {}
  async newSession(opts: SessionOptions) {
    const s = new FakeSession(this.site, opts, this, this.apis);
    this.sessions.push(s);
    return s;
  }
  async close() {
    this.browserClosed = true;
  }
}

const STAGING = "https://staging.example.com";

function staticCredentials(values: Record<string, string>): CredentialSource {
  return {
    async getMany(names) {
      const out: Record<string, string> = {};
      const missing: string[] = [];
      for (const n of names) (values[n] ? (out[n] = values[n]) : missing.push(n));
      return { values: out, missing };
    },
    missingHint: (names) => `Missing test credentials: ${names.join(", ")}.`,
  };
}

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "boop-webtest-test-"));
  env = { BOOP_WEBTEST_DIR: path.join(dir, "store") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function opts(browser: WebTestBrowser, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    env,
    launch: async () => browser,
    credentials: staticCredentials({}),
    screenshotRoot: path.join(dir, "shots"),
    ...extra,
  };
}

// --- plans ---------------------------------------------------------------------

describe("parsePlan", () => {
  it("parses a YAML plan with scenarios and step shorthands", () => {
    const plan = parsePlan(`
name: Upgrade flow
baseUrl: ${STAGING}
session: monthly-user
scenarios:
  - name: Lifetime offer
    steps:
      - goto: /account
      - click: { role: button, name: Upgrade }
      - fill: { label: Password, secret: WEBTEST_PASSWORD }
      - expectText: Lifetime
      - expectText: { text: Error, absent: true }
      - check: "#terms"
  - name: Guest gets 409
    session: null
    steps:
      - request: { method: post, url: /api/upgrade, status: 409 }
        name: guest is rejected
`);
    expect(plan.name).toBe("Upgrade flow");
    expect(plan.screenshots).toBe("each");
    expect(plan.scenarios).toHaveLength(2);
    expect(plan.scenarios[0].steps[1]).toEqual({ action: "click", target: { role: "button", name: "Upgrade" } });
    expect(plan.scenarios[0].steps[2]).toEqual({ action: "fill", target: { label: "Password" }, secret: "WEBTEST_PASSWORD" });
    expect(plan.scenarios[0].steps[4]).toEqual({ action: "expectText", text: "Error", absent: true });
    expect(plan.scenarios[0].steps[5]).toEqual({ action: "check", target: { selector: "#terms" }, checked: true });
    expect(plan.scenarios[1].session).toBeNull();
    expect(plan.scenarios[1].steps[0]).toMatchObject({ action: "request", method: "POST", status: [409], name: "guest is rejected" });
    expect(planSecretNames(plan)).toEqual(["WEBTEST_PASSWORD"]);
    expect(planSessionNames(plan)).toEqual(["monthly-user"]);
  });

  it("accepts JSON text and objects with top-level steps", () => {
    const plan = parsePlan(JSON.stringify({ baseUrl: STAGING, steps: [{ goto: "/privacy" }, { expectText: "Privacy" }] }));
    expect(plan.scenarios).toHaveLength(1);
    expect(plan.scenarios[0].steps).toHaveLength(2);
  });

  it("rejects malformed steps with a readable message", () => {
    expect(() => parsePlan({ steps: [{ goto: "/a", click: "b" }] })).toThrow(/exactly one action/);
    expect(() => parsePlan({ steps: [{ teleport: "/a" }] })).toThrow(/unknown action "teleport"/);
    expect(() => parsePlan({ steps: [{ fill: { label: "Email", value: "a", secret: "WEBTEST_X" } }] })).toThrow(/exactly one of value or secret/);
    expect(() => parsePlan({ steps: [{ fill: { label: "Password", secret: "my password" } }] })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => parsePlan({ steps: [{ goto: "/" }], scenarios: [{ name: "x", steps: [{ goto: "/" }] }] })).toThrow(/either steps or scenarios/);
    expect(() => parsePlan("steps: [ goto")).toThrow(/Couldn't parse/);
  });

  it("describes steps without secret values", () => {
    const plan = parsePlan({ steps: [{ fill: { label: "Password", secret: "WEBTEST_PASSWORD" } }] });
    expect(describeStep(plan.scenarios[0].steps[0])).toBe('fill field "Password" with [secret WEBTEST_PASSWORD]');
  });
});

// --- safety --------------------------------------------------------------------

describe("safety", () => {
  it("classifies URLs, defaulting unknown hosts to production", () => {
    expect(classifyUrl("https://staging.shop-example.com/x", {})).toBe("non-production");
    expect(classifyUrl("https://app-preview.example.com", {})).toBe("non-production");
    expect(classifyUrl("https://shop-example.com", {})).toBe("production");
    expect(classifyUrl("https://example.dev", {})).toBe("production");
    expect(classifyUrl("http://localhost:3000", {})).toBe("local");
    expect(classifyUrl("http://192.168.1.4", {})).toBe("local");
    expect(classifyUrl("https://qa.example.com", { BOOP_WEBTEST_PRODUCTION_HOSTS: "qa.example.com" })).toBe("production");
    expect(classifyUrl("https://review.example.com", { BOOP_WEBTEST_NONPROD_HOSTS: "example.com" })).toBe("non-production");
    expect(classifyUrl("not a url", {})).toBe("production");
  });

  it("flags destructive steps", () => {
    const steps = parsePlan({
      steps: [
        { goto: "/" },
        { click: { role: "button", name: "Delete account" } },
        { click: { text: "Learn more" } },
        { click: "button.buy-now" },
        { fill: { selector: "#card-number", value: "4242" } },
        { request: { method: "DELETE", url: "/api/me" } },
        { request: { url: "/api/me" } },
        { click: "#harmless", destructive: true },
      ],
    }).scenarios[0].steps;
    expect(steps.map((s) => destructiveReason(s) !== null)).toEqual([false, true, false, true, true, true, false, true]);
  });

  it("resolves relative URLs against the base URL", () => {
    expect(resolvePlanUrl("/a?b=1", STAGING)).toBe(`${STAGING}/a?b=1`);
    expect(resolvePlanUrl("https://other.test/x", STAGING)).toBe("https://other.test/x");
    expect(() => resolvePlanUrl("/a", undefined)).toThrow(/no baseUrl/);
    expect(() => resolvePlanUrl("javascript:alert(1)", STAGING)).toThrow(/http/);
  });

  it("refuses destructive steps on production unless confirmed", () => {
    const plan = parsePlan({ baseUrl: "https://example.com", steps: [{ goto: "/" }, { click: { text: "Delete account" } }] });
    const refused = preflightPlan(plan, { env: {} });
    expect(refused.ok).toBe(false);
    expect(refused.environment).toBe("production");
    expect(refused.refusal).toMatch(/Refused: this plan targets production \(example.com\)/);
    expect(preflightPlan(plan, { env: {}, confirmProductionDestructive: true }).ok).toBe(true);
    const staging = parsePlan({ baseUrl: STAGING, steps: [{ goto: "/" }, { click: { text: "Delete account" } }] });
    expect(preflightPlan(staging, { env: {} }).ok).toBe(true);
  });

  it("allows read-only checks on production and uses the default base URL", () => {
    const plan = parsePlan({ steps: [{ goto: "/privacy" }, { expectText: "Privacy" }] });
    expect(preflightPlan(plan, { env: {} }).ok).toBe(false);
    const withDefault = preflightPlan(plan, { env: { BOOP_WEBTEST_DEFAULT_BASE_URL: "https://example.com" } });
    expect(withDefault).toMatchObject({ ok: true, environment: "production", hosts: ["example.com"] });
  });
});

// --- runner --------------------------------------------------------------------

describe("runWebTestPlan", () => {
  const site: Record<string, FakePage> = {
    [`${STAGING}/login`]: { text: "Log in", links: { "Log in": `${STAGING}/account` }, visible: ["Email"] },
    [`${STAGING}/account`]: { text: "Your plan: Monthly. Upgrade to Lifetime", title: "Account", links: { Upgrade: `${STAGING}/upgrade` } },
    [`${STAGING}/upgrade`]: { text: "Lifetime offer", console: ["TypeError: x is undefined"] },
  };

  it("runs a passing plan with a screenshot per step and real secret values in the browser", async () => {
    const browser = new FakeBrowser(site);
    const plan = parsePlan({
      baseUrl: STAGING,
      scenarios: [
        {
          name: "Login and upgrade",
          steps: [
            { goto: "/login" },
            { fill: { label: "Email", value: "tester@example.com" } },
            { fill: { label: "Password", secret: "WEBTEST_PASSWORD" } },
            { click: { role: "button", name: "Log in" } },
            { expectUrl: "/account" },
            { expectTitle: "account" },
            { expectText: "upgrade to   lifetime" },
            { click: { text: "Upgrade" } },
            { expectText: "Lifetime offer" },
          ],
        },
      ],
    });
    const report = await runWebTestPlan(plan, opts(browser, { credentials: staticCredentials({ WEBTEST_PASSWORD: "hunter2-very-secret" }) }));
    expect(report.status).toBe("passed");
    expect(report.environment).toBe("non-production");
    expect(report.scenarios[0].steps.every((s) => s.status === "passed")).toBe(true);
    expect(report.screenshots).toHaveLength(9);
    expect(report.screenshots.every((s) => existsSync(s.path))).toBe(true);
    expect(browser.fills).toContain("hunter2-very-secret");
    expect(report.scenarios[0].steps[7].console).toEqual(["TypeError: x is undefined"]);
    expect(browser.browserClosed).toBe(true);
    const text = formatReport(report);
    expect(text).toMatch(/Web test "Login and upgrade": PASSED — 1\/1 scenarios passed/);
    expect(text).toMatch(/Console errors: TypeError/);
    expect(JSON.stringify(report)).not.toContain("hunter2-very-secret");
    const saved = readFileSync(path.join(report.runDir!, "report.json"), "utf8");
    expect(saved).not.toContain("hunter2-very-secret");
  });

  it("stops a scenario at the first failure, screenshots it and keeps going with the next scenario", async () => {
    const browser = new FakeBrowser(site);
    const plan = parsePlan({
      baseUrl: STAGING,
      screenshots: "failures",
      timeoutMs: 300,
      scenarios: [
        { name: "Broken", steps: [{ goto: "/account" }, { expectText: "Black Friday" }, { click: { text: "Upgrade" } }] },
        { name: "Fine", steps: [{ goto: "/account" }, { expectText: "Monthly" }] },
      ],
    });
    const report = await runWebTestPlan(plan, opts(browser));
    expect(report.status).toBe("failed");
    const [broken, fine] = report.scenarios;
    expect(broken.status).toBe("failed");
    expect(broken.steps.map((s) => s.status)).toEqual(["passed", "failed", "skipped"]);
    expect(broken.steps[1].error).toMatch(/"Black Friday" not found .* Visible text starts: "Your plan: Monthly/);
    expect(broken.steps[1].screenshot).toBeDefined();
    expect(fine.status).toBe("passed");
    expect(report.screenshots).toHaveLength(1);
    expect(screenshotsToAttach(report)[0].failed).toBe(true);
    expect(formatReport(report)).toMatch(/✗ 2\. page shows "Black Friday"/);
  });

  it("redacts secrets the page echoes back into failure messages", async () => {
    const browser = new FakeBrowser({ [`${STAGING}/echo`]: { text: "You typed:", echoFills: true } });
    const plan = parsePlan({
      baseUrl: STAGING,
      timeoutMs: 200,
      steps: [{ goto: "/echo" }, { fill: { label: "Password", secret: "WEBTEST_PASSWORD" } }, { expectText: "Welcome" }],
    });
    const report = await runWebTestPlan(plan, opts(browser, { credentials: staticCredentials({ WEBTEST_PASSWORD: "s3cr3t-value-123" }) }));
    expect(report.status).toBe("failed");
    const text = formatReport(report);
    expect(text).toContain("[REDACTED:WEBTEST_PASSWORD]");
    expect(text).not.toContain("s3cr3t-value-123");
  });

  it("checks API status codes and sends secret headers", async () => {
    const browser = new FakeBrowser(site, {
      [`POST ${STAGING}/api/upgrade`]: { status: 409, body: '{"error":"guest"}' },
      [`GET ${STAGING}/api/me`]: { status: 200, body: '{"plan":"monthly"}' },
    });
    const plan = parsePlan({
      baseUrl: STAGING,
      stopOnFailure: false,
      steps: [
        { request: { method: "POST", url: "/api/upgrade", status: 409 } },
        { request: { url: "/api/me", bodyContains: "monthly", secretHeaders: { Authorization: "WEBTEST_TOKEN" } } },
        { request: { method: "POST", url: "/api/upgrade", status: 200 } },
      ],
    });
    const report = await runWebTestPlan(plan, opts(browser, { credentials: staticCredentials({ WEBTEST_TOKEN: "Bearer tok-123456" }) }));
    expect(report.scenarios[0].steps.map((s) => s.status)).toEqual(["passed", "passed", "failed"]);
    expect(report.scenarios[0].steps[2].error).toMatch(/Expected HTTP 200, got 409/);
    expect(browser.requests[1].headers.Authorization).toBe("Bearer tok-123456");
  });

  it("refuses before launching when production has destructive steps", async () => {
    let launched = false;
    const plan = parsePlan({ baseUrl: "https://example.com", steps: [{ goto: "/" }, { click: { text: "Pay now" } }] });
    const report = await runWebTestPlan(plan, opts(new FakeBrowser({}), { launch: async () => ((launched = true), new FakeBrowser({})) }));
    expect(report.status).toBe("refused");
    expect(launched).toBe(false);
    expect(formatReport(report)).toMatch(/REFUSED[\s\S]*Pay now/);
  });

  it("refuses a destructive step at run time when a staging page redirected to production", async () => {
    const browser = new FakeBrowser({
      [`${STAGING}/billing`]: { text: "", redirect: "https://example.com/billing" },
      "https://example.com/billing": { text: "Billing", links: { "Cancel subscription": "https://example.com/cancelled" } },
    });
    const plan = parsePlan({ baseUrl: STAGING, steps: [{ goto: "/billing" }, { click: { text: "Cancel subscription" } }] });
    const report = await runWebTestPlan(plan, opts(browser));
    expect(report.status).toBe("refused");
    expect(report.scenarios[0].steps[1]).toMatchObject({ status: "refused" });
    expect(report.scenarios[0].steps[1].error).toMatch(/Refused on production \(example.com\)/);
    expect(browser.clicks).toEqual([]);
  });

  it("reports missing credentials by name without launching", async () => {
    const plan = parsePlan({ baseUrl: STAGING, steps: [{ goto: "/login" }, { fill: { label: "Password", secret: "WEBTEST_MISSING" } }] });
    let launched = false;
    const report = await runWebTestPlan(plan, opts(new FakeBrowser({}), { launch: async () => ((launched = true), new FakeBrowser({})) }));
    expect(report.status).toBe("error");
    expect(report.message).toMatch(/WEBTEST_MISSING/);
    expect(launched).toBe(false);
  });

  it("requires saved sessions to exist and loads them into the browser", async () => {
    const plan = parsePlan({ baseUrl: STAGING, session: "monthly", steps: [{ goto: "/account" }] });
    const missing = await runWebTestPlan(plan, opts(new FakeBrowser(site)));
    expect(missing.status).toBe("error");
    expect(missing.message).toMatch(/Saved session "monthly" doesn't exist/);

    const file = sessionPath("monthly", env);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}");
    const browser = new FakeBrowser(site);
    const ok = await runWebTestPlan(plan, opts(browser));
    expect(ok.status).toBe("passed");
    expect(browser.sessions[0].opts.storageStatePath).toBe(file);
  });

  it("saves a session after a passing login plan", async () => {
    const plan = parsePlan({ baseUrl: STAGING, steps: [{ goto: "/login" }, { click: { text: "Log in" } }, { expectUrl: "/account" }] });
    const report = await runWebTestPlan(plan, opts(new FakeBrowser(site), { saveSessionAs: "staging-user" }));
    expect(report.savedSession).toBe("staging-user");
    expect(existsSync(sessionPath("staging-user", env))).toBe(true);
  });

  it("degrades with setup steps when the browser isn't installed, but still runs repo checks", async () => {
    const plan = parsePlan({
      baseUrl: STAGING,
      steps: [{ goto: "/" }],
      checks: { ci: [{ repo: "acme/app", pr: 7 }] },
    });
    const report = await runWebTestPlan(
      plan,
      opts(new FakeBrowser({}), {
        launch: async () => {
          throw new BrowserUnavailableError(explainLaunchError(new Error("browserType.launch: Executable doesn't exist at /x/chrome")));
        },
        runCi: async () => ({ label: "CI acme/app PR #7", status: "passed", summary: "3 passed", details: [] }),
      }),
    );
    expect(report.status).toBe("unavailable");
    const text = formatReport(report);
    expect(text).toMatch(/Headless Chromium isn't installed/);
    expect(text).toMatch(/npm run webtest:install/);
    expect(text).toMatch(/✅ CI acme\/app PR #7: 3 passed/);
  });
});

// --- credentials -----------------------------------------------------------------

describe("defaultCredentialSource", () => {
  it("on the server reads only WEBTEST_* environment variables", async () => {
    const source = defaultCredentialSource({
      platform: "linux",
      env: { WEBTEST_PASSWORD: "pw-1234", ANTHROPIC_API_KEY: "sk-nope" },
    });
    expect(await source.getMany(["WEBTEST_PASSWORD", "ANTHROPIC_API_KEY"])).toEqual({
      values: { WEBTEST_PASSWORD: "pw-1234" },
      missing: ["ANTHROPIC_API_KEY"],
    });
    expect(source.missingHint(["ANTHROPIC_API_KEY"])).toMatch(/WEBTEST_\*/);
  });

  it("on the Mac reads the secret store first, then WEBTEST_* env", async () => {
    const store = {
      getMany: async (names: string[]) => ({
        values: names.includes("SITE_PASSWORD") ? { SITE_PASSWORD: "from-keychain" } : {},
        missing: names.filter((n) => n !== "SITE_PASSWORD"),
      }),
    };
    const source = defaultCredentialSource({
      platform: "darwin",
      env: { WEBTEST_EMAIL: "qa@example.com" },
      store: () => store as never,
    });
    expect(await source.getMany(["SITE_PASSWORD", "WEBTEST_EMAIL", "OTHER"])).toEqual({
      values: { SITE_PASSWORD: "from-keychain", WEBTEST_EMAIL: "qa@example.com" },
      missing: ["OTHER"],
    });
    expect(source.missingHint(["OTHER"])).toMatch(/request_secret/);
  });
});

// --- repo checks -------------------------------------------------------------------

describe("repo checks", () => {
  it("summarizes PR checks from gh", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      return {
        code: 1,
        timedOut: false,
        stderr: "",
        stdout: JSON.stringify([
          { name: "unit", bucket: "pass", workflow: "CI" },
          { name: "e2e", bucket: "fail", workflow: "CI", link: "https://github.com/acme/app/actions/runs/1" },
          { name: "deploy", bucket: "pending" },
        ]),
      };
    };
    const r = await ciStatus({ repo: "acme/app", pr: 12 }, exec);
    expect(calls[0]).toEqual(["gh", "pr", "checks", "12", "--repo", "acme/app", "--json", "name,state,bucket,link,workflow"]);
    expect(r.status).toBe("failed");
    expect(r.summary).toBe("1 passed, 1 failed, 1 pending (3 checks).");
    expect(r.details[0]).toMatch(/✗ CI \/ e2e https:/);
  });

  it("summarizes the latest runs for a branch and pulls failed logs", async () => {
    const exec: Exec = async (_file, args) => {
      if (args[1] === "list") {
        return {
          code: 0,
          timedOut: false,
          stderr: "",
          stdout: JSON.stringify([
            { databaseId: 2, workflowName: "CI", status: "completed", conclusion: "failure", headSha: "abc1234def" },
            { databaseId: 3, workflowName: "Lint", status: "completed", conclusion: "success", headSha: "abc1234def" },
            { databaseId: 1, workflowName: "CI", status: "completed", conclusion: "success", headSha: "0000000" },
          ]),
        };
      }
      return { code: 0, timedOut: false, stderr: "", stdout: "test\tstep\tFAIL src/a.test.ts\n" };
    };
    const r = await ciStatus({ repo: "acme/app", branch: "main" }, exec);
    expect(r.status).toBe("failed");
    expect(r.summary).toMatch(/1 passed, 1 failed, 0 running \(commit abc1234\)/);
    expect(r.details.join("\n")).toMatch(/FAIL src\/a.test.ts/);
  });

  it("explains when gh is missing", async () => {
    const exec: Exec = async () => ({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: "ENOENT" });
    const r = await ciStatus({ repo: "acme/app", pr: 1 }, exec);
    expect(r.status).toBe("error");
    expect(r.summary).toMatch(/GitHub CLI \(gh\) isn't installed/);
  });

  it("runs only test-like package.json scripts inside the home folder", async () => {
    const home = path.join(dir, "home");
    const repo = path.join(home, "app");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run", deploy: "x" } }));
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "");
    const calls: { file: string; args: string[]; cwd?: string }[] = [];
    const exec: Exec = async (file, args, o) => {
      calls.push({ file, args, cwd: o.cwd });
      return { code: 1, timedOut: false, stderr: "", stdout: " FAIL  src/a.test.ts\n Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed (42)\n" };
    };
    const r = await runSuite({ cwd: "~/app", script: "test", args: ["src/a.test.ts"] }, { exec, home });
    expect(calls[0].file).toBe("pnpm");
    expect(calls[0].args).toEqual(["run", "test", "src/a.test.ts"]);
    expect(r.status).toBe("failed");
    expect(r.details.join("\n")).toMatch(/Tests {2}2 failed \| 40 passed/);

    expect((await runSuite({ cwd: "~/app", script: "deploy" }, { exec, home })).summary).toMatch(/doesn't look like a test/);
    expect((await runSuite({ cwd: "~/app", script: "e2e" }, { exec, home })).summary).toMatch(/no "e2e" script/);
    expect((await runSuite({ cwd: dir, script: "test" }, { exec, home })).summary).toMatch(/inside the home folder/);
    expect(calls).toHaveLength(1);
  });

  it("picks result lines out of test output", () => {
    expect(summarizeTestOutput("noise\n  ✓ a\n  1 passed (2s)\nmore\n")).toEqual(["  1 passed (2s)"]);
  });
});

// --- tools and routing --------------------------------------------------------------

describe("webtest tools", () => {
  function tool(name: string, browser: WebTestBrowser = new FakeBrowser({})) {
    const t = createWebTestTools({
      env,
      launch: async () => browser,
      runOptions: { credentials: staticCredentials({}), screenshotRoot: path.join(dir, "shots") },
    }).find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }

  it("saves and re-runs a plan by name", async () => {
    const browser = new FakeBrowser({ [`${STAGING}/privacy`]: { text: "Privacy policy. We never sell your data." } });
    const plan = `name: Privacy copy\nbaseUrl: ${STAGING}\nsteps:\n  - goto: /privacy\n  - expectText: never sell your data\n`;
    const saved = await tool("save_test_plan").handle({ name: "privacy", plan });
    expect(saved.success).toBe(true);
    const listed = await tool("list_test_plans").handle({});
    expect(listed.text).toMatch(/- privacy/);
    const run = await tool("run_browser_test", browser).handle({ planName: "privacy" });
    expect(run.success).toBe(true);
    expect(run.text).toMatch(/PASSED/);
  });

  it("won't save a plan with a credential in it", async () => {
    const r = await tool("save_test_plan").handle({
      name: "bad",
      plan: `baseUrl: ${STAGING}\nsteps:\n  - goto: /login\n  - fill: { label: Password, value: "password: hunter22" }\n`,
    });
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/looks like it contains a credential/);
  });

  it("browser_check asserts texts on one page", async () => {
    const browser = new FakeBrowser({ [`${STAGING}/privacy`]: { text: "Privacy policy" } });
    const r = await tool("browser_check", browser).handle({ url: `${STAGING}/privacy`, expectTexts: ["Privacy"], absentTexts: ["Lorem ipsum"] });
    expect(r.success).toBe(true);
    expect(r.text).toMatch(/Screenshots to attach/);
  });

  it("webtest_setup reports a missing browser with the install steps", async () => {
    const t = createWebTestTools({
      env,
      launch: async () => {
        throw new BrowserUnavailableError("Headless Chromium isn't installed on this machine.");
      },
    }).find((x) => x.name === "webtest_setup")!;
    const r = await t.handle({ url: "https://staging.example.com" });
    expect(r.success).toBe(false);
    expect(r.text).toMatch(/Not ready: Headless Chromium isn't installed/);
    expect(r.text).toMatch(/install: true/);
    expect(r.text).toMatch(/counts as: non-production/);
  });

  it("routes testing requests to webtest instead of the local browser", () => {
    expect(requestsWebTesting("Can you test the staging site checkout flow?")).toBe(true);
    expect(requestsWebTesting("Run an e2e check on the shop staging")).toBe(true);
    expect(requestsWebTesting("What's on my calendar?")).toBe(false);
    expect(resolveSpawnIntegrations([], ["webtest", "browser"], "Use Patchright headless to QA the staging signup")).toEqual(["webtest"]);
    expect(resolveSpawnIntegrations(["gmail"], ["gmail", "browser"], "Use a local browser to read reddit")).toEqual(["browser"]);
  });
});

// --- the real headless browser (skipped when Chromium isn't installed here) ---------

describe("headless Chromium (real browser)", async () => {
  const available = (await checkHeadlessBrowser()).ok;
  let server: Server;
  let base = "";
  beforeAll(async () => {
    if (!available) return;
    server = createServer((req, res) => {
      if (req.url === "/api/upgrade" && req.method === "POST") {
        res.writeHead(409, { "content-type": "application/json" }).end('{"error":"guest"}');
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Pricing</title>
        <h1>Plans</h1><label>Email <input id="email"></label>
        <button onclick="document.getElementById('out').textContent='Lifetime offer for '+document.getElementById('email').value; console.error('boom')">Upgrade</button>
        <p id="out"></p>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(() => server?.close());

  it.skipIf(!available)("runs a plan end to end", async () => {
    const plan = parsePlan({
      baseUrl: base,
      steps: [
        { goto: "/" },
        { expectTitle: "Pricing" },
        { fill: { label: "Email", value: "qa@example.com" } },
        { click: { role: "button", name: "Upgrade" } },
        { expectText: { text: "Lifetime offer for qa@example.com", in: "#out" } },
        { request: { method: "POST", url: "/api/upgrade", status: 409 } },
      ],
    });
    const report = await runWebTestPlan(plan, {
      env,
      launch: () => launchHeadlessChromium(env),
      credentials: staticCredentials({}),
      screenshotRoot: path.join(dir, "shots"),
    });
    expect(formatReport(report)).toMatch(/PASSED/);
    expect(report.environment).toBe("local");
    expect(report.screenshots).toHaveLength(6);
    expect(readFileSync(report.screenshots[0].path).subarray(1, 4).toString()).toBe("PNG");
    expect(report.scenarios[0].steps[3].console.join(" ")).toMatch(/boom/);
  }, 60_000);
});
