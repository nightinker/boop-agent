// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { readdirSync, readFileSync } from "node:fs";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { takeMatching } from "./demoMode";

const modules = import.meta.glob("./**/*.ts");
const newTest = () => convexTest(schema, modules);

async function* counted<T>(rows: T[], seen: { n: number }) {
  for (const row of rows) {
    seen.n++;
    yield row;
  }
}

describe("takeMatching", () => {
  it("stops reading once it has enough matches", async () => {
    const seen = { n: 0 };
    const rows = Array.from({ length: 5000 }, (_, i) => i);
    const out = await takeMatching(counted(rows, seen), () => true, 50);
    expect(out).toHaveLength(50);
    expect(seen.n).toBe(50);
  });

  it("skips rows that don't match and stops at the scan cap", async () => {
    const seen = { n: 0 };
    const rows = Array.from({ length: 100 }, (_, i) => i);
    expect(await takeMatching(counted(rows, seen), (i) => i % 2 === 0, 3)).toEqual([0, 2, 4]);
    seen.n = 0;
    expect(await takeMatching(counted(rows, seen), () => false, 3, 10)).toEqual([]);
    expect(seen.n).toBe(10);
  });
});

describe("dashboard live queries", () => {
  it("lists only real rows, newest first, when demo rows are mixed in", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      for (let i = 0; i < 6; i++) {
        await ctx.db.insert("consolidationRuns", {
          runId: i % 2 ? `demo:run-${i}` : `run-${i}`,
          trigger: "manual",
          status: "completed",
          proposalsCount: 0,
          mergedCount: 0,
          prunedCount: 0,
          startedAt: i,
        });
      }
    });
    const runs = await t.query(api.consolidation.listRunsForDashboard, { limit: 2 });
    expect(runs.map((r) => r.runId)).toEqual(["run-4", "run-2"]);
  });

  it("demo status reads saved counts, kept in step by setMode", async () => {
    const t = newTest();
    expect(await t.query(api.demo.status, {})).toMatchObject({ enabled: false, seeded: false, total: 0 });
    await t.mutation(api.demo.setMode, { enabled: true });
    const on = await t.query(api.demo.status, {});
    expect(on.enabled).toBe(true);
    expect(on.seeded).toBe(true);
    expect(on.total).toBeGreaterThan(0);
    await t.mutation(api.demo.setMode, { enabled: false });
    expect(await t.query(api.demo.status, {})).toMatchObject({ enabled: false, seeded: false, total: 0 });
  });
});

// Guard: a live query that reads thousands of rows re-runs on every write and
// drove most of a database bill. Lists use takeMatching; only demo seeding and
// the cached metrics (refreshed at most every 30 minutes) may scan this much.
describe("no big scans in live queries", () => {
  it("only demo.ts and dashboard.ts use take(DEMO_SCAN_LIMIT)", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => !["demo.ts", "dashboard.ts"].includes(f))
      .filter((f) => {
        const code = readFileSync(dir + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        return /\.take\(\s*DEMO_SCAN_LIMIT\s*\)|\.collect\(\)/.test(code);
      })
      .sort();
    expect(offenders).toEqual(KNOWN_COLLECTS);
  });
});

// Existing .collect() calls on small, index-filtered sets. Add to this list
// only after checking the set stays small; prefer take(n) or takeMatching.
const KNOWN_COLLECTS: string[] = ["skills.ts", "slackMentions.ts"];
