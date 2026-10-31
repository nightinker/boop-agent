import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { memoryInboundStore } from "./memory-inbound-store.js";

const memory = vi.hoisted(() => ({ current: null as ReturnType<typeof memoryInboundStore> | null }));
const turns = vi.hoisted(() => ({ log: [] as string[], active: 0, maxActive: 0 }));

vi.mock("../server/inbound-store.js", async () => {
  const { memoryInboundStore } = await import("./memory-inbound-store.js");
  memory.current = memoryInboundStore();
  return { convexInboundStore: memory.current.store };
});
vi.mock("../server/convex-client.js", () => ({ convex: { mutation: vi.fn(async () => null), query: vi.fn() } }));
vi.mock("../server/broadcast.js", () => ({ broadcast: vi.fn() }));
vi.mock("../server/scripted-demo-replies.js", () => ({ maybeHandleScriptedDemoReply: vi.fn(async () => false) }));
vi.mock("../server/interaction-agent.js", () => ({
  handleUserMessageWithAttachments: vi.fn(async ({ content }: { content: string }) => {
    turns.active++;
    turns.maxActive = Math.max(turns.maxActive, turns.active);
    turns.log.push(`start ${content}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    turns.log.push(`end ${content}`);
    turns.active--;
    return { reply: `re: ${content}`, attachments: [] };
  }),
}));

const { createSendblueRouter, inboundQueue } = await import("../server/sendblue.js");
const { deriveSendblueWebhookSecret } = await import("../server/sendblue-webhook-auth.js");

let server: Server;
let base = "";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.SENDBLUE_API_SECRET = "test-secret";
  process.env.SENDBLUE_API_KEY = "test-key";
  process.env.SENDBLUE_FROM_NUMBER = "+15550000000";
  // Outbound Sendblue calls (replies, typing) succeed without leaving the machine.
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) =>
    String(url).startsWith(base) ? realFetch(url, init) : Promise.resolve(new Response("{}", { status: 200 })),
  );
  const app = express();
  app.use(express.json());
  app.use("/sendblue", createSendblueRouter());
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
});

function post(body: Record<string, unknown>, secret = deriveSendblueWebhookSecret("test-secret")) {
  return realFetch(`${base}/sendblue/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "sb-signing-secret": secret },
    body: JSON.stringify(body),
  });
}

const textFrom = (handle: string, content: string) => ({
  message_handle: handle,
  content,
  from_number: "+15551234567",
  is_outbound: false,
});

describe("Sendblue webhook with the inbound queue", () => {
  it("rejects requests without the signing secret", async () => {
    expect((await post(textFrom("x", "hi"), "wrong")).status).toBe(401);
  });

  it("answers two quick texts one after the other, in order", async () => {
    const [a, b] = await Promise.all([post(textFrom("h1", "first text")), post(textFrom("h2", "second text"))]);
    expect(await a.json()).toEqual({ ok: true });
    expect(await b.json()).toEqual({ ok: true });

    await inboundQueue.drain("sms:+15551234567");

    expect(turns.maxActive).toBe(1);
    expect(turns.log).toEqual(["start first text", "end first text", "start second text", "end second text"]);
    expect(memory.current!.rows.map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("ignores a duplicate delivery of a text it already has", async () => {
    const res = await post(textFrom("h1", "first text"));
    expect(await res.json()).toEqual({ ok: true, deduped: true });
    expect(memory.current!.rows).toHaveLength(2);
  });

  it("skips outbound echoes", async () => {
    const res = await post({ ...textFrom("h3", "my own reply"), is_outbound: true });
    expect(await res.json()).toEqual({ ok: true, skipped: true });
  });
});
