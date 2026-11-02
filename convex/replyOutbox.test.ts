// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

describe("reply outbox", () => {
  it("keeps unsent replies oldest first until they're sent", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.replyOutbox.add, {
      conversationId: "sms:user@example.com",
      toNumber: "user@example.com",
      content: "first",
      error: "fetch failed",
    });
    await t.mutation(api.replyOutbox.add, {
      conversationId: "sms:user@example.com",
      toNumber: "user@example.com",
      content: "second",
    });
    expect((await t.query(api.replyOutbox.pending, {})).map((r) => r.content)).toEqual(["first", "second"]);

    await t.mutation(api.replyOutbox.noteAttempt, { id: first, error: "still down" });
    expect((await t.query(api.replyOutbox.pending, {}))[0]).toMatchObject({ attempts: 1, lastError: "still down" });

    await t.mutation(api.replyOutbox.remove, { id: first });
    await t.mutation(api.replyOutbox.remove, { id: first }); // already gone: no error
    expect((await t.query(api.replyOutbox.pending, {})).map((r) => r.content)).toEqual(["second"]);
  });
});
