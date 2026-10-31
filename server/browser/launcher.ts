import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, Page } from "patchright";
import {
  getBrowserSettings,
  type BrowserSettings,
} from "../runtime-config.js";
import { MAX_OUTBOUND_IMAGE_BYTES } from "../images/outbound.js";
import {
  readPngSize,
  resolveDeviceEmulation,
  wantsEmulation,
  type DeviceEmulation,
  type DeviceEmulationInput,
} from "./devices.js";

const require = createRequire(import.meta.url);
const SCREENSHOT_DIR = join(tmpdir(), "boop-browser-screenshots");
const BROWSER_CLOSE_TIMEOUT_MS = 2_000;
const BROWSER_LAUNCH_TIMEOUT_MS = 30_000;
const BROWSER_INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_BROWSER_SCREENSHOTS = 20;
type PatchrightModule = typeof import("patchright");

let context: BrowserContext | null = null;
let activePage: Page | null = null;
let launchPromise: Promise<LaunchResult> | null = null;
let installPromise: Promise<InstallResult> | null = null;
let activeSignature = "";
let launchedAt: number | null = null;
let patchrightPromise: Promise<PatchrightModule> | null = null;

export interface LaunchResult {
  ok: true;
  running: true;
  url: string;
  profileDir: string;
  showUi: boolean;
  loginHandoffEnabled: boolean;
  channel: string;
  executablePath: string;
  extraArgs: string[];
  patchrightVersion: string;
  launchedAt: number;
}

export interface BrowserStatus {
  running: boolean;
  patchrightVersion: string;
  detectedChromePath: string | null;
  launchedAt: number | null;
  settings: BrowserSettings;
  activeUrl: string | null;
}

export interface InstallResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export interface LaunchOptions {
  url?: string;
  forceVisible?: boolean;
  relaunch?: boolean;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  const withScheme = /^(https?:|about:)/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  const isAboutBlank =
    parsed.protocol === "about:" &&
    parsed.pathname.toLowerCase() === "blank" &&
    !parsed.search &&
    !parsed.hash;
  if (!["http:", "https:"].includes(parsed.protocol) && !isAboutBlank) {
    throw new Error("Browser URL must be http(s) or about:blank.");
  }
  return isAboutBlank ? "about:blank" : parsed.toString();
}

function detectChromePath(): string | null {
  if (process.env.BOOP_BROWSER_EXECUTABLE_PATH) {
    return process.env.BOOP_BROWSER_EXECUTABLE_PATH;
  }
  const candidates = [...systemChromiumCandidates(), ...cachedChromiumCandidates()];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function systemChromiumCandidates(): string[] {
  return platform() === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ]
    : platform() === "linux"
      ? [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ]
      : platform() === "win32"
        ? [
            join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
            join(
              process.env["PROGRAMFILES(X86)"] ?? "",
              "Google",
              "Chrome",
              "Application",
              "chrome.exe",
            ),
          ]
        : [];
}

function cachedChromiumCandidates(): string[] {
  const root =
    platform() === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : platform() === "linux"
        ? join(homedir(), ".cache", "ms-playwright")
        : process.env.LOCALAPPDATA
          ? join(process.env.LOCALAPPDATA, "ms-playwright")
          : "";
  if (!root || !existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)))
    .flatMap((entry) => {
      const base = join(root, entry);
      return platform() === "darwin"
        ? [
            join(
              base,
              "chrome-mac-arm64",
              "Google Chrome for Testing.app",
              "Contents",
              "MacOS",
              "Google Chrome for Testing",
            ),
            join(
              base,
              "chrome-mac",
              "Google Chrome for Testing.app",
              "Contents",
              "MacOS",
              "Google Chrome for Testing",
            ),
          ]
        : platform() === "linux"
          ? [join(base, "chrome-linux", "chrome")]
          : [
              join(base, "chrome-win", "chrome.exe"),
              join(base, "chrome-win64", "chrome.exe"),
            ];
    });
}

