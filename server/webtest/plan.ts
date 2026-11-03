import yaml from "js-yaml";
import { z } from "zod";

/**
 * Test plans for the headless web test runner.
 *
 * A plan is a small JSON or YAML document: a base URL, optional saved session,
 * and one or more scenarios, each a list of steps. Every step is an object with
 * exactly one action key plus optional common fields, e.g.
 *
 *   - goto: /pricing
 *   - click: { role: button, name: Upgrade }
 *   - fill: { label: Password, secret: WEBTEST_VS_PASSWORD }
 *   - expectText: Lifetime
 *   - request: { method: POST, url: /api/upgrade, status: 409 }
 *     name: guest gets 409
 *
 * parsePlan() validates and normalizes this into the WebTestPlan shape the
 * runner executes. Plain-language scenarios are turned into steps by the
 * sub-agent before it calls the runner.
 */

export const SECRET_REF_RE = /^[A-Z][A-Z0-9_]*$/;
export const SESSION_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const DEFAULT_STEP_TIMEOUT_MS = 15_000;
export const MAX_STEP_TIMEOUT_MS = 120_000;
export const MAX_STEPS_PER_PLAN = 200;

export interface Target {
  selector?: string;
  text?: string;
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  exact?: boolean;
  nth?: number;
}

interface StepCommon {
  /** Shown in the report. Defaults to a description of the action. */
  name?: string;
  /** Marks a step as destructive (payment, delete, …) even if it doesn't look like one. */
  destructive?: boolean;
  /** A failed optional step is reported but doesn't fail the scenario. */
  optional?: boolean;
  timeoutMs?: number;
}

export type Step = StepCommon &
  (
    | { action: "goto"; url: string }
    | { action: "click"; target: Target }
    | { action: "hover"; target: Target }
    | { action: "fill"; target: Target; value?: string; secret?: string }
    | { action: "select"; target: Target; value: string }
    | { action: "check"; target: Target; checked: boolean }
    | { action: "press"; key: string; target?: Target }
    | { action: "waitFor"; target: Target; state: "visible" | "hidden" }
    | { action: "wait"; ms: number }
    | { action: "expectText"; text: string; target?: Target; absent: boolean }
    | { action: "expectVisible"; target: Target }
    | { action: "expectHidden"; target: Target }
    | { action: "expectUrl"; contains?: string; matches?: string }
    | { action: "expectTitle"; contains: string }
    | {
        action: "request";
        method: string;
        url: string;
        status?: number[];
        bodyContains?: string;
        body?: unknown;
        headers?: Record<string, string>;
        /** Header name → secret name, e.g. { Authorization: WEBTEST_API_TOKEN }. */
        secretHeaders?: Record<string, string>;
      }
    | { action: "screenshot"; label?: string; fullPage: boolean }
  );

export type StepAction = Step["action"];

export interface Scenario {
  name: string;
  /** Saved session to start from. null = start logged out even if the plan has a session. */
  session?: string | null;
  steps: Step[];
}

export interface CiCheck {
  repo: string;
  pr?: number;
  branch?: string;
  commit?: string;
}

export interface SuiteCheck {
  cwd: string;
  script: string;
  args?: string[];
}

export interface WebTestPlan {
  name: string;
  baseUrl?: string;
  session?: string;
  device?: string;
  viewport?: { width: number; height: number };
  screenshots: "each" | "failures" | "none";
  stopOnFailure: boolean;
  timeoutMs: number;
  scenarios: Scenario[];
  checks?: { ci?: CiCheck[]; suites?: SuiteCheck[] };
}

// --- input schema -----------------------------------------------------------

