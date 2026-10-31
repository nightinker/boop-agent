import { createBrowserMcp, createBrowserTools } from "../browser/tools.js";
import { getBrowserSettings } from "../runtime-config.js";
import { isLocalBrowserSupported } from "../platform-support.js";
import { registerIntegration } from "./registry.js";

export function registerBrowserIntegration(
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isLocalBrowserSupported(platform)) {
    console.log(`[browser] skipped local browser integration (macOS only; running on ${platform})`);
    return false;
  }
  registerIntegration({
    name: "browser",
    description:
      "Optional local Patchright Chrome/Chromium browser with a persistent profile. Use as a fallback for sites without native integrations, login-required services, visual workflows, or bot-wall-sensitive pages.",
    isEnabled: async () => (await getBrowserSettings()).enabled,
    createServer: async () => createBrowserMcp(),
    createTools: async () => createBrowserTools(),
  });
  console.log("[browser] registered local Patchright browser integration");
  return true;
}
