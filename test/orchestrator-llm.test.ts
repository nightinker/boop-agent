import { describe, expect, it } from "vitest";
import { CompletionUsageLimitError, type BridgeCompleteRequest } from "../server/orchestrator-bridge.js";
import {
  COMPLETION_DISALLOWED_TOOLS,
  completeWithRuntime,
  completionSystemPrompt,
  formatCompletionPrompt,
  type CompletionDeps,
} from "../server/orchestrator-llm.js";
import type { RuntimeConfig } from "../server/runtime-config.js";
import type { RuntimeRunRequest, RuntimeRunResult } from "../server/runtimes/types.js";
import { EMPTY_USAGE } from "../server/usage.js";

const CONFIG: RuntimeConfig = { runtime: "claude", model: "claude-opus-5-5", billingMode: "api" };

function request(over: Partial<BridgeCompleteRequest> = {}): BridgeCompleteRequest {
  return {
    system: "You merge step results.",
    messages: [{ role: "user", content: "merge these" }],
    maxTokens: 1000,
    purpose: "merger",
    signal: new AbortController().signal,
    ...over,
  };
}

function deps(result: RuntimeRunResult | (() => Promise<RuntimeRunResult>)) {
  const runs: Array<Omit<RuntimeRunRequest, "model" | "reasoningEffort">> = [];
  const recorded: string[] = [];
  const d: CompletionDeps = {
    runtimeConfig: async () => CONFIG,
    run: async (_config, req) => {
      runs.push(req);
      return typeof result === "function" ? result() : result;
    },
    recordUsage: async (u) => {
      recorded.push(u.purpose);
    },
  };
  return { d, runs, recorded };
}

const usage = { ...EMPTY_USAGE, model: "claude-opus-5-5", inputTokens: 300, outputTokens: 40, cacheReadTokens: 9000 };

describe("formatCompletionPrompt", () => {
  it("sends a single message as it is and writes a retry exchange out as a transcript", () => {
    expect(formatCompletionPrompt([{ role: "user", content: "plan this" }])).toBe("plan this");
    const text = formatCompletionPrompt([
      { role: "user", content: "Task: x" },
      { role: "assistant", content: "{bad}" },
      { role: "user", content: "That plan was rejected" },
    ]);
    expect(text).toContain("<user>\nTask: x\n</user>");
    expect(text).toContain("<assistant>\n{bad}\n</assistant>");
    expect(text.trim().endsWith("That plan was rejected")).toBe(true);
  });
});

describe("completionSystemPrompt", () => {
  it("adds the token limit, which the runtime can't enforce itself", () => {
    expect(completionSystemPrompt("sys")).toBe("sys");
    expect(completionSystemPrompt("sys", 1000)).toContain("under 1000 tokens");
  });
});

describe("completeWithRuntime", () => {
  it("runs the prompt through Boop's runtime with no tools and returns text plus fresh tokens", async () => {
    const { d, runs, recorded } = deps({ text: "  merged answer  ", usage });
    const res = await completeWithRuntime(request(), d);
    expect(res).toEqual({ text: "merged answer", usage: { inputTokens: 300, outputTokens: 40 } });
    expect(runs[0]).toMatchObject({ prompt: "merge these", tools: [], mode: "background" });
    expect(runs[0].systemPrompt).toContain("You merge step results.");
    expect(runs[0].systemPrompt).toContain("under 1000 tokens");
    expect(runs[0].disallowedTools).toEqual(COMPLETION_DISALLOWED_TOOLS);
    expect(runs[0].disallowedTools).toEqual(expect.arrayContaining(["Bash", "WebFetch", "Write"]));
    expect(recorded).toEqual(["merger"]);
  });

  it("fails on usage limits, model errors and empty answers", async () => {
    await expect(
      completeWithRuntime(request(), deps({ text: "You've hit your monthly spend limit.", usage, errorCode: "billing_error" }).d),
    ).rejects.toBeInstanceOf(CompletionUsageLimitError);
    await expect(completeWithRuntime(request(), deps({ text: "overloaded", usage, errorCode: "server_error" }).d)).rejects.toThrow(
      /model error/,
    );
    await expect(completeWithRuntime(request(), deps({ text: "   ", usage }).d)).rejects.toThrow(/empty/);
    await expect(
      completeWithRuntime(
        request(),
        deps(async () => {
          throw new Error("Claude Code process exited with code 1");
        }).d,
      ),
    ).rejects.toThrow(/exited/);
  });

  it("aborts the runtime when the request is cancelled", async () => {
    const ac = new AbortController();
    let runtimeSignal: AbortSignal | undefined;
    const d: CompletionDeps = {
      runtimeConfig: async () => CONFIG,
      run: async (_c, req) => {
        runtimeSignal = req.abortController?.signal;
        ac.abort();
        return { text: "x", usage };
      },
    };
    await completeWithRuntime(request({ signal: ac.signal }), d);
    expect(runtimeSignal?.aborted).toBe(true);
  });
});
