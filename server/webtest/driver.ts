import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Locator, Page } from "patchright";
import { resolveDeviceEmulation, wantsEmulation } from "../browser/devices.js";
import type { Target } from "./plan.js";

/**
 * The browser the web test runner drives. The runner only talks to these
 * interfaces, so its logic is unit-tested with a fake; the real one below is a
 * fresh headless Chromium per run (Patchright), independent of the Mac-only
 * "local browser" integration and its persistent profile.
 */

export interface SessionOptions {
  storageStatePath?: string;
  device?: string;
  viewport?: { width: number; height: number };
}

export interface RequestOptions {
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface WebTestSession {
  goto(url: string, timeoutMs: number): Promise<{ status: number | null }>;
  click(target: Target, timeoutMs: number): Promise<void>;
  hover(target: Target, timeoutMs: number): Promise<void>;
  fill(target: Target, value: string, timeoutMs: number): Promise<void>;
  select(target: Target, value: string, timeoutMs: number): Promise<void>;
  setChecked(target: Target, checked: boolean, timeoutMs: number): Promise<void>;
  press(key: string, target: Target | undefined, timeoutMs: number): Promise<void>;
  /** Visible text of the target (or the whole page). Empty string if not found. */
  readText(target: Target | undefined): Promise<string>;
  isVisible(target: Target): Promise<boolean>;
  url(): string;
  title(): Promise<string>;
  /** A request sharing the session's cookies (not a page navigation). */
  request(url: string, opts: RequestOptions): Promise<{ status: number; body: string }>;
  screenshot(path: string, fullPage: boolean): Promise<void>;
  saveStorageState(path: string): Promise<void>;
  /** Console errors and failed/4xx-5xx network requests since the last call. */
  drainEvents(): { console: string[]; network: string[] };
  close(): Promise<void>;
}

export interface WebTestBrowser {
  newSession(opts: SessionOptions): Promise<WebTestSession>;
  close(): Promise<void>;
}

export type LaunchBrowser = () => Promise<WebTestBrowser>;

// --- availability -----------------------------------------------------------

export const SETUP_HINT = [
  "To set it up, run the webtest_setup tool (it downloads Chromium for Patchright), or on the machine run:",
  "  npm run webtest:install",
  "On a Linux server the browser also needs system libraries, once, as root:",
  "  sudo npx patchright install-deps chromium",
].join("\n");

export class BrowserUnavailableError extends Error {}

type PatchrightModule = typeof import("patchright");

async function loadPatchright(): Promise<PatchrightModule> {
  try {
    return await import("patchright");
  } catch (err) {
    throw new BrowserUnavailableError(
      `Patchright (the headless browser library) isn't installed: ${err instanceof Error ? err.message : String(err)}\nReinstall dependencies with "npm install" (it's an optional dependency), then:\n${SETUP_HINT}`,
    );
  }
}

/** A custom Chromium/Chrome binary, if the owner set one. */
function customExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.BOOP_WEBTEST_EXECUTABLE_PATH?.trim() || undefined;
}

/** Turns Playwright's long launch errors into one clear message. */
export function explainLaunchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/Executable doesn't exist|browserType\.launch: .*not found|please run the following command to download/i.test(message)) {
    return `Headless Chromium isn't installed on this machine.\n${SETUP_HINT}`;
  }
  if (/error while loading shared libraries|missing dependencies|Host system is missing/i.test(message)) {
    return `Chromium is installed but this machine is missing system libraries it needs.\nRun once, as root: sudo npx patchright install-deps chromium\n(${message.split("\n")[0]})`;
  }
  return `Couldn't start headless Chromium: ${message.split("\n").slice(0, 3).join(" ")}`;
}

