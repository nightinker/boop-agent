import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

// The Mac and the server share one queue. These run the real mutations to
// check that a queued build is only ever started once, and that a copy
// restarting only fails the builds it was running.

const modules = (import.meta as unknown as { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob(
  "../convex/**/*.ts",
);

const SERVER = "linux:test-server";
const MAC = "darwin:test-mac";

async function enqueue(t: ReturnType<typeof convexTest>, buildId: string, extra: Record<string, unknown> = {}) {
  return t.mutation(api.selfBuilds.enqueue, { buildId, conversationId: "sms:+15550000000", request: `build ${buildId}`, ...extra });
}

describe("the self-build queue across copies", () => {
  it("hands a queued build to only one copy when both ask at once", async () => {
    const t = convexTest(schema, modules);
    await enqueue(t, "b1", { forceQueue: true });

    const [mac, server] = await Promise.all([
      t.mutation(api.selfBuilds.claimNextQueued, { runner: MAC }),
      t.mutation(api.selfBuilds.claimNextQueued, { runner: SERVER }),
    ]);

    const winners = [mac, server].filter(Boolean);
    expect(winners).toHaveLength(1);
    const row = await t.query(api.selfBuilds.get, { buildId: "b1" });
    expect(row?.status).toBe("coding");
    expect(row?.runner).toBe(mac ? MAC : SERVER);
  });

  it("queues a second request while another copy is coding", async () => {
    const t = convexTest(schema, modules);
    expect((await enqueue(t, "b1", { runner: SERVER })).status).toBe("coding");
    const second = await enqueue(t, "b2", { runner: MAC });
    expect(second).toMatchObject({ status: "queued", blockedBy: { buildId: "b1", status: "coding" } });
    expect(await t.mutation(api.selfBuilds.claimNextQueued, { runner: MAC })).toBeNull();
  });

  it("a restart fails only the restarting copy's builds", async () => {
    const t = convexTest(schema, modules);
    await enqueue(t, "server-build", { runner: SERVER });
    await enqueue(t, "mac-build", { forceQueue: true });
    // Pretend both are running (the queue normally allows one at a time).
    await t.mutation(api.selfBuilds.update, { buildId: "mac-build", status: "coding", runner: MAC });

    const failed = await t.mutation(api.selfBuilds.failInterrupted, { runner: SERVER, claimsUnowned: false });

    expect(failed.map((b) => b.buildId)).toEqual(["server-build"]);
    expect((await t.query(api.selfBuilds.get, { buildId: "mac-build" }))?.status).toBe("coding");
  });

  it("the Mac also fails builds from before runners were recorded", async () => {
    const t = convexTest(schema, modules);
    await enqueue(t, "old-build");
    expect((await t.query(api.selfBuilds.get, { buildId: "old-build" }))?.runner).toBeUndefined();
    expect(await t.mutation(api.selfBuilds.failInterrupted, { runner: SERVER, claimsUnowned: false })).toEqual([]);
    const failed = await t.mutation(api.selfBuilds.failInterrupted, { runner: MAC, claimsUnowned: true });
    expect(failed.map((b) => b.buildId)).toEqual(["old-build"]);
  });
});
