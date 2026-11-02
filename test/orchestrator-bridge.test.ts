import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { SpawnOptions, SpawnResult } from "../server/execution-agent.js";
import { createOrchestratorBridgeRouter, parseBridgeSpawnBody } from "../server/orchestrator-bridge.js";

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
