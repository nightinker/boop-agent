import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

// Render the Self-builds page with hand-made rows instead of a live Convex query.
let rows: unknown;
vi.mock("convex/react", () => ({
  useQuery: () => rows,
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
}));

const { api } = await import("../convex/_generated/api.js");
const { SelfBuildsPanel } = await import("../debug/src/components/SelfBuildsPanel.js");

function row(buildId: string, status: string) {
  const now = Date.now();
  return { buildId, status, request: `request ${buildId}`, createdAt: now - 60_000, updatedAt: now };
}

function render(initialFilter?: Parameters<typeof SelfBuildsPanel>[0]["initialFilter"]) {
  return renderToStaticMarkup(createElement(SelfBuildsPanel, { isDark: false, initialFilter }));
}

function tab(html: string, id: string): string {
  return html.match(new RegExp(`<button[^>]*data-filter="${id}"[^>]*>.*?</button>`))?.[0] ?? "";
}

afterEach(() => {
  rows = undefined;
});

describe("self-builds status filter tabs", () => {
  it("reads the dashboard query", () => {
    expect(getFunctionName(api.selfBuilds.forDashboard)).toBe("selfBuilds:forDashboard");
  });

  it("defaults to All and shows a count on every tab", () => {
    rows = { recent: [row("a", "coding"), row("b", "shipped"), row("c", "shipped")], queued: [row("q", "queued")] };
    const html = render();
    expect(tab(html, "all")).toContain('aria-selected="true"');
    expect(tab(html, "all")).toMatch(/All<span[^>]*>4<\/span>/);
    expect(tab(html, "shipped")).toMatch(/Shipped<span[^>]*>2<\/span>/);
    expect(tab(html, "running")).toMatch(/Running<span[^>]*>1<\/span>/);
    expect(tab(html, "cancelled")).toMatch(/Cancelled<span[^>]*>0<\/span>/);
    for (const id of ["a", "b", "c", "q"]) expect(html).toContain(`request ${id}`);
  });

  it("shows only the matching builds for a filter", () => {
    rows = { recent: [row("a", "coding"), row("b", "shipped")], queued: [row("q", "queued")] };
    const html = render("queued");
    expect(tab(html, "queued")).toContain('aria-selected="true"');
    expect(tab(html, "all")).toContain('aria-selected="false"');
    expect(html).toContain("request q");
    expect(html).not.toContain("request a");
    expect(html).not.toContain("request b");
  });

  it("shows an empty state, with the tabs still there, when nothing matches", () => {
    rows = { recent: [row("b", "shipped")], queued: [] };
    const html = render("failed");
    expect(html).toContain("No failed builds in this list.");
    expect(html).toContain("Show all builds");
    expect(html).toContain('role="tablist"');
    expect(html).not.toContain("request b");
  });
});