const targetObject = z
  .object({
    selector: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    name: z.string().optional(),
    label: z.string().min(1).optional(),
    placeholder: z.string().min(1).optional(),
    testId: z.string().min(1).optional(),
    exact: z.boolean().optional(),
    nth: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (t) => Boolean(t.selector || t.text || t.role || t.label || t.placeholder || t.testId),
    "a target needs one of selector, text, role, label, placeholder or testId",
  );

const targetInput = z.union([z.string().min(1), targetObject]);

function toTarget(input: z.infer<typeof targetInput>): Target {
  return typeof input === "string" ? { selector: input } : input;
}

const commonKeys = new Set(["name", "destructive", "optional", "timeoutMs"]);

const commonSchema = z.object({
  name: z.string().max(200).optional(),
  destructive: z.boolean().optional(),
  optional: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(MAX_STEP_TIMEOUT_MS).optional(),
});

const secretName = z.string().regex(SECRET_REF_RE, "secret names are UPPER_SNAKE_CASE");

const actionParsers: Record<StepAction, (value: unknown) => Step> = {
  goto: (v) => ({ action: "goto", url: z.string().min(1).parse(v) }),
  click: (v) => ({ action: "click", target: toTarget(targetInput.parse(v)) }),
  hover: (v) => ({ action: "hover", target: toTarget(targetInput.parse(v)) }),
  fill: (v) => {
    const { target, extras } = targetAnd(v, { value: z.string().optional(), secret: secretName.optional() });
    if ((extras.value === undefined) === (extras.secret === undefined)) {
      throw new Error("fill needs exactly one of value or secret");
    }
    return {
      action: "fill",
      target,
      ...(extras.secret ? { secret: extras.secret } : { value: extras.value }),
    };
  },
  select: (v) => {
    const { target, extras } = targetAnd(v, { value: z.string() });
    return { action: "select", target, value: extras.value };
  },
  check: (v) => {
    if (typeof v === "string") return { action: "check", target: { selector: v }, checked: true };
    const { target, extras } = targetAnd(v, { checked: z.boolean().optional() });
    return { action: "check", target, checked: extras.checked ?? true };
  },
  press: (v) => {
    if (typeof v === "string") return { action: "press", key: v };
    const raw = objectInput(v);
    const key = z.string().min(1).parse(raw.key);
    delete raw.key;
    return Object.keys(raw).length
      ? { action: "press", key, target: toTarget(targetInput.parse(raw)) }
      : { action: "press", key };
  },
  waitFor: (v) => {
    if (typeof v === "string") return { action: "waitFor", target: { selector: v }, state: "visible" };
    const { target, extras } = targetAnd(v, { state: z.enum(["visible", "hidden"]).optional() });
    return { action: "waitFor", target, state: extras.state ?? "visible" };
  },
  wait: (v) => ({ action: "wait", ms: z.number().int().min(0).max(60_000).parse(v) }),
  expectText: (v) => {
    if (typeof v === "string") return { action: "expectText", text: v, absent: false };
    const raw = z
      .object({ text: z.string().min(1), absent: z.boolean().optional(), in: targetInput.optional() })
      .strict()
      .parse(v);
    return {
      action: "expectText",
      text: raw.text,
      absent: raw.absent ?? false,
      ...(raw.in ? { target: toTarget(raw.in) } : {}),
    };
  },
  expectVisible: (v) => ({ action: "expectVisible", target: toTarget(targetInput.parse(v)) }),
  expectHidden: (v) => ({ action: "expectHidden", target: toTarget(targetInput.parse(v)) }),
  expectUrl: (v) => {
    if (typeof v === "string") return { action: "expectUrl", contains: v };
    const raw = z
      .object({ contains: z.string().min(1).optional(), matches: z.string().min(1).optional() })
      .strict()
      .refine((r) => r.contains || r.matches, "expectUrl needs contains or matches")
      .parse(v);
    if (raw.matches) new RegExp(raw.matches); // throws on an invalid pattern
    return { action: "expectUrl", ...raw };
  },
  expectTitle: (v) => ({ action: "expectTitle", contains: z.string().min(1).parse(v) }),
  request: (v) => {
    const raw = z
      .object({
        method: z.string().regex(/^[A-Za-z]+$/).optional(),
        url: z.string().min(1),
        status: z.union([z.number().int(), z.array(z.number().int()).min(1)]).optional(),
        bodyContains: z.string().optional(),
        body: z.unknown().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        secretHeaders: z.record(z.string(), secretName).optional(),
      })
      .strict()
      .parse(v);
    return {
      action: "request",
      method: (raw.method ?? "GET").toUpperCase(),
      url: raw.url,
      ...(raw.status !== undefined ? { status: Array.isArray(raw.status) ? raw.status : [raw.status] } : {}),
      ...(raw.bodyContains !== undefined ? { bodyContains: raw.bodyContains } : {}),
      ...(raw.body !== undefined ? { body: raw.body } : {}),
      ...(raw.headers ? { headers: raw.headers } : {}),
      ...(raw.secretHeaders ? { secretHeaders: raw.secretHeaders } : {}),
    };
  },
  screenshot: (v) => {
    if (v === null || v === true || v === undefined) return { action: "screenshot", fullPage: false };
    if (typeof v === "string") return { action: "screenshot", label: v, fullPage: false };
    const raw = z
      .object({ label: z.string().optional(), fullPage: z.boolean().optional() })
      .strict()
      .parse(v);
    return { action: "screenshot", fullPage: raw.fullPage ?? false, ...(raw.label ? { label: raw.label } : {}) };
  },
};

function objectInput(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("expected an object");
  return { ...(v as Record<string, unknown>) };
}

/** Splits `{ label: "Email", value: "x" }` into the target and the action's own fields. */
function targetAnd<E extends z.ZodRawShape>(
  v: unknown,
  extras: E,
): { target: Target; extras: z.infer<z.ZodObject<E>> } {
  const raw = objectInput(v);
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(extras)) {
    if (key in raw) {
      picked[key] = raw[key];
      delete raw[key];
    }
  }
  return { target: toTarget(targetInput.parse(raw)), extras: z.object(extras).parse(picked) };
}

