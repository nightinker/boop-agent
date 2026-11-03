import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { SpawnOptions, SpawnResult } from "../server/execution-agent.js";
import {
  CompletionUsageLimitError,
  createOrchestratorBridgeRouter,
  MAX_COMPLETE_CHARS,
  parseBridgeCompleteBody,
  parseBridgeSpawnBody,
  type BridgeCompleteRequest,
  type OrchestratorBridgeDeps,
} from "../server/orchestrator-bridge.js";

async function serve(spawn: (opts: SpawnOptions) => Promise<SpawnResult>) {
  const app = express();
  app.use(express.json());
  app.use("/orchestrator", createOrchestratorBridgeRouter({ spawn, integrations: () => ["gmail", "browser"] }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const post = (base: string, body: unknown, signal?: AbortSignal) =>
  fetch(`${base}/orchestrator/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

describe("parseBridgeSpawnBody", () => {
  it("accepts a task with known integrations and dedupes them", () => {
    const r = parseBridgeSpawnBody({ task: " find it ", integrations: ["gmail", "gmail"], name: "n" }, ["gmail"]);
    expect(r).toEqual({ ok: true, value: { task: "find it", integrations: ["gmail"], name: "n" } });
  });

  it("rejects a missing task, bad integrations and unknown integrations", () => {
    expect(parseBridgeSpawnBody({}, []).ok).toBe(false);
    expect(parseBridgeSpawnBody({ task: "x", integrations: "gmail" }, ["gmail"]).ok).toBe(false);
    const r = parseBridgeSpawnBody({ task: "x", integrations: ["slack"] }, ["gmail"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("slack");
  });
});

describe("orchestrator bridge route", () => {
  it("runs the sub-agent and returns its result", async () => {
    const calls: SpawnOptions[] = [];
    const { base, close } = await serve(async (opts) => {
      calls.push(opts);
      return { agentId: "agent_1", status: "completed", result: "done: " + opts.task, attachments: [] };
    });
    try {
      const res = await post(base, { task: "check mail", integrations: ["gmail"], name: "mail" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ agentId: "agent_1", status: "completed", result: "done: check mail" });
      expect(calls[0]).toMatchObject({ task: "check mail", integrations: ["gmail"], name: "mail" });
      expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    } finally {
      await close();
    }
  });

  it("passes the sub-agent's token usage back for the run budget", async () => {
    const usage = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 9000, cacheCreationTokens: 0 };
    const { base, close } = await serve(async () => ({
      agentId: "agent_u",
      status: "completed",
      result: "ok",
      attachments: [],
      usage,
    }));
    try {
      const res = await post(base, { task: "x", integrations: [], conversationId: "sms:1" });
      expect(await res.json()).toEqual({ agentId: "agent_u", status: "completed", result: "ok", usage });
    } finally {
      await close();
    }
  });

  it("tells the sidecar when the sub-agent already retried, so it doesn't retry again", async () => {
    const { base, close } = await serve(async () => ({
      agentId: "agent_3",
      status: "failed",
      result: "TypeError: fetch failed (after 3 automatic retries)",
      attachments: [],
      autoRetries: 3,
    }));
    try {
      const res = await post(base, { task: "x", integrations: [] });
      expect(await res.json()).toMatchObject({ status: "failed", autoRetries: 3 });
    } finally {
      await close();
    }
  });

  it("passes failures through, including usage limits", async () => {
    const { base, close } = await serve(async () => ({
      agentId: "agent_2",
      status: "failed",
      result: "usage limit",
      attachments: [],
      usageLimited: true,
    }));
    try {
      const res = await post(base, { task: "x", integrations: [] });
      expect(await res.json()).toMatchObject({ status: "failed", usageLimited: true });
    } finally {
      await close();
    }
  });

  it("answers 500 when spawning throws and 400 for a bad body", async () => {
    const { base, close } = await serve(async () => {
      throw new Error("convex down");
    });
    try {
      const bad = await post(base, { integrations: [] });
      expect(bad.status).toBe(400);
      const res = await post(base, { task: "x" });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ status: "failed", error: "convex down" });
    } finally {
      await close();
    }
  });

  it("aborts the sub-agent when the caller drops the request", async () => {
    let aborted!: () => void;
    const wasAborted = new Promise<void>((r) => (aborted = r));
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));
    const { base, close } = await serve(
      (opts) =>
        new Promise((resolve) => {
          started();
          opts.signal!.addEventListener("abort", () => {
            aborted();
            resolve({ agentId: "agent_3", status: "cancelled", result: "", attachments: [] });
          });
        }),
    );
    try {
      const ctl = new AbortController();
      const req = post(base, { task: "slow" }, ctl.signal).catch((e) => e);
      await hasStarted;
      ctl.abort();
      await req;
      await wasAborted;
    } finally {
      await close();
    }
  });
});

describe("parseBridgeCompleteBody", () => {
  it("accepts system, messages, max_tokens and purpose", () => {
    const r = parseBridgeCompleteBody({
      system: "sys",
      messages: [{ role: "user", content: "q" }],
      max_tokens: 900,
      purpose: "merger",
    });
    expect(r).toEqual({ ok: true, value: { system: "sys", messages: [{ role: "user", content: "q" }], maxTokens: 900, purpose: "merger" } });
  });

  it("rejects bad bodies", () => {
    expect(parseBridgeCompleteBody({}).ok).toBe(false);
    expect(parseBridgeCompleteBody({ messages: [] }).ok).toBe(false);
    expect(parseBridgeCompleteBody({ messages: [{ role: "system", content: "x" }] }).ok).toBe(false);
    expect(parseBridgeCompleteBody({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] }).ok).toBe(false);
    expect(parseBridgeCompleteBody({ messages: [{ role: "user", content: "q" }], max_tokens: -1 }).ok).toBe(false);
    expect(parseBridgeCompleteBody({ messages: [{ role: "user", content: "q" }], purpose: "anything" }).ok).toBe(false);
    expect(parseBridgeCompleteBody({ messages: [{ role: "user", content: "x".repeat(MAX_COMPLETE_CHARS + 1) }] }).ok).toBe(false);
  });
});

describe("orchestrator bridge completion route", () => {
  async function serveComplete(complete?: OrchestratorBridgeDeps["complete"]) {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(
      "/orchestrator",
      createOrchestratorBridgeRouter({ spawn: async () => ({ agentId: "x", status: "completed", result: "", attachments: [] }), integrations: () => [], complete }),
    );
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (body: unknown, signal?: AbortSignal) =>
      fetch(`${base}/orchestrator/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    return { call, close: () => new Promise((r) => server.close(r)) };
  }
  const body = { system: "sys", messages: [{ role: "user", content: "merge these" }], max_tokens: 800, purpose: "merger" };

  it("runs the completion and returns its text and usage", async () => {
    const calls: BridgeCompleteRequest[] = [];
    const { call, close } = await serveComplete(async (req) => {
      calls.push(req);
      return { text: "merged", usage: { inputTokens: 100, outputTokens: 20 } };
    });
    try {
      const res = await call(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: "merged", usage: { inputTokens: 100, outputTokens: 20 } });
      expect(calls[0]).toMatchObject({ system: "sys", maxTokens: 800, purpose: "merger" });
      expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    } finally {
      await close();
    }
  });

  it("answers 400 for a bad body, 503 without a runtime, and 500 (+usageLimited) on failure", async () => {
    let fail: Error = new Error("Claude Code process exited with code 1");
    const { call, close } = await serveComplete(async () => {
      throw fail;
    });
    try {
      expect((await call({ messages: [] })).status).toBe(400);
      let res = await call(body);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Claude Code process exited with code 1" });
      fail = new CompletionUsageLimitError("usage limit: you've hit your limit");
      res = await call(body);
      expect(await res.json()).toMatchObject({ usageLimited: true });
    } finally {
      await close();
    }
    const none = await serveComplete(undefined);
    try {
      expect((await none.call(body)).status).toBe(503);
    } finally {
      await none.close();
    }
  });

  it("aborts the completion when the sidecar drops the request", async () => {
    let seen: AbortSignal | null = null;
    const { call, close } = await serveComplete(
      (req) =>
        new Promise((resolve) => {
          seen = req.signal;
          req.signal.addEventListener("abort", () => resolve({ text: "late" }));
        }),
    );
    try {
      const ac = new AbortController();
      const pending = call(body, ac.signal).catch(() => null);
      for (let i = 0; i < 100 && !seen; i++) await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      await pending;
      for (let i = 0; i < 100 && !seen!.aborted; i++) await new Promise((r) => setTimeout(r, 10));
      expect(seen!.aborted).toBe(true);
    } finally {
      await close();
    }
  });
});