function patchrightVersion(): string {
  try {
    const patchrightPkg = require("patchright/package.json") as { version?: string };
    return patchrightPkg.version ?? "unknown";
  } catch {
    return "not installed";
  }
}

async function loadPatchright(): Promise<PatchrightModule> {
  patchrightPromise ??= import("patchright").catch((err) => {
    patchrightPromise = null;
    throw new Error(
      `Patchright is not installed. Install optional dependencies, then use "Install browser" if the browser binary is missing. (${err instanceof Error ? err.message : String(err)})`,
    );
  });
  return await patchrightPromise;
}

function assertBrowserEnabled(settings: BrowserSettings): void {
  if (!settings.enabled) {
    throw new Error("Local browser use is disabled. Turn on Local browser use in Settings first.");
  }
}

function launchSignature(settings: BrowserSettings, showUi: boolean): string {
  return JSON.stringify({
    profileDir: resolve(expandHome(settings.profileDir)),
    showUi,
    channel: settings.channel,
    executablePath: effectiveBrowserExecutablePath(settings),
    extraArgs: settings.extraArgs,
  });
}

function effectiveBrowserExecutablePath(settings: BrowserSettings): string {
  return settings.executablePath.trim()
    ? expandHome(settings.executablePath)
    : (detectChromePath() ?? "");
}

async function getUsablePage(): Promise<Page> {
  if (activePage && !activePage.isClosed()) return activePage;
  if (!context) throw new Error("Local browser is not running.");
  activePage = context.pages().find((page) => !page.isClosed()) ?? (await context.newPage());
  return activePage;
}

function getExistingPage(): Page | null {
  if (activePage && !activePage.isClosed()) return activePage;
  if (!context) return null;
  activePage = context.pages().find((page) => !page.isClosed()) ?? null;
  return activePage;
}

function shouldReplayLaunchOptions(options: LaunchOptions): boolean {
  return (
    options.url !== undefined ||
    options.forceVisible === true ||
    options.relaunch === true
  );
}

