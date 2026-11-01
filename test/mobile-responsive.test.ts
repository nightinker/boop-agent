import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

// The dashboard reads everything through Convex; render it with no data loaded
// unless a test hands in rows (keyed by function name, e.g. "selfBuilds:forDashboard").
const queryResults = new Map<string, unknown>();
vi.mock("convex/react", () => ({
  useQuery: (ref: any) => queryResults.get(getFunctionName(ref)),
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
}));
// The memory graph's canvas library touches `window` on import.
vi.mock("react-force-graph-2d", () => ({ default: () => null }));

const { api } = await import("../convex/_generated/api.js");
const { App } = await import("../debug/src/App.js");
const { SelfBuildsPanel } = await import("../debug/src/components/SelfBuildsPanel.js");
const { MOBILE_BREAKPOINT_PX, MOBILE_MEDIA_QUERY, isMobileViewport, navDrawerClasses } = await import(
  "../debug/src/lib/mobileNav.js"
);

const ROOT = path.resolve(__dirname, "..");

/** Class tokens of the first element whose opening tag matches `marker`. */
function classesOf(html: string, marker: RegExp): string[] {
  const tag = html.match(new RegExp(`<[a-z]+[^>]*${marker.source}[^>]*>`));
  expect(tag, `no element matching ${marker}`).not.toBeNull();
  const cls = tag![0].match(/class="([^"]*)"/);
  return cls ? cls[1].split(/\s+/).filter(Boolean) : [];
}

describe("phone breakpoint", () => {
  it("matches Tailwind's md breakpoint", () => {
    expect(MOBILE_BREAKPOINT_PX).toBe(768);
    expect(MOBILE_MEDIA_QUERY).toBe("(max-width: 767px)");
    expect(isMobileViewport(400)).toBe(true);
    expect(isMobileViewport(767)).toBe(true);
    expect(isMobileViewport(768)).toBe(false);
    expect(isMobileViewport(1440)).toBe(false);
  });

  it("only adds phone-only classes to the sidebar, so desktop is unchanged", () => {
    for (const open of [true, false]) {
      const tokens = navDrawerClasses(open).split(" ");
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.every((t) => t.startsWith("max-md:"))).toBe(true);
    }
    expect(navDrawerClasses(false)).toContain("max-md:hidden");
    expect(navDrawerClasses(true)).not.toContain("max-md:hidden");
    expect(navDrawerClasses(true)).toContain("max-md:fixed");
  });
});

describe("dashboard shell on a phone", () => {
  const html = renderToStaticMarkup(createElement(App));

  it("collapses the sidebar into a closed drawer, keeping its desktop width", () => {
    const nav = classesOf(html, /id="boop-nav"/);
    expect(nav).toContain("w-[244px]");
    expect(nav).toContain("max-md:hidden");
    expect(nav).toContain("max-md:fixed");
  });

  it("shows a phone-only menu button that controls the drawer", () => {
    const menu = classesOf(html, /aria-label="Open menu"/);
    expect(menu).toContain("md:hidden");
    expect(menu).toEqual(expect.arrayContaining(["h-11", "w-11"]));
    expect(html).toMatch(/aria-label="Open menu"[^>]*aria-controls="boop-nav"|aria-controls="boop-nav"[^>]*aria-label="Open menu"/);
    expect(html).toContain('aria-expanded="false"');
  });

  it("gives nav items a 44px tap target on phones only", () => {
    const item = classesOf(html, /aria-current="page"/);
    expect(item).toContain("h-8");
    expect(item).toContain("max-md:h-11");
  });

  it("drops the main card's rounded desktop frame on phones", () => {
    const card = classesOf(html, /class="relative flex flex-1 min-w-0 flex-col/);
    expect(card).toEqual(expect.arrayContaining(["rounded-l-[20px]", "max-md:rounded-none", "max-md:border-0"]));
  });
});

describe("self-builds page on a phone", () => {
  it("wraps long build ids and gives the expand toggles a bigger tap target", () => {
    const now = Date.now();
    queryResults.set(getFunctionName(api.selfBuilds.forDashboard), {
      recent: [
        {
          buildId: "build-with-a-very-long-identifier-that-would-overflow",
          status: "failed",
          request: "x".repeat(200),
          createdAt: now - 60_000,
          updatedAt: now,
          error: "checks failed",
          testOutput: "FAIL test/example.test.ts\n".repeat(5),
        },
      ],
      queued: [],
    });
    try {
      const html = renderToStaticMarkup(createElement(SelfBuildsPanel, { isDark: true }));
      expect(classesOf(html, /class="mono text-\[11px\]/)).toContain("max-md:break-all");
      const toggle = html.match(/<button[^>]*>Show full request<\/button>/);
      expect(toggle?.[0]).toContain("max-md:min-h-10");
    } finally {
      queryResults.delete(getFunctionName(api.selfBuilds.forDashboard));
    }
  });
});

describe("phone stylesheet", () => {
  const css = readFileSync(path.join(ROOT, "debug/src/styles.css"), "utf8");
  const start = css.indexOf(`@media ${MOBILE_MEDIA_QUERY}`);

  it("keeps every phone-only rule inside the phone media query", () => {
    expect(start).toBeGreaterThan(-1);
    const phone = css.slice(start);
    expect(phone).toMatch(/\.view-shell\s*\{[^}]*padding-inline:\s*1rem/);
    expect(phone).toMatch(/font-size:\s*16px/);
    expect(phone).toMatch(/\.toggle-switch::after/);
    expect(phone).toMatch(/\.view-shell pre[\s\S]*overflow-x:\s*auto/);
    // None of these leak into the desktop stylesheet above the query.
    const desktop = css.slice(0, start);
    expect(desktop).not.toMatch(/padding-inline:\s*1rem/);
    expect(desktop).not.toMatch(/touch-hit|toggle-switch::after/);
  });

  it("keeps the viewport meta so phones render at device width", () => {
    const index = readFileSync(path.join(ROOT, "debug/index.html"), "utf8");
    expect(index).toContain('name="viewport" content="width=device-width, initial-scale=1.0"');
  });
});