export const STEP_ACTIONS = Object.keys(actionParsers) as StepAction[];

export function parseStep(input: unknown): Step {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("each step must be an object like { goto: \"/path\" }");
  }
  const entries = Object.entries(input as Record<string, unknown>);
  const actions = entries.filter(([key]) => !commonKeys.has(key));
  if (actions.length !== 1) {
    throw new Error(
      `each step needs exactly one action (${STEP_ACTIONS.join(", ")}); got ${actions.map(([k]) => k).join(", ") || "none"}`,
    );
  }
  const [action, value] = actions[0];
  const parser = actionParsers[action as StepAction];
  if (!parser) throw new Error(`unknown action "${action}" (use one of ${STEP_ACTIONS.join(", ")})`);
  const common = commonSchema.parse(Object.fromEntries(entries.filter(([key]) => commonKeys.has(key))));
  return { ...parser(value), ...common } as Step;
}

const sessionName = z.string().regex(SESSION_NAME_RE, "session names are letters, digits, . _ -");

const planSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    baseUrl: z.string().min(1).optional(),
    session: sessionName.optional(),
    device: z.string().min(1).optional(),
    viewport: z
      .object({ width: z.number().int().min(200).max(3840), height: z.number().int().min(200).max(4000) })
      .optional(),
    screenshots: z.enum(["each", "failures", "none"]).optional(),
    stopOnFailure: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(MAX_STEP_TIMEOUT_MS).optional(),
    steps: z.array(z.unknown()).optional(),
    scenarios: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            session: sessionName.nullable().optional(),
            steps: z.array(z.unknown()).min(1),
          })
          .strict(),
      )
      .optional(),
    checks: z
      .object({
        ci: z
          .array(
            z
              .object({
                repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo is owner/name"),
                pr: z.number().int().positive().optional(),
                branch: z.string().regex(/^[\w][\w./-]*$/).optional(),
                commit: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
              })
              .strict(),
          )
          .optional(),
        suites: z
          .array(
            z
              .object({
                cwd: z.string().min(1),
                script: z.string().regex(/^[\w:.-]+$/),
                args: z.array(z.string().regex(/^[\w@./:=,-]+$/)).max(20).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((p) => Boolean(p.steps?.length) !== Boolean(p.scenarios?.length), {
    message: "a plan needs either steps or scenarios (not both)",
  });

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "plan"}: ${i.message}`)
    .join("; ");
}

/** Parses a plan given as an object, or as JSON/YAML text. Throws a readable Error. */
export function parsePlan(input: unknown): WebTestPlan {
  let raw: unknown = input;
  if (typeof input === "string") {
    const text = input.trim();
    try {
      raw = text.startsWith("{") ? JSON.parse(text) : yaml.load(text, { schema: yaml.JSON_SCHEMA });
    } catch (err) {
      throw new Error(`Couldn't parse the plan as JSON or YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const result = planSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid plan: ${formatZodError(result.error)}`);
  const p = result.data;

  const parseSteps = (steps: unknown[], where: string): Step[] =>
    steps.map((s, i) => {
      try {
        return parseStep(s);
      } catch (err) {
        const msg = err instanceof z.ZodError ? formatZodError(err) : err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid plan: ${where} step ${i + 1}: ${msg}`);
      }
    });

  const scenarios: Scenario[] = p.scenarios?.length
    ? p.scenarios.map((s) => ({
        name: s.name,
        ...(s.session !== undefined ? { session: s.session } : {}),
        steps: parseSteps(s.steps, `scenario "${s.name}"`),
      }))
    : [{ name: p.name ?? "Checks", steps: parseSteps(p.steps ?? [], "") }];

  const total = scenarios.reduce((n, s) => n + s.steps.length, 0);
  if (total > MAX_STEPS_PER_PLAN) throw new Error(`Invalid plan: too many steps (${total} > ${MAX_STEPS_PER_PLAN}).`);

  return {
    name: p.name ?? scenarios[0].name,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(p.session ? { session: p.session } : {}),
    ...(p.device ? { device: p.device } : {}),
    ...(p.viewport ? { viewport: p.viewport } : {}),
    screenshots: p.screenshots ?? "each",
    stopOnFailure: p.stopOnFailure ?? true,
    timeoutMs: p.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    scenarios,
    ...(p.checks ? { checks: p.checks } : {}),
  };
}

/** Every secret NAME a plan refers to (fill secrets and request secretHeaders). */
export function planSecretNames(plan: WebTestPlan): string[] {
  const names = new Set<string>();
  for (const scenario of plan.scenarios) {
    for (const step of scenario.steps) {
      if (step.action === "fill" && step.secret) names.add(step.secret);
      if (step.action === "request" && step.secretHeaders) {
        for (const name of Object.values(step.secretHeaders)) names.add(name);
      }
    }
  }
  return [...names];
}

/** Every saved session a plan needs. */
export function planSessionNames(plan: WebTestPlan): string[] {
  const names = new Set<string>();
  for (const scenario of plan.scenarios) {
    const session = scenario.session === undefined ? plan.session : scenario.session;
    if (session) names.add(session);
  }
  return [...names];
}

export function describeTarget(t: Target): string {
  let base: string;
  if (t.role) base = `${t.role}${t.name ? ` "${t.name}"` : ""}`;
  else if (t.text) base = `text "${t.text}"`;
  else if (t.label) base = `field "${t.label}"`;
  else if (t.placeholder) base = `placeholder "${t.placeholder}"`;
  else if (t.testId) base = `test id "${t.testId}"`;
  else base = t.selector ?? "?";
  return t.nth !== undefined ? `${base} #${t.nth + 1}` : base;
}

/** A short human description of a step. Never includes a secret value (there isn't one in the plan). */
export function describeStep(step: Step): string {
  if (step.name) return step.name;
  switch (step.action) {
    case "goto":
      return `open ${step.url}`;
    case "click":
      return `click ${describeTarget(step.target)}`;
    case "hover":
      return `hover ${describeTarget(step.target)}`;
    case "fill":
      return `fill ${describeTarget(step.target)} with ${step.secret ? `[secret ${step.secret}]` : JSON.stringify(step.value)}`;
    case "select":
      return `select "${step.value}" in ${describeTarget(step.target)}`;
    case "check":
      return `${step.checked ? "check" : "uncheck"} ${describeTarget(step.target)}`;
    case "press":
      return `press ${step.key}${step.target ? ` in ${describeTarget(step.target)}` : ""}`;
    case "waitFor":
      return `wait for ${describeTarget(step.target)} to be ${step.state}`;
    case "wait":
      return `wait ${step.ms} ms`;
    case "expectText":
      return `${step.absent ? "page does not show" : "page shows"} "${step.text}"${step.target ? ` in ${describeTarget(step.target)}` : ""}`;
    case "expectVisible":
      return `${describeTarget(step.target)} is visible`;
    case "expectHidden":
      return `${describeTarget(step.target)} is hidden`;
    case "expectUrl":
      return step.contains ? `URL contains "${step.contains}"` : `URL matches /${step.matches}/`;
    case "expectTitle":
      return `title contains "${step.contains}"`;
    case "request":
      return `${step.method} ${step.url}${step.status ? ` → ${step.status.join(" or ")}` : ""}`;
    case "screenshot":
      return `screenshot${step.label ? ` "${step.label}"` : ""}`;
  }
}
