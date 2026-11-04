import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgentRuntime: vi.fn(),
  mutations: [] as Array<{ name: string; args: Record<string, unknown> }>,
  broadcasts: [] as Array<{ event: string; data: unknown }>,
}));

vi.mock("../server/convex-client.js", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    convex: {
      mutation: vi.fn(async (ref: unknown, args: Record<string, unknown>) => {
        mocks.mutations.push({ name: getFunctionName(ref as never), args });
        return null;
      }),
      query: vi.fn(async () => []),
    },
  };
});
vi.mock("../server/broadcast.js", () => ({
  broadcast: (event: string, data: unknown) => mocks.broadcasts.push({ event, data }),
}));
vi.mock("../server/runtimes/index.js", () => ({ runAgentRuntime: mocks.runAgentRuntime }));
vi.mock("../server/skills/review.js", () => ({ maybeReviewSkillsAfterRun: vi.fn(async () => {}) }));
vi.mock("../server/agent-auto-retry.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../server/agent-auto-retry.js")>();
  return { ...real, AUTO_RETRY_DELAYS_MS: [1, 1, 1] };
});

import {
  addUsage,
  isTransientAgentError,
  RESUME_PROMPT,
  retryNotice,
  waitUnlessAborted,
} from "../server/agent-auto-retry.js";
import { cancelAgent, spawnExecutionAgent } from "../server/execution-agent.js";
import { EMPTY_USAGE } from "../server/usage.js";

const config = { runtime: "claude" as const, model: "sonnet", billingMode: "api" as const };
const usage = (inputTokens: number) => ({ ...EMPTY_USAGE, model: "sonnet", inputTokens, costUsd: inputTokens / 1000 });

function lastUpdate() {
  return [...mocks.mutations].reverse().find((m) => m.name === "agents:update" && m.args.status !== "running")!.args;
}
const logs = () => mocks.mutations.filter((m) => m.name === "agents:addLog").map((m) => String(m.args.content));

describe("isTransientAgentError", () => {
  it.each([
    "TypeError: fetch failed",
    "Error: read ECONNRESET",
    "API Error: 529 overloaded_error",
    "Claude Code process exited with code 1\nClaude Code stderr:\nAPI Error: 503 Service Unavailable",
    "socket hang up",
  ])("retries %s", (message) => {
    expect(isTransientAgentError(new Error(message))).toBe(true);
  });

  it("follows the cause of a wrapped error", () => {
    expect(isTransientAgentError(new Error("request failed", { cause: new Error("getaddrinfo EAI_AGAIN api.anthropic.com") }))).toBe(true);
  });

  it.each([
    "AbortError: The operation was aborted",
    "invalid_request_error: prompt is too long",
    "Claude AI usage limit reached|1793300000",
    "authentication_failed",
  ])("does not retry %s", (message) => {
    expect(isTransientAgentError(new Error(message))).toBe(false);
  });

  it("reads runtime error codes", () => {
    expect(isTransientAgentError("Internal error", "server_error")).toBe(true);
    expect(isTransientAgentError("You are out of credits", "billing_error")).toBe(false);
  });
});

