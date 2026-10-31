import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { getBrowserSettings } from "../runtime-config.js";
import {
  browserClick,
  browserFill,
  browserPress,
  browserScreenshot,
  browserSnapshot,
  browserText,
  browserUrl,
  formatScreenshotResult,
  launchLocalBrowser,
  openBrowserUrl,
} from "./launcher.js";
import { DEVICE_PRESET_SUMMARY } from "./devices.js";

const MCP_NAMESPACE = "browser";
const RUNTIME_NAMESPACE = "local_browser";

const FALLBACK_NOTE =
  "Use this local browser only when a native integration does not cover the task, or when the site needs a real logged-in browser, visual interaction, or a bot-wall-resistant flow.";

function ok(text: string) {
  return runtimeText(text);
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return runtimeText(`[browser error] ${message}`, false);
}

async function wrap(fn: () => Promise<string>) {
  try {
    return ok(await fn());
  } catch (err) {
    return toolError(err);
  }
}

export function createBrowserTools(namespace = RUNTIME_NAMESPACE): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      "browser_open",
      `Launch or reuse the user's local Patchright Chrome/Chromium profile and navigate to a URL. ${FALLBACK_NOTE}`,
      {
        url: z.string().describe("URL to open. Include the scheme when possible."),
      },
      async ({ url }) => wrap(async () => `Opened ${await openBrowserUrl(url)}.`),
    ),
    defineRuntimeTool(
      namespace,
      "browser_snapshot",
      "Return an AI-oriented accessibility snapshot of the current browser page, including element refs like [ref=e2]. Call this before click/fill when possible.",
      {},
      async () => wrap(browserSnapshot),
    ),
    defineRuntimeTool(
      namespace,
      "browser_click",
      "Click an element. Pass an aria snapshot ref like e2, @e2, [ref=e2], or a CSS/text selector.",
      {
        selector: z.string(),
      },
      async ({ selector }) => wrap(async () => browserClick(selector)),
    ),
    defineRuntimeTool(
      namespace,
      "browser_fill",
      "Fill an input. Pass an aria snapshot ref like e2, @e2, [ref=e2], or a CSS/text selector.",
      {
        selector: z.string(),
        text: z.string(),
      },
      async ({ selector, text }) => wrap(async () => browserFill(selector, text)),
    ),
    defineRuntimeTool(
      namespace,
      "browser_press",
      "Press a key in the focused browser page, e.g. Enter, Tab, Escape, or Control+a.",
      {
        key: z.string(),
      },
      async ({ key }) => wrap(async () => browserPress(key)),
    ),
    defineRuntimeTool(
      namespace,
      "browser_get_text",
      "Read visible text from an element. Pass an aria snapshot ref like e2, @e2, [ref=e2], or a CSS/text selector.",
      {
        selector: z.string(),
      },
      async ({ selector }) => wrap(async () => browserText(selector)),
    ),
    defineRuntimeTool(
      namespace,
      "browser_get_url",
      "Return the current browser page URL.",
      {},
      async () => wrap(browserUrl),
    ),
    defineRuntimeTool(
      namespace,
      "browser_screenshot",
      [
        "Capture a PNG screenshot and return its local path, pixel size, and a width check.",
        `For "mobile/iPhone/phone view", "tablet/iPad view", "desktop view", or a custom size, pass device and/or width/height: the page is rendered in a fresh emulated context (real isMobile + touch + mobile user agent, so responsive layouts render like on the device). Presets: ${DEVICE_PRESET_SUMMARY}. Aliases: mobile/phone -> iphone, android -> pixel, tablet -> ipad.`,
        "Without device/size options it captures the current page as-is. To send the image to the user, pass the returned path to attach_image, after confirming the width check says OK.",
      ].join(" "),
      {
        url: z
          .string()
          .optional()
          .describe("Page to capture. Defaults to the current browser page."),
        device: z
          .string()
          .optional()
          .describe("Device preset: iphone, pixel, ipad, laptop, desktop (or mobile, phone, tablet)."),
        width: z.number().optional().describe("Viewport width in CSS px (overrides the preset)."),
        height: z.number().optional().describe("Viewport height in CSS px (overrides the preset)."),
        deviceScaleFactor: z.number().optional().describe("Pixel ratio, e.g. 3 for iPhone."),
        isMobile: z
          .boolean()
          .optional()
          .describe("Emulate a mobile device so the page's viewport meta tag is honored."),
        hasTouch: z.boolean().optional(),
        userAgent: z.string().optional(),
        fullPage: z
          .boolean()
          .optional()
          .describe("Capture the full scrollable page instead of only the viewport. Default false."),
      },
      async (args) =>
        wrap(async () => formatScreenshotResult(await browserScreenshot(args))),
    ),
    defineRuntimeTool(
      namespace,
      "browser_request_login",
      `Open a visible local browser instance so the user can log in by hand. Use this for login services, MFA, bot-wall-sensitive sites, or anything likely to detect automation. The setting "Spawn an instance to log in" must be enabled.`,
      {
        url: z
          .string()
          .optional()
          .describe("Optional login URL to open before asking the user to authenticate."),
      },
      async ({ url }) => {
        try {
          const settings = await getBrowserSettings();
          if (!settings.loginHandoffEnabled) {
            return runtimeText(
              "Login handoff is disabled in Settings. Ask the user to turn on \"Spawn an instance to log in\" before trying the handoff.",
              false,
            );
          }
          const result = await launchLocalBrowser({ url, forceVisible: true });
          return runtimeText(
            [
              "I need you to log in first. I’ve spawned an instance on your machine.",
              `Opened: ${result.url}`,
              "Ask the user to reply when they are done logging in, then continue from the same browser profile.",
            ].join("\n"),
          );
        } catch (err) {
          return toolError(err);
        }
      },
    ),
  ];
}

export function createBrowserMcp() {
  return createClaudeMcpServer(MCP_NAMESPACE, createBrowserTools(MCP_NAMESPACE));
}
