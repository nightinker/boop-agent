import { describe, expect, it } from "vitest";
import { formatBuildList, queuedMessage, shipBlocker } from "../server/self-build/queue.js";

describe("queueing a self-build", () => {
  it("says what it's waiting on and its place in line", () => {
    expect(queuedMessage({ buildId: "b2", position: 1, blockedBy: { buildId: "b1", status: "coding" } })).toBe(
      "Build b1 is still coding, so I queued this as build b2 (next in line). It starts on its own when the builds ahead of it finish, and I'll text you when it does.",
    );
    expect(queuedMessage({ buildId: "b4", position: 3, blockedBy: null })).toContain("(#3 in line)");
  });
});

describe("when shipping has to wait", () => {
  const builds = [
    { buildId: "ship-me", status: "pr_open" as const },
    { buildId: "busy", status: "coding" as const },
  ];

  it("waits for a build that's still coding when shipping restarts Boop", () => {
    expect(shipBlocker(builds, "ship-me", true)).toContain("Build busy is still coding");
  });

  it("lets it ship when shipping only merges", () => {
    expect(shipBlocker(builds, "ship-me", false)).toBeNull();
  });

  it("always waits for another build that's shipping or restarting", () => {
    expect(shipBlocker([{ buildId: "other", status: "restarting" }], "ship-me", false)).toContain(
      "Build other is still restarting",
    );
  });

  it("ignores the build being shipped and finished builds", () => {
    expect(
      shipBlocker(
        [
          { buildId: "ship-me", status: "shipping" },
          { buildId: "done", status: "shipped" },
          { buildId: "later", status: "queued" },
        ],
        "ship-me",
        true,
      ),
    ).toBeNull();
  });
});

describe("listing builds", () => {
  it("shows recent builds, then the queue in order", () => {
    const recent = [
      { buildId: "b3", status: "queued" as const, request: "third" },
      { buildId: "b2", status: "queued" as const, request: "second" },
      { buildId: "b1", status: "coding" as const, request: "first" },
    ];
    const queued = [recent[1]!, recent[0]!];
    expect(formatBuildList(recent, queued)).toBe(
      ["b1 · coding · first", "Queued (2), next first:", "1. b2 · second", "2. b3 · third"].join("\n"),
    );
  });

  it("says so when there are none", () => {
    expect(formatBuildList([], [])).toBe("No self-builds yet.");
  });
});
