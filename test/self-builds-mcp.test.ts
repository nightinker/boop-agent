import { describe, expect, it } from "vitest";
import { ago, formatBuild, formatList, lastLines, type BuildRecord } from "../server/mcp/self-builds-view.js";

const now = 10_000_000;
const min = 60_000;
const build = (id: string, status: BuildRecord["status"], startedMinAgo: number, extra: Partial<BuildRecord> = {}): BuildRecord => ({
  buildId: id,
  status,
  request: `Request for ${id}`,
  createdAt: now - startedMinAgo * min,
  updatedAt: now - min,
  ...extra,
});

describe("listing self-builds", () => {
  it("puts the running build first with its latest activity, then the queue in order, then the rest", () => {
    const text = formatList(
      {
        recent: [
          build("done1", "shipped", 90, { prUrl: "https://github.com/acme/boop/pull/7" }),
          build("run1", "coding", 5, { activity: "phase: coding\nEdit server/foo.ts" }),
          build("q2", "queued", 2),
        ],
        queued: [build("q2", "queued", 2), build("q1", "queued", 3)],
      },
      { now },
    );
    expect(text.indexOf("Running (1)")).toBeLessThan(text.indexOf("Queued"));
    expect(text.indexOf("Queued")).toBeLessThan(text.indexOf("Recent"));
    expect(text).toContain("latest: Edit server/foo.ts");
    expect(text.indexOf("q1 ·")).toBeLessThan(text.indexOf("q2 ·"));
    expect(text.match(/q2 ·/g)).toHaveLength(1);
    expect(text).toContain("pull/7");
  });

  it("says plainly when nothing is running", () => {
    expect(formatList({ recent: [build("a", "shipped", 10)], queued: [] }, { now })).toMatch(/^Nothing is running right now\./);
    expect(formatList({ recent: [build("a", "shipped", 10)], queued: [] }, { now, filter: "running" })).toBe(
      "No self-builds are running right now.",
    );
    expect(formatList({ recent: [], queued: [] }, { now })).toBe("No self-builds yet.");
  });

  it("filters by status and limits finished builds", () => {
    const recent = [build("f1", "failed", 1), build("s1", "shipped", 2), build("f2", "failed", 3)];
    const failed = formatList({ recent, queued: [] }, { now, filter: "failed" });
    expect(failed).toContain("f1");
    expect(failed).toContain("f2");
    expect(failed).not.toContain("s1");
    expect(formatList({ recent, queued: [] }, { now, limit: 1 })).not.toContain("s1");
  });
});

describe("one self-build", () => {
  it("shows what's needed to understand a failure", () => {
    const text = formatBuild(
      build("x1", "rolled_back", 30, {
        branch: "boop/self-build-x1",
        worktreePath: "/tmp/wt-x1",
        prUrl: "https://github.com/acme/boop/pull/9",
        testsPassed: false,
        testOutput: "ok 1\nFAIL test/a.test.ts",
        error: "health check timed out",
        startupLogPath: "/tmp/startup-x1.log",
        startupLogTail: "Cannot find module 'esbuild'",
        activity: "phase: restarting",
      }),
      { restartLogTail: "rolling back", worktreeHere: false, queuePosition: null },
      now,
    );
    for (const part of [
      "Build x1: rolled_back",
      "Worktree: /tmp/wt-x1 (not on this machine)",
      "Checks: failed",
      "FAIL test/a.test.ts",
      "health check timed out",
      "Failed start log (/tmp/startup-x1.log):",
      "Cannot find module 'esbuild'",
      "Restart log (last 20 lines):",
      "Request for x1",
    ]) {
      expect(text).toContain(part);
    }
  });

  it("shows a queued build's place in line and leaves out empty sections", () => {
    const text = formatBuild(build("q1", "queued", 1), { queuePosition: 2 }, now);
    expect(text).toContain("Queue position: 2.");
    expect(text).not.toContain("Error:");
    expect(text).not.toContain("Checks:");
  });
});

describe("helpers", () => {
  it("formats ages and keeps the last lines", () => {
    expect(ago(now - 30_000, now)).toBe("30s ago");
    expect(ago(now - 5 * min, now)).toBe("5m ago");
    expect(ago(now - 125 * min, now)).toBe("2h 5m ago");
    expect(ago(now - 3 * 24 * 60 * min, now)).toBe("3d ago");
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(lastLines(undefined, 2)).toBe("");
  });
});
