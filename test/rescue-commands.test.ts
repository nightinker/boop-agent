import { describe, expect, it, vi } from "vitest";
import {
  normalizeCommand,
  parseRescueIntent,
  recoveryHint,
  tryRescueCommand,
  type RescueDeps,
} from "../server/rescue-commands.js";

const MODELS: Record<string, string> = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", "opus 5.5": "claude-opus-5-5" };

function deps(overrides: Partial<RescueDeps> = {}) {
  const calls: string[] = [];
  const d: RescueDeps = {
    resolveModel: async (t) => MODELS[t] ?? null,
    isRuntime: (t) => t === "codex" || t === "claude",
    accountNames: async () => ["alice@example.com", "alice", "bob@example.com", "bob", "carol@example.com", "carol"],
    switchModel: async (t) => (calls.push(`model:${t}`), { ok: true, text: `model ${t}` }),
    switchRuntime: async (t) => (calls.push(`runtime:${t}`), { ok: true, text: `runtime ${t}` }),
    switchAccount: async (t) => (calls.push(`account:${t}`), { ok: true, text: `account ${t}` }),
    status: async () => "status line",
    ...overrides,
  };
  return { d, calls };
}

describe("reading a command", () => {
  it("ignores politeness, punctuation and possessives", () => {
    expect(normalizeCommand("Switch to Sonnet please!")).toBe("switch to sonnet");
    expect(normalizeCommand("use Bob's account.")).toBe("use bob account");
  });

  it("spots account, general switches and status", () => {
    expect(parseRescueIntent("switch account to bob")).toEqual({ kind: "switch", target: "bob", accountOnly: true });
    expect(parseRescueIntent("use carol's account")).toEqual({ kind: "switch", target: "carol", accountOnly: true });
    expect(parseRescueIntent("switch to alice@example.com")).toEqual({
      kind: "switch",
      target: "alice@example.com",
      accountOnly: false,
    });
    expect(parseRescueIntent("change the model to opus")).toEqual({ kind: "switch", target: "opus", accountOnly: false });
    expect(parseRescueIntent("status")).toEqual({ kind: "status" });
    expect(parseRescueIntent("which model are you using?")).toEqual({ kind: "status" });
  });

  it("leaves ordinary messages alone", () => {
    expect(parseRescueIntent("suggest a new feature I can build")).toBeNull();
    expect(parseRescueIntent("x".repeat(100))).toBeNull();
  });
});

describe("running a command without the model", () => {
  it("switches model, runtime or account by what the name matches", async () => {
    const { d, calls } = deps();
    expect(await tryRescueCommand("switch to sonnet please", d)).toBe("model sonnet");
    expect(await tryRescueCommand("use codex", d)).toBe("runtime codex");
    expect(await tryRescueCommand("switch to bob", d)).toBe("account bob");
    expect(await tryRescueCommand("use carol's account", d)).toBe("account carol");
    expect(await tryRescueCommand("switch to alice@example.com.", d)).toBe("account alice@example.com");
    expect(calls).toEqual(["model:sonnet", "runtime:codex", "account:bob", "account:carol", "account:alice@example.com"]);
  });

  it("answers status", async () => {
    expect(await tryRescueCommand("status", deps().d)).toBe("status line");
  });

  it("hands anything else to the model", async () => {
    const { d, calls } = deps();
    expect(await tryRescueCommand("switch to dark mode in my calendar", d)).toBeNull();
    expect(await tryRescueCommand("use sonnet for this summary", d)).toBeNull();
    expect(await tryRescueCommand("what's the weather", d)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("still handles models when the account list can't be read", async () => {
    const { d } = deps({ accountNames: vi.fn(async () => Promise.reject(new Error("cswap down"))) });
    expect(await tryRescueCommand("switch to opus", d)).toBe("model opus");
    expect(await tryRescueCommand("switch to bob", d)).toBeNull();
  });
});

describe("the reply when the model fails", () => {
  it("names the other accounts and a model to try", () => {
    const text = recoveryHint({ reason: "limit", otherAccounts: ["alice", "carol"], model: "claude-fable-5-1" });
    expect(text).toContain("usage/spend limit on claude-fable-5-1");
    expect(text).toContain('"switch to alice", "switch to carol", "switch to sonnet"');
    expect(recoveryHint({ reason: "error", otherAccounts: [] })).toContain('"switch to sonnet"');
  });
});