function locate(page: Page, t: Target): Locator {
  const exact = t.exact ?? false;
  let loc: Locator;
  if (t.role) {
    loc = page.getByRole(t.role as Parameters<Page["getByRole"]>[0], t.name ? { name: t.name, exact } : {});
  } else if (t.label) loc = page.getByLabel(t.label, { exact });
  else if (t.placeholder) loc = page.getByPlaceholder(t.placeholder, { exact });
  else if (t.testId) loc = page.getByTestId(t.testId);
  else if (t.text) loc = page.getByText(t.text, { exact });
  else loc = page.locator(t.selector ?? "body");
  if (t.text && t.role) loc = loc.filter({ hasText: t.text });
  return t.nth !== undefined ? loc.nth(t.nth) : loc.first();
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

const MAX_EVENTS = 50;

class PatchrightSession implements WebTestSession {
  private consoleEvents: string[] = [];
  private networkEvents: string[] = [];

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {
    const push = (list: string[], line: string) => {
      if (list.length < MAX_EVENTS) list.push(line.slice(0, 300));
    };
    page.on("console", (msg) => {
      if (msg.type() === "error") push(this.consoleEvents, msg.text());
    });
    page.on("pageerror", (err) => push(this.consoleEvents, `Uncaught: ${err.message}`));
    page.on("requestfailed", (req) => {
      const failure = req.failure()?.errorText ?? "failed";
      // Aborted requests are usually navigation side-effects, not bugs.
      if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) return;
      push(this.networkEvents, `${req.method()} ${stripQuery(req.url())} → ${failure}`);
    });
    page.on("response", (res) => {
      if (res.status() < 400) return;
      const type = res.request().resourceType();
      if (!["document", "xhr", "fetch", "script", "stylesheet"].includes(type)) return;
      push(this.networkEvents, `${res.request().method()} ${stripQuery(res.url())} → ${res.status()}`);
    });
  }

  async goto(url: string, timeoutMs: number) {
    const res = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await this.page.waitForLoadState("networkidle", { timeout: Math.min(5_000, timeoutMs) }).catch(() => undefined);
    return { status: res?.status() ?? null };
  }
  async click(t: Target, timeoutMs: number) {
    await locate(this.page, t).click({ timeout: timeoutMs });
    await this.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  }
  async hover(t: Target, timeoutMs: number) {
    await locate(this.page, t).hover({ timeout: timeoutMs });
  }
  async fill(t: Target, value: string, timeoutMs: number) {
    await locate(this.page, t).fill(value, { timeout: timeoutMs });
  }
  async select(t: Target, value: string, timeoutMs: number) {
    const loc = locate(this.page, t);
    await loc.selectOption(value, { timeout: timeoutMs }).catch(async () => {
      await loc.selectOption({ label: value }, { timeout: timeoutMs });
    });
  }
  async setChecked(t: Target, checked: boolean, timeoutMs: number) {
    await locate(this.page, t).setChecked(checked, { timeout: timeoutMs });
  }
  async press(key: string, t: Target | undefined, timeoutMs: number) {
    if (t) await locate(this.page, t).press(key, { timeout: timeoutMs });
    else await this.page.keyboard.press(key);
    await this.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  }
  async readText(t: Target | undefined) {
    const loc = t ? locate(this.page, t) : this.page.locator("body");
    return (await loc.innerText({ timeout: 1_000 }).catch(() => "")) ?? "";
  }
  async isVisible(t: Target) {
    return await locate(this.page, t).isVisible().catch(() => false);
  }
  url() {
    return this.page.url();
  }
  async title() {
    return await this.page.title();
  }
  async request(url: string, opts: RequestOptions) {
    const res = await this.context.request.fetch(url, {
      method: opts.method,
      headers: opts.headers,
      ...(opts.body !== undefined
        ? typeof opts.body === "string"
          ? { data: opts.body }
          : { data: opts.body as Record<string, unknown> }
        : {}),
      timeout: opts.timeoutMs,
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const body = await res.text().catch(() => "");
    return { status: res.status(), body: body.slice(0, 20_000) };
  }
  async screenshot(path: string, fullPage: boolean) {
    await this.page.screenshot({ path, fullPage, timeout: 15_000 });
  }
  async saveStorageState(path: string) {
    await this.context.storageState({ path });
  }
  drainEvents() {
    const out = { console: this.consoleEvents, network: this.networkEvents };
    this.consoleEvents = [];
    this.networkEvents = [];
    return out;
  }
  async close() {
    await this.context.close().catch(() => undefined);
  }
}

class PatchrightBrowser implements WebTestBrowser {
  constructor(private readonly browser: Browser) {}

  async newSession(opts: SessionOptions): Promise<WebTestSession> {
    const storageState = opts.storageStatePath && existsSync(opts.storageStatePath) ? opts.storageStatePath : undefined;
    const emulationInput = { device: opts.device, ...(opts.viewport ?? {}) };
    const emulation = wantsEmulation(emulationInput) ? resolveDeviceEmulation(emulationInput) : null;
    const context = await this.browser.newContext({
      ...(emulation
        ? {
            viewport: { width: emulation.width, height: emulation.height },
            deviceScaleFactor: emulation.deviceScaleFactor,
            isMobile: emulation.isMobile,
            hasTouch: emulation.hasTouch,
            ...(emulation.userAgent ? { userAgent: emulation.userAgent } : {}),
          }
        : { viewport: { width: 1280, height: 800 } }),
      ...(storageState ? { storageState } : {}),
      // Test runs never get to keep downloads or grant permissions.
      acceptDownloads: false,
    });
    const page = await context.newPage();
    return new PatchrightSession(context, page);
  }

  async close() {
    await this.browser.close().catch(() => undefined);
  }
}

/** Launches a fresh headless Chromium. Throws BrowserUnavailableError with setup steps when it can't. */
export async function launchHeadlessChromium(env: NodeJS.ProcessEnv = process.env): Promise<WebTestBrowser> {
  const { chromium } = await loadPatchright();
  const executablePath = customExecutable(env);
  try {
    const browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      // --no-sandbox is needed when Boop runs as root or in a container without user namespaces.
      args: process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : [],
      timeout: 30_000,
    });
    return new PatchrightBrowser(browser);
  } catch (err) {
    throw new BrowserUnavailableError(explainLaunchError(err));
  }
}

export interface BrowserCheck {
  ok: boolean;
  message: string;
}

/** Launches and closes a browser to see whether test runs can work here. */
export async function checkHeadlessBrowser(launch: LaunchBrowser = launchHeadlessChromium): Promise<BrowserCheck> {
  try {
    const browser = await launch();
    await browser.close();
    return { ok: true, message: "Headless Chromium is installed and starts." };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