async function closeContextWithTimeout(current: BrowserContext): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    current.close().catch(() => undefined),
    new Promise<void>((resolveTimeout) => {
      timeout = setTimeout(() => {
        console.warn(
          `[browser] close timed out after ${BROWSER_CLOSE_TIMEOUT_MS}ms; continuing.`,
        );
        resolveTimeout();
      }, BROWSER_CLOSE_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function browserLaunchTimeoutMessage(settings: BrowserSettings): string {
  const executablePath = effectiveBrowserExecutablePath(settings);
  const target = executablePath
    ? `browser executable at ${executablePath}`
    : `browser channel "${settings.channel || "chrome"}"`;
  return [
    `Local browser launch timed out after ${Math.round(BROWSER_LAUNCH_TIMEOUT_MS / 1000)} seconds while starting ${target}.`,
    "Use a Patchright-compatible Chrome or Chromium browser, or clear the custom executable path and click Install browser in Settings.",
  ].join(" ");
}

async function closeActiveContext(): Promise<void> {
  const current = context;
  context = null;
  activePage = null;
  activeSignature = "";
  launchedAt = null;
  if (current) await closeContextWithTimeout(current);
}

export function selectorFor(input: string): string {
  const trimmed = input.trim();
  const refMatch =
    trimmed.match(/^\[ref=([^\]]+)\]$/) ??
    trimmed.match(/^@?(e\d+)$/) ??
    trimmed.match(/^ref=([^\s]+)$/) ??
    trimmed.match(/^aria-ref=([^\s]+)$/);
  return refMatch ? `aria-ref=${refMatch[1]}` : trimmed;
}

export async function launchLocalBrowser(
  options: LaunchOptions = {},
): Promise<LaunchResult> {
  if (launchPromise) {
    const result = await launchPromise;
    return shouldReplayLaunchOptions(options) ? await launchLocalBrowser(options) : result;
  }

  launchPromise = (async () => {
    const settings = await getBrowserSettings();
    assertBrowserEnabled(settings);
    const { chromium } = await loadPatchright();
    const showUi = options.forceVisible ? true : settings.showUi;
    const executablePath = effectiveBrowserExecutablePath(settings);
    const signature = launchSignature(settings, showUi);
    const targetUrl = normalizeUrl(options.url ?? settings.startUrl);

    if (context && !options.relaunch && activeSignature === signature) {
      const page = await getUsablePage();
      if (targetUrl !== "about:blank") {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      }
      return browserLaunchResult(settings, showUi, page.url(), executablePath);
    }

    if (context) await closeActiveContext();

    const profileDir = resolve(expandHome(settings.profileDir));
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(profileDir, 0o700);
    } catch {
      // Best-effort hardening for profile directories created by earlier runs.
    }

    const launchArgs = {
      headless: !showUi,
      viewport: null,
      args: settings.extraArgs,
      ...(executablePath
        ? { executablePath }
        : { channel: settings.channel || "chrome" }),
    };

    console.log(
      `[browser] launching Patchright browser showUi=${showUi} profile=${profileDir}`,
    );
    context = await withTimeout(
      chromium.launchPersistentContext(profileDir, launchArgs),
      BROWSER_LAUNCH_TIMEOUT_MS,
      browserLaunchTimeoutMessage(settings),
    );
    context.on("close", () => {
      context = null;
      activePage = null;
      activeSignature = "";
      launchedAt = null;
    });
    activeSignature = signature;
    launchedAt = Date.now();
    const page = await getUsablePage();
    if (targetUrl !== "about:blank") {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    return browserLaunchResult(settings, showUi, page.url(), executablePath);
  })();

  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

function browserLaunchResult(
  settings: BrowserSettings,
  showUi: boolean,
  url: string,
  executablePath: string,
): LaunchResult {
  return {
    ok: true,
    running: true,
    url,
    profileDir: resolve(expandHome(settings.profileDir)),
    showUi,
    loginHandoffEnabled: settings.loginHandoffEnabled,
    channel: settings.channel,
    executablePath,
    extraArgs: settings.extraArgs,
    patchrightVersion: patchrightVersion(),
    launchedAt: launchedAt ?? Date.now(),
  };
}

export async function getBrowserStatus(): Promise<BrowserStatus> {
  const settings = await getBrowserSettings();
  const page = getExistingPage();
  return {
    running: Boolean(context),
    patchrightVersion: patchrightVersion(),
    detectedChromePath: detectChromePath(),
    launchedAt,
    settings,
    activeUrl: page?.url() ?? null,
  };
}

export async function closeLocalBrowser(): Promise<void> {
  const inFlightLaunch = launchPromise;
  if (inFlightLaunch) await inFlightLaunch.catch(() => undefined);
  await closeActiveContext();
}

export async function currentPage(): Promise<Page> {
  if (!context) await launchLocalBrowser();
  return await getUsablePage();
}

export async function openBrowserUrl(url: string): Promise<string> {
  const result = await launchLocalBrowser({ url });
  return result.url;
}

export async function browserSnapshot(): Promise<string> {
  const page = await currentPage();
  const snapshot = await page.ariaSnapshot({ mode: "ai" });
  return snapshot || "(empty page)";
}

export async function browserClick(selector: string): Promise<string> {
  const page = await currentPage();
  await page.locator(selectorFor(selector)).first().click({ timeout: 10_000 });
  return `Clicked ${selector}.`;
}

export async function browserFill(selector: string, text: string): Promise<string> {
  const page = await currentPage();
  await page.locator(selectorFor(selector)).first().fill(text, { timeout: 10_000 });
  return `Filled ${selector}.`;
}

export async function browserPress(key: string): Promise<string> {
  const page = await currentPage();
  await page.keyboard.press(key);
  return `Pressed ${key}.`;
}

export async function browserText(selector: string): Promise<string> {
  const page = await currentPage();
  return await page.locator(selectorFor(selector)).first().innerText({ timeout: 10_000 });
}

export async function browserUrl(): Promise<string> {
  const page = await currentPage();
  return page.url();
}

export interface ScreenshotOptions extends DeviceEmulationInput {
  /** Page to capture. Defaults to the current page. */
  url?: string;
  /** Capture the whole scrollable page instead of just the viewport. */
  fullPage?: boolean;
}

export interface ScreenshotResult {
  path: string;
  url: string;
  bytes: number;
  /** Actual pixel size of the saved PNG. */
  imageWidth: number | null;
  imageHeight: number | null;
  /** Set when device/viewport emulation was used. */
  emulation?: DeviceEmulation;
  /** Image width the requested emulation should produce (CSS width x scale). */
  expectedImageWidth?: number;
  /** Layout width the page actually rendered at, and its scrollable width. */
  innerWidth?: number;
  scrollWidth?: number;
  /** True when the PNG was re-captured at 1x to fit the iMessage size cap. */
  downscaled: boolean;
}

function nextScreenshotPath(): string {
  mkdirSync(SCREENSHOT_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(SCREENSHOT_DIR, 0o700);
    const existing = readdirSync(SCREENSHOT_DIR)
      .filter((file) => file.startsWith("boop-browser-") && file.endsWith(".png"))
      .sort();
    const removeCount = Math.max(0, existing.length - (MAX_BROWSER_SCREENSHOTS - 1));
    for (const oldFile of existing.slice(0, removeCount)) {
      unlinkSync(join(SCREENSHOT_DIR, oldFile));
    }
  } catch {
    // Screenshot rotation is best-effort; capture should still proceed.
  }
  return join(SCREENSHOT_DIR, `boop-browser-${Date.now()}.png`);
}

function imageInfo(path: string) {
  const bytes = readFileSync(path);
  const size = readPngSize(bytes);
  return {
    bytes: bytes.byteLength,
    imageWidth: size?.width ?? null,
    imageHeight: size?.height ?? null,
  };
}

export async function browserScreenshot(
  options: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  if (wantsEmulation(options)) return await emulatedScreenshot(options);
  const page = await currentPage();
  if (options.url !== undefined) {
    await page.goto(normalizeUrl(options.url), { waitUntil: "load", timeout: 30_000 });
  }
  const path = nextScreenshotPath();
  await page.screenshot({ path, fullPage: options.fullPage ?? false });
  return { path, url: page.url(), downscaled: false, ...imageInfo(path) };
}

/**
 * Capture a screenshot in a throwaway headless context with real device
 * emulation (viewport, deviceScaleFactor, isMobile, hasTouch, userAgent).
 * isMobile can only be set when a context is created, and the user's
 * persistent profile context is shared, so we never resize it in place.
 * Cookies/localStorage are copied from the running profile so logged-in
 * pages render the same way.
 */
async function emulatedScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
  const emulation = resolveDeviceEmulation(options);
  const settings = await getBrowserSettings();
  assertBrowserEnabled(settings);
  const targetUrl = normalizeUrl(options.url ?? getExistingPage()?.url() ?? "");
  if (targetUrl === "about:blank") {
    throw new Error("Pass a url to screenshot (no page is open in the local browser).");
  }
  const storageState = context ? await context.storageState().catch(() => undefined) : undefined;
  const { chromium } = await loadPatchright();
  const executablePath = effectiveBrowserExecutablePath(settings);
  const browser = await withTimeout(
    chromium.launch({
      headless: true,
      args: settings.extraArgs,
      ...(executablePath ? { executablePath } : { channel: settings.channel || "chrome" }),
    }),
    BROWSER_LAUNCH_TIMEOUT_MS,
    browserLaunchTimeoutMessage(settings),
  );
  try {
    const emulatedContext = await browser.newContext({
      viewport: { width: emulation.width, height: emulation.height },
      screen: { width: emulation.width, height: emulation.height },
      deviceScaleFactor: emulation.deviceScaleFactor,
      isMobile: emulation.isMobile,
      hasTouch: emulation.hasTouch,
      ...(emulation.userAgent ? { userAgent: emulation.userAgent } : {}),
      ...(storageState ? { storageState } : {}),
    });
    const page = await emulatedContext.newPage();
    await page.goto(targetUrl, { waitUntil: "load", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const layout = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    const fullPage = options.fullPage ?? false;
    const path = nextScreenshotPath();
    await page.screenshot({ path, fullPage });
    let info = imageInfo(path);
    let downscaled = false;
    if (info.bytes > MAX_OUTBOUND_IMAGE_BYTES && emulation.deviceScaleFactor > 1) {
      // Too big for an iMessage attachment; re-capture at 1 image px per CSS px.
      await page.screenshot({ path, fullPage, scale: "css" });
      info = imageInfo(path);
      downscaled = true;
    }
    const scale = downscaled ? 1 : emulation.deviceScaleFactor;
    return {
      path,
      url: page.url(),
      emulation,
      expectedImageWidth: Math.round(emulation.width * scale),
      ...layout,
      downscaled,
      ...info,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Human/agent-readable summary, including a width check the agent can trust. */
export function formatScreenshotResult(result: ScreenshotResult): string {
  const lines = [`Screenshot saved: ${result.path}`, `Page: ${result.url}`];
  const size =
    result.imageWidth !== null ? `${result.imageWidth}x${result.imageHeight} px` : "unknown size";
  lines.push(`Image: ${size}, ${Math.round(result.bytes / 1024)} KB.`);
  if (result.emulation) {
    const e = result.emulation;
    lines.push(
      `Emulated: ${e.width}x${e.height} CSS px @${e.deviceScaleFactor}x, isMobile=${e.isMobile}, hasTouch=${e.hasTouch}${e.userAgent ? ", custom user agent" : ""}.`,
    );
    if (result.downscaled) {
      lines.push(
        `Re-captured at 1x because the ${e.deviceScaleFactor}x image exceeded the ${MAX_OUTBOUND_IMAGE_BYTES / (1024 * 1024)} MB iMessage limit.`,
      );
    }
    const widthOk = result.imageWidth === result.expectedImageWidth;
    const overflow =
      result.scrollWidth !== undefined &&
      result.innerWidth !== undefined &&
      (result.scrollWidth > result.innerWidth || result.innerWidth !== e.width);
    lines.push(
      widthOk && !overflow
        ? `Width check: OK (image ${result.imageWidth} px = ${e.width} CSS px x ${result.downscaled ? 1 : e.deviceScaleFactor}; page fits the viewport).`
        : `Width check: MISMATCH (expected image width ${result.expectedImageWidth} px, got ${result.imageWidth}; page layout width ${result.innerWidth}, scroll width ${result.scrollWidth} vs requested ${e.width}). The page may be cut off or wider than the device; tell the user.`,
    );
  }
  return lines.join("\n");
}

export async function installPatchrightChrome(): Promise<InstallResult> {
  if (installPromise) return installPromise;
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  installPromise = new Promise((resolveInstall) => {
    const child = spawn(command, ["-y", "patchright", "install", "chromium"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (result: InstallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveInstall(result);
    };
    timeout = setTimeout(() => {
      child.kill();
      const detail = [
        output.trim().slice(-4000),
        `Install timed out after ${Math.round(BROWSER_INSTALL_TIMEOUT_MS / 1000)} seconds.`,
      ]
        .filter(Boolean)
        .join("\n");
      finish({ ok: false, exitCode: null, output: detail });
    }, BROWSER_INSTALL_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (err) => {
      finish({ ok: false, exitCode: null, output: err.message });
    });
    child.on("exit", (code) => {
      finish({
        ok: code === 0,
        exitCode: code,
        output: output.trim().slice(-4000),
      });
    });
  });
  try {
    return await installPromise;
  } finally {
    installPromise = null;
  }
}
