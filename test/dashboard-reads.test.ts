import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

// Convex bills every re-run of a live query for the documents it reads. The
// dashboard shell stays open for hours, so it must never hold a live
// subscription to a query that scans whole tables.
const queryResults = new Map<string, unknown>();
const live = new Set<string>();
vi.mock("convex/react", () => ({
  useQuery: (ref: any) => {
    live.add(getFunctionName(ref));
    return queryResults.get(getFunctionName(ref));
  },
  useConvex: () => ({ query: async (ref: any) => queryResults.get(getFunctionName(ref)) }),
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
}));
vi.mock("react-force-graph-2d", () => ({ default: () => null }));

const { api } = await import("../convex/_generated/api.js");
const { App } = await import("../debug/src/App.js");
const { DashboardPanel } = await import("../debug/src/components/DashboardPanel.js");

const HEAVY = [
  api.memoryRecords.countsByTier,
  api.agents.listForDashboard,
  api.selfBuilds.forDashboard,
  api.dashboard.metrics,
].map((ref) => getFunctionName(ref));

describe("dashboard reads", () => {
  it("keeps no live subscription to whole-table scans in the shell or the stats page", () => {
    live.clear();
    renderToStaticMarkup(createElement(App));
    renderToStaticMarkup(createElement(DashboardPanel, { isDark: true }));
    for (const name of HEAVY) expect(live, name).not.toContain(name);
  });

  it("shows the sidebar badges from the slim index queries", () => {
    queryResults.set(getFunctionName(api.agents.activeCount), 2);
    queryResults.set(getFunctionName(api.selfBuilds.inProgress), [
      { buildId: "b1", status: "coding", createdAt: 1 },
      { buildId: "b2", status: "queued", createdAt: 2 },
    ]);
    try {
      const html = renderToStaticMarkup(createElement(App));
      expect(live).toContain(getFunctionName(api.agents.activeCount));
      expect(live).toContain(getFunctionName(api.selfBuilds.inProgress));
      // Both badges render their counts next to the nav items.
      expect(html).toMatch(/Agents[\s\S]*?>2</);
      expect(html).toMatch(/Self-builds[\s\S]*?>2</);
    } finally {
      queryResults.clear();
    }
  });
});
