// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

function text(content: string) {
  return {
    handle: `h-${content}`,
    conversationId: "sms:user@example.com",
    fromNumber: "user@example.com",
    content,
    mediaUrls: [],
    source: "webhook" as const,
    receivedAt: Date.now(),
  };
}

describe("inbound answer slots", () => {
  it("hands out texts only while a slot is free", async () => {
    const t = convexTest(schema, modules);
    for (const c of ["one", "two", "three"]) await t.mutation(api.inboundMessages.enqueue, text(c));
    const conversationId = "sms:user@example.com";

    const first = await t.mutation(api.inboundMessages.claimNext, { conversationId, maxConcurrent: 2 });
    const second = await t.mutation(api.inboundMessages.claimNext, { conversationId, maxConcurrent: 2 });
    expect([first?.content, second?.content]).toEqual(["one", "two"]);
    expect(await t.mutation(api.inboundMessages.claimNext, { conversationId, maxConcurrent: 2 })).toBeNull();
    expect(await t.mutation(api.inboundMessages.claimQueued, { conversationId, maxConcurrent: 2 })).toEqual([]);

    const state = await t.query(api.inboundMessages.waiting, { conversationId });
    expect(state).toMatchObject({ busy: true, processing: 2 });
    expect(state.queued.map((q) => q.handle)).toEqual(["h-three"]);

    await t.mutation(api.inboundMessages.finish, { id: first!._id, status: "done" });
    expect((await t.mutation(api.inboundMessages.claimNext, { conversationId, maxConcurrent: 2 }))?.content).toBe("three");
  });

  it("defaults to one at a time when no limit is passed", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.inboundMessages.enqueue, text("one"));
    await t.mutation(api.inboundMessages.enqueue, text("two"));
    const conversationId = "sms:user@example.com";
    expect((await t.mutation(api.inboundMessages.claimNext, { conversationId }))?.content).toBe("one");
    expect(await t.mutation(api.inboundMessages.claimNext, { conversationId })).toBeNull();
  });

  it("lets only one parallel turn send a draft", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.drafts.create, {
      draftId: "draft_1",
      conversationId: "sms:user@example.com",
      kind: "gmail.reply",
      summary: "Reply to example",
      payload: "{}",
    });
    const [a, b] = await Promise.all([
      t.mutation(api.drafts.decide, { draftId: "draft_1", status: "sent" }),
      t.mutation(api.drafts.decide, { draftId: "draft_1", status: "sent" }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await t.mutation(api.drafts.decide, { draftId: "draft_1", status: "rejected" })).toBeNull();
  });
});
