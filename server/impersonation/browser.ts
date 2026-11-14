import { statSync } from "node:fs";
import { MAX_OUTBOUND_IMAGE_BYTES } from "../images/outbound.js";
import { nextBrowserScreenshotPath, withIsolatedBrowserContext } from "../browser/launcher.js";
import { allowedInReadOnlySession, type CapturedPage, type ImpersonatedBrowser } from "./runner.js";

const NAV_TIMEOUT_MS = 30_000;

/**
 * The real ImpersonatedBrowser: a throwaway Patchright context (the local
 * browser integration's Chrome, never the owner's profile) that blocks every
 * non-GET request, opens the impersonation link, captures each target and is
 * closed with its cookies cleared, whatever happens.
 */
export const patchrightImpersonatedBrowser: ImpersonatedBrowser = async (link, targets, opts) =>
  withIsolatedBrowserContext(async (ctx) => {
    let blockedWrites = 0;
    await ctx.route("**/*", async (route) => {
      if (allowedInReadOnlySession(route.request().method())) {
        await route.continue();
      } else {
        blockedWrites++;
        await route.abort("blockedbyclient");
      }
    });
    const page = await ctx.newPage();
    await page.goto(link, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const landedUrl = page.url();

    const pages: CapturedPage[] = [];
    for (const target of targets) {
      try {
        await page.goto(target, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
        const path = nextBrowserScreenshotPath();
        await page.screenshot({ path, fullPage: opts.fullPage });
        if (opts.fullPage && statSync(path).size > MAX_OUTBOUND_IMAGE_BYTES) {
          // Too big for an iMessage attachment: fall back to the viewport.
          await page.screenshot({ path, fullPage: false });
        }
        pages.push({ target, finalUrl: page.url(), path });
      } catch (err) {
        pages.push({
          target,
          finalUrl: page.url(),
          path: null,
          error: err instanceof Error ? err.message.split("\n")[0] : String(err),
        });
      }
    }
    // Leave nothing behind even if the context somehow outlived us.
    await ctx.clearCookies().catch(() => undefined);
    return { landedUrl, pages, blockedWrites };
  });
