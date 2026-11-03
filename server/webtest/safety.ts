import { isIP } from "node:net";
import { describeStep, describeTarget, type Step, type WebTestPlan } from "./plan.js";

/**
 * Safety rules for the web test runner.
 *
 * - URLs are classified as local, non-production (staging, preview, …) or
 *   production. Anything we can't tell is production: the safe default.
 * - Steps that pay, buy, delete, cancel or send a non-GET request are
 *   destructive. On production they are refused unless the run was explicitly
 *   confirmed by the owner.
 *
 * Owners can tune the classification with env vars (comma-separated hosts,
 * suffix match): BOOP_WEBTEST_NONPROD_HOSTS and BOOP_WEBTEST_PRODUCTION_HOSTS.
 */

export type UrlEnvironment = "local" | "non-production" | "production";

const NON_PROD_LABELS = new Set([
  "staging",
  "stage",
  "stg",
  "dev",
  "develop",
  "development",
  "preview",
  "qa",
  "test",
  "testing",
  "sandbox",
  "uat",
  "acceptance",
  "local",
]);

const LOCAL_SUFFIXES = [".localhost", ".local", ".test", ".internal", ".lan"];

function hostList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^\*?\./, ""))
    .filter(Boolean);
}

function hostMatches(host: string, list: string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function isPrivateIp(host: string): boolean {
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) return host === "::1" || /^f[cd]/i.test(host);
  return false;
}

export function classifyUrl(url: string, env: NodeJS.ProcessEnv = process.env): UrlEnvironment {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "production";
  }
  if (!host) return "production";
  if (hostMatches(host, hostList(env.BOOP_WEBTEST_PRODUCTION_HOSTS))) return "production";
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || isPrivateIp(host)) {
    return "local";
  }
  if (hostMatches(host, hostList(env.BOOP_WEBTEST_NONPROD_HOSTS))) return "non-production";
  const labels = host.split(/[.-]/);
  // The last label is the TLD; ".dev" is a real production TLD.
  if (labels.slice(0, -1).some((label) => NON_PROD_LABELS.has(label))) return "non-production";
  return "production";
}

const DESTRUCTIVE_WORDS =
  /\b(delete|remove|destroy|erase|wipe|deactivate|terminate|close (?:my |your |the )?account|cancel(?:lation)? (?:my |your |the )?(?:subscription|plan|membership)|unsubscribe|pay|pay now|purchase|buy|checkout|check out|place (?:the )?order|order now|subscribe|upgrade|downgrade|confirm (?:payment|purchase|order|deletion)|refund|charge|complete (?:purchase|order|payment)|transfer|withdraw|send money|donate)\b/i;

const PAYMENT_FIELD = /card|cc-?(number|num|exp|csc)|cvc|cvv|iban|expir/i;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function targetText(step: Step): string {
  if (!("target" in step) || !step.target) return "";
  const t = step.target;
  return [t.selector, t.text, t.name, t.label, t.placeholder, t.testId, describeTarget(t)]
    .filter(Boolean)
    .join(" ");
}

/** Why a step counts as destructive, or null when it doesn't. */
export function destructiveReason(step: Step): string | null {
  if (step.destructive) return "marked destructive";
  switch (step.action) {
    case "click":
    case "check":
    case "select":
    case "press": {
      const text = `${targetText(step)} ${step.name ?? ""}`;
      const m = text.match(DESTRUCTIVE_WORDS);
      if (m) return `looks like a "${m[0].toLowerCase()}" action`;
      return null;
    }
    case "fill": {
      const text = targetText(step);
      if (PAYMENT_FIELD.test(text)) return "fills a payment field";
      return null;
    }
    case "request":
      return SAFE_METHODS.has(step.method) ? null : `sends a ${step.method} request`;
    default:
      return null;
  }
}

