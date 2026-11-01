import { describe, expect, it } from "vitest";
import {
  activityTail,
  currentBuildId,
  dashboardBuilds,
  elapsedMs,
  failureDetails,
  formatAgo,
  formatDuration,
  prNumber,
  STATUS_META,
  type SelfBuildRow,
  type SelfBuildStatus,
} from "../debug/src/lib/selfBuilds.js";
import { ACTIVITY_LINES, appendActivity, describeToolUse } from "../server/self-build/plan.js";

function build(buildId: string, status: SelfBuildStatus, createdAt: number, extra: Partial<SelfBuildRow> = {}): SelfBuildRow {
  return { buildId, status, request: `request ${buildId}`, createdAt, updatedAt: createdAt + 1000, ...extra };
}

describe("self-builds page ordering", () => {
  it("puts the active build first, then the queue in line order, then the rest newest first", () => {
    const recent = [
      build("q2", "queued", 500),
      build("q1", "queued", 400),
      build("coding", "coding", 300),
      build("shipped", "shipped", 200),
      build("failed", "failed", 100),
    ];
    // The queue can hold builds older than the recent window.
    const queued = [build("q0", "queued", 50), build("q1", "queued", 400), build("q2", "queued", 500)];
    const rows = dashboardBuilds(recent, queued);
    expect(rows.map((b) => b.buildId)).toEqual(["coding", "q0", "q1", "q2", "shipped", "failed"]);
    expect(rows.filter((b) => b.status === "queued").map((b) => b.queuePosition)).toEqual([1, 2, 3]);
    expect(rows.find((b) => b.buildId === "coding")?.queuePosition).toBeUndefined();
  });

  it("highlights the coding build, or another active one", () => {
    expect(currentBuildId([build("a", "shipping", 1), build("b", "coding", 2)])).toBe("b");
    expect(currentBuildId([build("a", "pr_open", 1), build("b", "testing", 2)])).toBe("b");
    expect(currentBuildId([build("a", "pr_open", 1), build("b", "queued", 2)])).toBeNull();
  });

  it("labels every status", () => {
    expect(STATUS_META.pr_open.label).toBe("PR open");
    expect(STATUS_META.rolled_back.label).toBe("Rolled back");
    expect(STATUS_META.queued.tone).toBe("waiting");
  });
});

describe("self-build timing", () => {
  it("counts up for running and queued builds, and freezes when finished", () => {
    const now = 10 * 60_000;
    expect(elapsedMs(build("a", "coding", 0), now)).toBe(now);
    expect(elapsedMs(build("a", "queued", 0), now)).toBe(now);
    expect(elapsedMs(build("a", "shipped", 0, { updatedAt: 90_000 }), now)).toBe(90_000);
  });

  it("formats durations", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(3_725_000)).toBe("1h 2m");
    expect(formatAgo(10_000)).toBe("just now");
    expect(formatAgo(125_000)).toBe("2m ago");
  });

  it("reads the PR number", () => {
    expect(prNumber("https://github.com/o/r/pull/42")).toBe("42");
    expect(prNumber("https://example.com")).toBeNull();
  });
});

describe("self-build failures", () => {
  it("shows a rollback's failed-start log", () => {
    const details = failureDetails(
      build("a", "rolled_back", 0, { startupLogPath: "/logs/startup-a.log", startupLogTail: "boom\n", activity: "x" }),
    );
    expect(details?.reason).toMatch(/rolled back/);
    expect(details?.logLabel).toContain("/logs/startup-a.log");
    expect(details?.log).toBe("boom");
  });

  it("shows the error and the preserved activity for a failed build", () => {
    const details = failureDetails(build("a", "failed", 0, { error: "tsc failed", activity: "10:00:00 Bash: npx tsc" }));
    expect(details).toEqual({ reason: "tsc failed", logLabel: "Last activity", log: "10:00:00 Bash: npx tsc" });
  });

  it("falls back to check output, and ignores builds that didn't fail", () => {
    expect(failureDetails(build("a", "failed", 0, { testOutput: "1 failed" }))?.log).toBe("1 failed");
    expect(failureDetails(build("a", "failed", 0))?.reason).toBe("No reason was recorded.");
    expect(failureDetails(build("a", "shipped", 0, { error: "old" }))).toBeNull();
  });
});

describe("self-build activity log", () => {
  it("timestamps lines, flattens whitespace and keeps only the newest", () => {
    const at = new Date("2026-11-01T12:34:56Z");
    expect(appendActivity(undefined, "Running\n  tests", at)).toBe("12:34:56 Running tests");
    let log: string | undefined;
    for (let i = 0; i < ACTIVITY_LINES + 5; i++) log = appendActivity(log, `step ${i}`, at);
    const lines = log!.split("\n");
    expect(lines).toHaveLength(ACTIVITY_LINES);
    expect(lines.at(-1)).toBe(`12:34:56 step ${ACTIVITY_LINES + 4}`);
    expect(activityTail(log, 3)).toEqual(lines.slice(-3));
    expect(appendActivity(undefined, "x".repeat(500), at).length).toBeLessThan(220);
  });

  it("describes the coding agent's tool calls in one line", () => {
    expect(describeToolUse("Bash", { command: "npx tsc --noEmit" })).toBe("Bash: npx tsc --noEmit");
    expect(describeToolUse("Edit", { file_path: "/wt/server/x.ts", old_string: "a" }, "/wt")).toBe("Edit: server/x.ts");
    expect(describeToolUse("Grep", { pattern: "selfBuilds" })).toBe("Grep: selfBuilds");
    expect(describeToolUse("mcp__boop-self-build__list_self_builds", {})).toBe("list_self_builds");
    expect(describeToolUse("TodoWrite", null)).toBe("TodoWrite");
  });
});
