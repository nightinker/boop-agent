import { describe, expect, it, vi } from "vitest";
import {
  redactBuildText,
  runCodingWithRetries,
  SelfBuildUsageLimitError,
  type CodingRunDeps,
} from "../server/self-build/coding-run.js";
import { RESUME_PROMPT } from "../server/agent-auto-retry.js";
import { EMPTY_USAGE } from "../server/usage.js";
import { setKnownSecrets } from "../server/secrets/redact.js";
import { canCancelBuild, canRetryBuild, requestBuildAction } from "../debug/src/lib/selfBuildActions.js";

const usage = (inputTokens: number) => ({ ...EMPTY_USAGE, model: "opus", inputTokens, costUsd: inputTokens / 100 });

function request() {
  return {
    prompt: "Add a feature",
    systemPrompt: "sys",
    tools: [],
    mode: "execution" as const,
    abortController: new AbortController(),
  };
}

function deps(run: CodingRunDeps["run"]) {
  const recorded: number[] = [];
  const notices: string[] = [];
  const d: CodingRunDeps = {
    run: vi.fn(run),
    recordUsage: async (u) => {
      recorded.push(u.inputTokens);
    },
    onRetry: (notice) => {
      notices.push(notice);
    },
    delaysMs: [1, 1, 1],
  };
  return { d, recorded, notices };
}

describe("runCodingWithRetries", () => {
  it("resumes the same session after a dropped connection and records the total usage once", async () => {
    let call = 0;
    const { d, recorded, notices } = deps(async (req) => {
      call++;
      if (call === 1) {
        req.onSessionId?.("sess-1");
        throw new TypeError("fetch failed");
      }
      return { text: "  Built it.  ", usage: usage(4), sessionId: "sess-1" };
    });

    const out = await runCodingWithRetries(request(), d);

    expect(out).toEqual({ summary: "Built it.", retries: 1 });
    const second = vi.mocked(d.run).mock.calls[1][0];
    expect(second.resumeSessionId).toBe("sess-1");
    expect(second.prompt).toBe(RESUME_PROMPT);
    expect(notices).toEqual(["Attempt 1 failed (TypeError: fetch failed). Retrying in 0s (retry 1 of 3)."]);
    expect(recorded).toEqual([4]);
  });

  it("starts over with the original prompt when no session started yet", async () => {
    let call = 0;
    const { d } = deps(async () => {
      if (++call === 1) throw new Error("read ECONNRESET");
      return { text: "ok", usage: usage(1) };
    });
    await runCodingWithRetries(request(), d);
    const second = vi.mocked(d.run).mock.calls[1][0];
    expect(second.resumeSessionId).toBeUndefined();
    expect(second.prompt).toBe("Add a feature");
  });

  it("gives up after 3 retries", async () => {
    const { d } = deps(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(runCodingWithRetries(request(), d)).rejects.toThrow("fetch failed");
    expect(d.run).toHaveBeenCalledTimes(4);
  });

  it("stops at once with a plain message on a usage limit, and still records what was spent", async () => {
    const { d, recorded } = deps(async () => ({
      text: "Claude AI usage limit reached|1793300000",
      usage: usage(9),
      errorCode: "rate_limit",
    }));
    const run = runCodingWithRetries(request(), d);
    await expect(run).rejects.toBeInstanceOf(SelfBuildUsageLimitError);
    await expect(run).rejects.toThrow("hit its usage limit");
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([9]);
  });

  it("treats a thrown usage-limit error the same way", async () => {
    const { d } = deps(async () => {
      throw new Error("Claude AI usage limit reached|1793300000");
    });
    await expect(runCodingWithRetries(request(), d)).rejects.toBeInstanceOf(SelfBuildUsageLimitError);
    expect(d.run).toHaveBeenCalledTimes(1);
  });

  it("does not retry an error that won't pass on its own", async () => {
    const { d } = deps(async () => {
      throw new Error("invalid_request_error: prompt is too long");
    });
    await expect(runCodingWithRetries(request(), d)).rejects.toThrow("prompt is too long");
    expect(d.run).toHaveBeenCalledTimes(1);
  });

  it("retries a turn reported as a server error and adds up usage", async () => {
    let call = 0;
    const { d, recorded } = deps(async () =>
      ++call === 1
        ? { text: "Internal server error", usage: usage(2), errorCode: "server_error", sessionId: "s" }
        : { text: "done", usage: usage(3), sessionId: "s" },
    );
    await runCodingWithRetries(request(), d);
    expect(recorded).toEqual([5]);
  });

  it("stops waiting when the build is cancelled", async () => {
    const req = request();
    const { d } = deps(async () => {
      throw new TypeError("fetch failed");
    });
    d.delaysMs = [60_000];
    const run = runCodingWithRetries(req, d);
    setTimeout(() => req.abortController.abort(), 5);
    await expect(run).rejects.toThrow("fetch failed");
    expect(d.run).toHaveBeenCalledTimes(1);
  });
});

describe("redactBuildText", () => {
  it("scrubs stored secrets and the credential values in Boop's environment", () => {
    setKnownSecrets([{ name: "STRIPE", value: "sk_live_storedvalue123" }]);
    const env = { GITHUB_TOKEN: "ghp_envvalue_abcdef", HOME: "/Users/me", SHORT_KEY: "abc" };
    expect(redactBuildText("tokens: sk_live_storedvalue123 ghp_envvalue_abcdef in /Users/me abc", env)).toBe(
      "tokens: [REDACTED:STRIPE] [REDACTED:GITHUB_TOKEN] in /Users/me abc",
    );
    setKnownSecrets([]);
  });
});

describe("dashboard build actions", () => {
  it("offers Retry on builds that ended without shipping and Cancel on ones in progress", () => {
    expect(["failed", "cancelled", "rolled_back"].every(canRetryBuild)).toBe(true);
    expect(["shipped", "coding", "pr_open"].some(canRetryBuild)).toBe(false);
    expect(["queued", "coding", "testing", "pr_open"].every(canCancelBuild)).toBe(true);
    expect(canCancelBuild("shipped")).toBe(false);
  });

  it("posts to the build's action route and returns Boop's answer", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Retrying build b1." }), { status: 200 }));
    await expect(requestBuildAction("b1", "retry", fetchImpl as unknown as typeof fetch)).resolves.toBe("Retrying build b1.");
    expect(fetchImpl).toHaveBeenCalledWith("/api/self-builds/b1/retry", { method: "POST" });
    const failing = vi.fn(async () => new Response(JSON.stringify({ error: "build not found" }), { status: 404 }));
    await expect(requestBuildAction("x", "cancel", failing as unknown as typeof fetch)).rejects.toThrow("build not found");
  });
});