/** Resolves a plan URL against the base URL (or BOOP_WEBTEST_DEFAULT_BASE_URL). */
export function resolvePlanUrl(url: string, baseUrl: string | undefined): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).toString();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) throw new Error(`Only http(s) URLs can be tested (got ${trimmed}).`);
  if (!baseUrl) {
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(trimmed)) return new URL(`https://${trimmed}`).toString();
    throw new Error(
      `"${trimmed}" is a relative URL but the plan has no baseUrl (and BOOP_WEBTEST_DEFAULT_BASE_URL is not set).`,
    );
  }
  const base = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  return new URL(trimmed, base.endsWith("/") ? base : `${base}/`).toString();
}

export function effectiveBaseUrl(plan: WebTestPlan, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return plan.baseUrl ?? (env.BOOP_WEBTEST_DEFAULT_BASE_URL?.trim() || undefined);
}

export interface PreflightIssue {
  scenario: string;
  step: number;
  description: string;
  reason: string;
}

export interface PreflightResult {
  ok: boolean;
  /** The worst environment any URL in the plan points at. */
  environment: UrlEnvironment;
  hosts: string[];
  /** Destructive steps found anywhere in the plan. */
  destructive: PreflightIssue[];
  /** Set when the run must not start. */
  refusal?: string;
  errors: string[];
}

const RANK: Record<UrlEnvironment, number> = { local: 0, "non-production": 1, production: 2 };

/**
 * Checks a plan before anything is launched: every URL resolves, and a plan
 * that touches production has no destructive steps unless confirmed.
 */
export function preflightPlan(
  plan: WebTestPlan,
  opts: { confirmProductionDestructive?: boolean; env?: NodeJS.ProcessEnv } = {},
): PreflightResult {
  const env = opts.env ?? process.env;
  const base = effectiveBaseUrl(plan, env);
  const errors: string[] = [];
  const hosts = new Set<string>();
  let environment = "local" as UrlEnvironment;
  const note = (url: string) => {
    const e = classifyUrl(url, env);
    if (RANK[e] > RANK[environment]) environment = e;
    hosts.add(new URL(url).host);
  };
  if (base) {
    try {
      note(resolvePlanUrl("/", base));
    } catch (err) {
      errors.push(`baseUrl: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const destructive: PreflightIssue[] = [];
  let sawUrl = Boolean(base);
  for (const scenario of plan.scenarios) {
    scenario.steps.forEach((step, i) => {
      if (step.action === "goto" || step.action === "request") {
        try {
          note(resolvePlanUrl(step.url, base));
          sawUrl = true;
        } catch (err) {
          errors.push(`"${scenario.name}" step ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const reason = destructiveReason(step);
      if (reason) destructive.push({ scenario: scenario.name, step: i + 1, description: describeStep(step), reason });
    });
    if (scenario.steps[0] && scenario.steps[0].action !== "goto" && scenario.steps[0].action !== "request" && !base) {
      errors.push(`"${scenario.name}" doesn't start with a goto step and the plan has no baseUrl.`);
    }
  }
  if (!sawUrl && plan.scenarios.length > 0) errors.push("The plan never opens a URL.");
  if (errors.length > 0) {
    return { ok: false, environment, hosts: [...hosts], destructive, errors, refusal: errors.join("\n") };
  }
  if (environment === "production" && destructive.length > 0 && !opts.confirmProductionDestructive) {
    const list = destructive
      .map((d) => `- "${d.scenario}" step ${d.step}: ${d.description} (${d.reason})`)
      .join("\n");
    return {
      ok: false,
      environment,
      hosts: [...hosts],
      destructive,
      errors,
      refusal: [
        `Refused: this plan targets production (${[...hosts].join(", ")}) and has destructive steps:`,
        list,
        "Run it against staging instead, or, only if the owner explicitly confirmed these exact production actions in this conversation, call again with confirmProductionDestructive: true.",
      ].join("\n"),
    };
  }
  return { ok: true, environment, hosts: [...hosts], destructive, errors };
}
