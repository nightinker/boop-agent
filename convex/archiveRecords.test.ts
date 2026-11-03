// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
const newTest = () => convexTest(schema, modules);

const record = (id: number, extra: Record<string, unknown> = {}) => ({
  sourceId: `claude-mem:observation:${id}`,
  source: "claude-mem",
  kind: "observation",
  project: "demo-app",
  title: `Finding ${id}`,
  content: `[demo-app · discovery] Finding ${id} about webhook retries`,
  type: "discovery",
  occurredAt: 1_700_000_000_000 + id,
  contentHash: `hash-${id}`,
  ...extra,
});

describe("archiveRecords.importBatch", () => {
  it("inserts new records and counts them per source and kind", async () => {
    const t = newTest();
    const res = await t.mutation(api.archiveRecords.importBatch, {
      records: [record(1), record(2), record(3, { kind: "summary" })],
    });
    expect(res).toEqual({ inserted: 3, updated: 0, unchanged: 0 });
    expect(await t.query(api.archiveRecords.counts, {})).toEqual({
      "claude-mem:observation": 2,
      "claude-mem:summary": 1,
    });
  });

  it("writes nothing when the same batch is imported again", async () => {
    const t = newTest();
    await t.mutation(api.archiveRecords.importBatch, { records: [record(1), record(2)] });
    const again = await t.mutation(api.archiveRecords.importBatch, { records: [record(1), record(2)] });
    expect(again).toEqual({ inserted: 0, updated: 0, unchanged: 2 });
    const rows = await t.run((ctx) => ctx.db.query("archiveRecords").collect());
    expect(rows).toHaveLength(2);
    expect(await t.query(api.archiveRecords.counts, {})).toEqual({ "claude-mem:observation": 2 });
  });

  it("updates a record whose content changed, without a duplicate", async () => {
    const t = newTest();
    await t.mutation(api.archiveRecords.importBatch, { records: [record(1)] });
    const res = await t.mutation(api.archiveRecords.importBatch, {
      records: [record(1, { content: "rewritten", contentHash: "hash-1b" })],
    });
    expect(res).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const rows = await t.run((ctx) => ctx.db.query("archiveRecords").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("rewritten");
  });

  it("keeps the first of two records with the same id in one batch", async () => {
    const t = newTest();
    const res = await t.mutation(api.archiveRecords.importBatch, {
      records: [record(1), record(1, { contentHash: "other" })],
    });
    expect(res).toEqual({ inserted: 1, updated: 0, unchanged: 1 });
  });

  it("refuses a batch over the limit", async () => {
    const t = newTest();
    const records = Array.from({ length: 201 }, (_, i) => record(i));
    await expect(t.mutation(api.archiveRecords.importBatch, { records })).rejects.toThrow(/at most 200/);
  });
});

describe("archiveRecords.search", () => {
  it("finds records by keyword and filters by project and kind", async () => {
    const t = newTest();
    await t.mutation(api.archiveRecords.importBatch, {
      records: [
        record(1, { content: "stripe webhook signature check failed" }),
        record(2, { content: "stripe webhook retries", project: "other-app" }),
        record(3, { content: "stripe webhook summary", kind: "summary" }),
        record(4, { content: "unrelated dashboard css" }),
      ],
    });
    const all = await t.query(api.archiveRecords.search, { query: "stripe webhook" });
    expect(all.map((r) => r.sourceId).sort()).toEqual([
      "claude-mem:observation:1",
      "claude-mem:observation:2",
      "claude-mem:observation:3",
    ]);
    const byProject = await t.query(api.archiveRecords.search, { query: "stripe", project: "other-app" });
    expect(byProject.map((r) => r.sourceId)).toEqual(["claude-mem:observation:2"]);
    const byKind = await t.query(api.archiveRecords.search, { query: "stripe", kind: "summary" });
    expect(byKind.map((r) => r.sourceId)).toEqual(["claude-mem:observation:3"]);
  });

  it("returns nothing for an empty query", async () => {
    const t = newTest();
    await t.mutation(api.archiveRecords.importBatch, { records: [record(1)] });
    expect(await t.query(api.archiveRecords.search, { query: "  " })).toEqual([]);
  });
});
