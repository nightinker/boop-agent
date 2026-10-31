import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mutation: vi.fn(async (..._args: unknown[]) => ({})),
  query: vi.fn(async (..._args: unknown[]): Promise<unknown> => []),
  sendImessage: vi.fn(async (..._args: unknown[]) => ({ attached: 0, failed: 0 })),
  spawnExecutionAgent: vi.fn(),
}));

vi.mock("../server/convex-client.js", () => ({
  convex: { mutation: mocks.mutation, query: mocks.query },
}));
vi.mock("../server/sendblue.js", () => ({
  sendImessage: mocks.sendImessage,
  withAttachmentNote: (content: string) => content,
}));
vi.mock("../server/execution-agent.js", () => ({
  spawnExecutionAgent: mocks.spawnExecutionAgent,
}));
vi.mock("../server/broadcast.js", () => ({ broadcast: vi.fn() }));
vi.mock("../server/timezone-config.js", () => ({
  getUserTimezone: async () => "UTC",
}));

import {
  isUsageLimitError,
  isUsageLimitText,
  logSuppressedUsageLimit,
  resetUsageLimitLogState,
  USAGE_LIMIT_LOG_WINDOW_MS,
} from "../server/usage-limit.js";
import { tickAutomations } from "../server/automations.js";
import { notifyConversation } from "../server/notify.js";

const SPEND_LIMIT =
  "You've hit your monthly spend limit. Switch to another model to continue.";

describe("usage limit detection", () => {
  it("matches spend/usage limit messages", () => {
    expect(isUsageLimitText(SPEND_LIMIT)).toBe(true);
    expect(isUsageLimitText("You’ve hit your weekly limit · resets 3pm")).toBe(true);
    expect(isUsageLimitText("Claude AI usage limit reached|1700000000")).toBe(true);
    expect(isUsageLimitText("Credit balance is too low")).toBe(true);
    expect(isUsageLimitText("status=429 - usage_limit_reached")).toBe(true);
    expect(isUsageLimitText(`[boop-agent new PR ping]\n\n${SPEND_LIMIT}`)).toBe(true);
  });

  it("matches runtime error codes and thrown errors", () => {
    expect(isUsageLimitError("whatever", "billing_error")).toBe(true);
    expect(isUsageLimitError("whatever", "rate_limit")).toBe(true);
    expect(isUsageLimitError(new Error(SPEND_LIMIT))).toBe(true);
    expect(isUsageLimitError(new Error("wrapped", { cause: new Error(SPEND_LIMIT) }))).toBe(true);
    expect(isUsageLimitError({ code: "workspace_owner_credits_depleted" })).toBe(true);
  });

  it("ignores ordinary results and other errors", () => {
    expect(isUsageLimitText("New PR #23 opened: fix typo in README")).toBe(false);
    expect(isUsageLimitText("")).toBe(false);
    expect(isUsageLimitError(new Error("ECONNRESET"))).toBe(false);
    expect(isUsageLimitError("ok", "server_error")).toBe(false);
    // Long real reports that mention a spend limit in passing aren't errors.
    const report = `Summary of AWS billing: your monthly spend limit is $500. ${"detail ".repeat(300)}`;
    expect(isUsageLimitText(report)).toBe(false);
  });
});

describe("suppressed limit logging", () => {
  beforeEach(() => resetUsageLimitLogState());

  it("logs once per source per window", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t0 = 1_000_000;
    expect(logSuppressedUsageLimit("automation:a", SPEND_LIMIT, t0)).toBe(true);
    expect(logSuppressedUsageLimit("automation:a", SPEND_LIMIT, t0 + 1000)).toBe(false);
    expect(logSuppressedUsageLimit("automation:b", SPEND_LIMIT, t0 + 1000)).toBe(true);
    expect(
      logSuppressedUsageLimit("automation:a", SPEND_LIMIT, t0 + USAGE_LIMIT_LOG_WINDOW_MS + 1),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[2][0])).toContain("1 more suppressed");
    warn.mockRestore();
  });
});

describe("background notifications", () => {
  beforeEach(() => {
    resetUsageLimitLogState();
    mocks.mutation.mockClear();
    mocks.query.mockReset();
    mocks.sendImessage.mockClear();
    mocks.spawnExecutionAgent.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  function dueAutomation() {
    return {
      automationId: "auto_1",
      name: "boop-agent new PR ping",
      task: "check for new PRs",
      integrations: [],
      schedule: "*/5 * * * *",
      conversationId: "sms:+15555550100",
      notifyConversationId: "sms:+15555550100",
      nextRunAt: Date.now() - 1000,
    };
  }

  async function runTick() {
    mocks.query.mockResolvedValue([dueAutomation()]);
    await tickAutomations();
    await vi.waitFor(() => {
      const names = mocks.mutation.mock.calls.map((c) => c[1] as Record<string, unknown>);
      expect(names.some((a) => "lastRunAt" in a)).toBe(true);
    });
  }

  it("does not text a spend-limit result from an automation, repeatedly", async () => {
    mocks.spawnExecutionAgent.mockResolvedValue({
      agentId: "agent_1",
      result: `usage limit: ${SPEND_LIMIT}`,
      status: "failed",
      attachments: [],
      usageLimited: true,
    });
    await runTick();
    mocks.mutation.mockClear();
    await runTick();

    expect(mocks.sendImessage).not.toHaveBeenCalled();
    const updateRun = mocks.mutation.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((a) => "runId" in a && "status" in a);
    expect(updateRun).toMatchObject({ status: "failed" });
    expect(updateRun?.error).toContain("monthly spend limit");
    // Logged once, not on every run.
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("catches limit text even if the agent didn't flag it", async () => {
    mocks.spawnExecutionAgent.mockResolvedValue({
      agentId: "agent_1",
      result: SPEND_LIMIT,
      status: "completed",
      attachments: [],
    });
    await runTick();
    expect(mocks.sendImessage).not.toHaveBeenCalled();
  });

  it("still texts normal automation results", async () => {
    mocks.spawnExecutionAgent.mockResolvedValue({
      agentId: "agent_1",
      result: "New PR #23 opened.",
      status: "completed",
      attachments: [],
    });
    await runTick();
    expect(mocks.sendImessage).toHaveBeenCalledWith(
      "+15555550100",
      "[boop-agent new PR ping]\n\nNew PR #23 opened.",
      [],
    );
  });

  it("notifyConversation drops limit errors and sends everything else", async () => {
    await notifyConversation("sms:+15555550100", `Build failed: ${SPEND_LIMIT}`, "self_build");
    expect(mocks.sendImessage).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();

    await notifyConversation("sms:+15555550100", "PR is ready", "self_build");
    expect(mocks.sendImessage).toHaveBeenCalledWith("+15555550100", "PR is ready");
  });
});
