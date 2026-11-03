import { describe, expect, it, vi } from "vitest";

vi.mock("../server/convex-client.js", () => ({ convex: { query: vi.fn(), mutation: vi.fn() } }));
vi.mock("../server/notify.js", () => ({ notifyConversation: vi.fn() }));
vi.mock("../server/execution-agent.js", () => ({ retryAgent: vi.fn() }));

import { createAgentRetryTools, describeFailedAgents, type AgentRetryToolDeps, type AgentRow } from "../server/agent-retry-tools.js";

const now = 1_800_000_000_000;
const row = (extra: Partial<AgentRow>): AgentRow => ({
  agentId: "agent_x",
  name: "task",
  status: "completed",
  startedAt: now - 5 * 60_000,
  ...extra,
});

describe("describeFailedAgents", () => {
  it("lists failed and cancelled runs newest first, with their latest retry", () => {
    const rows = [
      row({ agentId: "agent_r2", status: "running", retryOf: "agent_b" }),
      row({ agentId: "agent_ok", status: "completed" }),
      row({ agentId: "agent_b", name: "Verify logo", status: "failed", error: "TypeError: fetch failed\nstack", startedAt: now - 2 * 3_600_000 }),
      row({ agentId: "agent_c", name: "Remove logo", status: "cancelled" }),
    ];
    expect(describeFailedAgents(rows, 10, now)).toBe(
      "2 failed/cancelled run(s), newest first:\n" +
        '- agent_b "Verify logo" failed 2h ago: TypeError: fetch failed — retried as agent_r2 (running)\n' +
        '- agent_c "Remove logo" cancelled 5m ago: (no error text)',
    );
  });

  it("says when nothing failed", () => {
    expect(describeFailedAgents([row({})], 10, now)).toBe("No failed or cancelled agent runs in the recent history.");
  });
});

describe("agent retry tools", () => {
  function tools(overrides: Partial<AgentRetryToolDeps> = {}) {
    const deps: AgentRetryToolDeps = {
      getAgent: async () => ({ status: "failed", name: "Verify logo", conversationId: "sms:+1" }),
      retry: vi.fn(async (_id, extra) => {
        extra.onStarted?.("agent_new");
        return new Promise(() => {});
      }),
      notify: vi.fn(async () => {}),
      recentAgents: async () => [row({ agentId: "agent_b", status: "failed", error: "fetch failed" })],
      now: () => now,
      ...overrides,
    };
    const [list, retry] = createAgentRetryTools(deps);
    return { list, retry, deps };
  }

  it("lists failed runs", async () => {
    const { list } = tools();
    expect((await list.handle({})).text).toContain('agent_b "task" failed 5m ago: fetch failed');
  });

  it("starts a retry and returns at once with the new run", async () => {
    const { retry, deps } = tools();
    const out = await retry.handle({ agentId: " agent_b " });
    expect(deps.retry).toHaveBeenCalledWith("agent_b", expect.anything());
    expect(out.text).toBe("Retry started as agent_new. Its answer will be sent to the user when it finishes.");
  });

  it("explains a run that can't be retried", async () => {
    const { retry } = tools({ getAgent: async () => ({ status: "completed", name: "x" }) });
    const out = await retry.handle({ agentId: "agent_b" });
    expect(out.success).toBe(false);
    expect(out.text).toContain("only failed or cancelled runs can be retried");
  });
});
