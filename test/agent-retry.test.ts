import { describe, expect, it, vi } from "vitest";
import { retriedMessage, startAgentRetry, type RetryDeps } from "../server/agent-retry.js";
import { canRetry, requestAgentRetry } from "../debug/src/lib/agentRetry.js";
import type { SpawnResult } from "../server/execution-agent.js";

const result = (extra: Partial<SpawnResult> = {}): SpawnResult => ({
  agentId: "agent-new",
  result: "Here is the answer.",
  status: "completed",
  attachments: [],
  ...extra,
});

function deps(overrides: Partial<RetryDeps> = {}) {
  let finish: (value: SpawnResult | null) => void = () => {};
  const finished = new Promise<SpawnResult | null>((r) => (finish = r));
  const notify = vi.fn(async () => {});
  const retry = vi.fn<RetryDeps["retry"]>(async (_id, extra) => {
    extra.onStarted?.("agent-new");
    return finished;
  });
  const d: RetryDeps = {
    getAgent: async () => ({ status: "failed", name: "banner-fix", conversationId: "sms:+10000000000" }),
    retry,
    notify,
    log: { error: vi.fn() },
    ...overrides,
  };
  return { d, notify, retry, finish };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startAgentRetry", () => {
  it("answers with the new run's id before the run finishes", async () => {
    const { d, retry, notify } = deps();
    await expect(startAgentRetry("agent-old", d)).resolves.toEqual({ ok: true, agentId: "agent-new" });
    expect(retry).toHaveBeenCalledWith("agent-old", expect.objectContaining({ onStarted: expect.any(Function) }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("texts the answer to the original conversation once the retry completes", async () => {
    const { d, notify, finish } = deps();
    await startAgentRetry("agent-old", d);
    finish(result());
    await flush();
    expect(notify).toHaveBeenCalledWith("sms:+10000000000", 'Retried "banner-fix":\n\nHere is the answer.');
  });

  it("sends nothing when the retry fails again, is usage-limited or has no conversation", async () => {
    for (const [agent, outcome] of [
      [{ status: "failed", name: "x", conversationId: "sms:+1" }, result({ status: "failed" })],
      [{ status: "failed", name: "x", conversationId: "sms:+1" }, result({ usageLimited: true })],
      [{ status: "cancelled", name: "x" }, result()],
    ] as const) {
      const { d, notify, finish } = deps({ getAgent: async () => agent });
      await startAgentRetry("agent-old", d);
      finish(outcome);
      await flush();
      expect(notify).not.toHaveBeenCalled();
    }
  });

  it("refuses a run that is missing or did not fail", async () => {
    expect(await startAgentRetry("nope", deps({ getAgent: async () => null }).d)).toMatchObject({ ok: false, status: 404 });
    const running = deps({ getAgent: async () => ({ status: "running", name: "x" }) });
    expect(await startAgentRetry("agent-old", running.d)).toMatchObject({ ok: false, status: 409 });
    expect(running.retry).not.toHaveBeenCalled();
  });

  it("reports an error when the retry throws before it starts", async () => {
    const { d } = deps({ retry: async () => Promise.reject(new Error("convex down")) });
    expect(await startAgentRetry("agent-old", d)).toEqual({ ok: false, status: 500, error: "convex down" });
  });

  it("logs, rather than throws, when the run fails after starting", async () => {
    const log = { error: vi.fn() };
    const { d } = deps({
      log,
      retry: async (_id, extra) => {
        extra.onStarted?.("agent-new");
        throw new Error("model crashed");
      },
    });
    expect(await startAgentRetry("agent-old", d)).toEqual({ ok: true, agentId: "agent-new" });
    await flush();
    expect(log.error).toHaveBeenCalled();
  });

  it("formats the retried message", () => {
    expect(retriedMessage("a", "  done \n")).toBe('Retried "a":\n\ndone');
  });
});

describe("dashboard retry helpers", () => {
  it("offers retry only on failed and cancelled runs", () => {
    expect(canRetry("failed")).toBe(true);
    expect(canRetry("cancelled")).toBe(true);
    expect(canRetry("completed")).toBe(false);
    expect(canRetry("running")).toBe(false);
  });

  it("posts to the retry endpoint and returns the new id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, agentId: "agent-new" }))) as unknown as typeof fetch;
    await expect(requestAgentRetry("agent/1", fetchImpl)).resolves.toBe("agent-new");
    expect(fetchImpl).toHaveBeenCalledWith("/api/agents/agent%2F1/retry", { method: "POST" });
  });

  it("throws the server's error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "only failed or cancelled runs can be retried" }), { status: 409 })) as unknown as typeof fetch;
    await expect(requestAgentRetry("a", fetchImpl)).rejects.toThrow("only failed or cancelled runs can be retried");
  });
});
