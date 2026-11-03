import { createWebTestMcp, createWebTestTools, WEBTEST_INTEGRATION } from "../webtest/tools.js";
import { registerIntegration } from "./registry.js";

/**
 * Headless web app testing. Unlike the "browser" integration (the owner's
 * visible Chrome profile, Mac only), this launches a throwaway headless
 * Chromium per run, so it works wherever Boop runs, including the Linux
 * server. If Chromium isn't installed, the tools say how to install it.
 * Set BOOP_WEBTEST_DISABLED=1 to turn it off.
 */
export function registerWebTestIntegration(env: NodeJS.ProcessEnv = process.env): boolean {
  if (/^(1|true|yes)$/i.test(env.BOOP_WEBTEST_DISABLED ?? "")) {
    console.log("[webtest] disabled by BOOP_WEBTEST_DISABLED");
    return false;
  }
  registerIntegration({
    name: WEBTEST_INTEGRATION,
    description:
      "Headless browser testing of web apps (staging by default): run test plans step by step with screenshots, console/network errors, saved login sessions, plus GitHub CI and repo test-suite results. Works on the Mac and the Linux server.",
    createServer: async () => createWebTestMcp(),
    createTools: async () => createWebTestTools(),
  });
  return true;
}