describe("helpers", () => {
  it("says which retry this is and when", () => {
    expect(retryNotice(2, 15_000, "TypeError: fetch failed\n  at x")).toBe(
      "Attempt 2 failed (TypeError: fetch failed). Retrying in 15s (retry 2 of 3).",
    );
  });

  it("stops waiting when the run is cancelled", async () => {
    const abort = new AbortController();
    const waiting = waitUnlessAborted(60_000, abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBe(false);
    await expect(waitUnlessAborted(1, new AbortController().signal)).resolves.toBe(true);
  });

  it("adds up usage across attempts", () => {
    expect(addUsage(usage(10), usage(5))).toMatchObject({ inputTokens: 15, costUsd: 0.015 });
  });
});

describe("spawnExecutionAgent auto-retry", () => {
  beforeEach(() => {
    mocks.runAgentRuntime.mockReset();
    mocks.mutations.length = 0;
    mocks.broadcasts.length = 0;
  });

  it("resumes the same Claude session after a dropped connection, so tool calls aren't repeated", async () => {
    mocks.runAgentRuntime
      .mockImplementationOnce(async (_cfg, req) => {
        req.onSessionId?.("session-1");
        await req.onToolUse?.("mcp__gmail__send_email", { to: "a@example.com" });
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(async (_cfg, req) => {
        await req.onText?.("Sent it.");
        return { text: "Sent it.", usage: usage(7), sessionId: "session-1" };
      });

    const res = await spawnExecutionAgent({ task: "Email Sam", integrations: [], runtimeConfig: config });

    expect(res.status).toBe("completed");
    expect(res.result).toBe("Sent it.");
    expect(mocks.runAgentRuntime).toHaveBeenCalledTimes(2);
    const resumed = mocks.runAgentRuntime.mock.calls[1][1];
    expect(resumed.resumeSessionId).toBe("session-1");
    expect(resumed.prompt).toBe(RESUME_PROMPT);
    expect(logs()).toContain("Attempt 1 failed (TypeError: fetch failed). Retrying in 0s (retry 1 of 3).");
    expect(mocks.broadcasts.some((b) => b.event === "agent_retrying")).toBe(true);
  });

  it("starts over when it failed before any session or tool call", async () => {
    mocks.runAgentRuntime
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1"))
      .mockResolvedValueOnce({ text: "Done.", usage: usage(1) });

    const res = await spawnExecutionAgent({ task: "Check the weather", integrations: [], runtimeConfig: config });

    expect(res.status).toBe("completed");
    const second = mocks.runAgentRuntime.mock.calls[1][1];
    expect(second.resumeSessionId).toBeUndefined();
    expect(second.prompt).toBe("Check the weather");
  });

  it("gives up after 3 retries and says so", async () => {
    mocks.runAgentRuntime.mockImplementation(async (_cfg, req) => {
      req.onSessionId?.("session-1");
      throw new TypeError("fetch failed");
    });

    const res = await spawnExecutionAgent({ task: "x", integrations: [], runtimeConfig: config });

    expect(res.status).toBe("failed");
    expect(mocks.runAgentRuntime).toHaveBeenCalledTimes(4);
    expect(lastUpdate().error).toBe("TypeError: fetch failed (after 3 automatic retries)");
    expect(res.autoRetries).toBe(3);
  });

  it("never re-runs from scratch after a tool ran without a session to resume", async () => {
    mocks.runAgentRuntime.mockImplementationOnce(async (_cfg, req) => {
      await req.onToolUse?.("mcp__gmail__send_email", {});
      throw new TypeError("fetch failed");
    });

    const res = await spawnExecutionAgent({ task: "x", integrations: [], runtimeConfig: { ...config, runtime: "codex" as const } });

    expect(res.status).toBe("failed");
    expect(mocks.runAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error that won't pass on its own", async () => {
    mocks.runAgentRuntime.mockRejectedValueOnce(new Error("invalid_request_error: prompt is too long"));

    const res = await spawnExecutionAgent({ task: "x", integrations: [], runtimeConfig: config });

    expect(res.status).toBe("failed");
    expect(mocks.runAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it("retries a turn the runtime reported as a server error", async () => {
    mocks.runAgentRuntime
      .mockResolvedValueOnce({ text: "Internal server error", usage: usage(2), errorCode: "server_error", sessionId: "s" })
      .mockResolvedValueOnce({ text: "Fine now.", usage: usage(3), sessionId: "s" });

    const res = await spawnExecutionAgent({ task: "x", integrations: [], runtimeConfig: config });

    expect(res.status).toBe("completed");
    expect(lastUpdate().inputTokens).toBe(5);
  });

  it("resumes a run the heartbeat stopped for going quiet", async () => {
    let agentId = "";
    mocks.runAgentRuntime
      .mockImplementationOnce(async (_cfg, req) => {
        req.onSessionId?.("session-1");
        await req.onToolUse?.("Bash", { command: "aws s3 cp" });
        cancelAgent(agentId, "stale");
        expect(req.abortController.signal.aborted).toBe(true);
        throw new Error("Claude Code process aborted by user");
      })
      .mockImplementationOnce(async (_cfg, req) => {
        expect(req.abortController.signal.aborted).toBe(false);
        return { text: "Uploaded.", usage: usage(1), sessionId: "session-1" };
      });

    const res = await spawnExecutionAgent({
      task: "Upload the renders",
      integrations: [],
      runtimeConfig: config,
      onStarted: (id) => {
        agentId = id;
      },
    });

    expect(res.status).toBe("completed");
    const resumed = mocks.runAgentRuntime.mock.calls[1][1];
    expect(resumed.resumeSessionId).toBe("session-1");
    expect(logs().some((l) => l.includes("no activity for 15 minutes"))).toBe(true);
  });

  it("does not retry a run the user stopped", async () => {
    let agentId = "";
    mocks.runAgentRuntime.mockImplementationOnce(async (_cfg, req) => {
      req.onSessionId?.("session-1");
      cancelAgent(agentId);
      throw new Error("Claude Code process aborted by user");
    });

    const res = await spawnExecutionAgent({
      task: "x",
      integrations: [],
      runtimeConfig: config,
      onStarted: (id) => {
        agentId = id;
      },
    });

    expect(res.status).toBe("cancelled");
    expect(mocks.runAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not retry a run stopped at the hard time limit", async () => {
    let agentId = "";
    mocks.runAgentRuntime.mockImplementationOnce(async (_cfg, req) => {
      req.onSessionId?.("session-1");
      cancelAgent(agentId, "timeout");
      throw new Error("Claude Code process aborted by user");
    });

    const res = await spawnExecutionAgent({
      task: "x",
      integrations: [],
      runtimeConfig: config,
      onStarted: (id) => {
        agentId = id;
      },
    });

    expect(res.status).toBe("failed");
    expect(mocks.runAgentRuntime).toHaveBeenCalledTimes(1);
    expect(lastUpdate().error).toContain("time limit");
  });
});
