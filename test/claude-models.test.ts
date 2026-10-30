import { describe, expect, it } from "vitest";
import { KNOWN_MODELS, resolveModelInput } from "../server/runtime-config.js";

describe("Claude model aliases", () => {
  it("points the short names at the newest models", () => {
    expect(resolveModelInput("fable", "claude")).toBe("claude-fable-5-1");
    expect(resolveModelInput("opus", "claude")).toBe("claude-opus-5-5");
    expect(resolveModelInput("sonnet", "claude")).toBe("claude-sonnet-5-5");
    expect(resolveModelInput("haiku", "claude")).toBe("claude-haiku-5-5");
  });

  it("still accepts the older models a user may have saved", () => {
    expect(resolveModelInput("claude-sonnet-4-6", "claude")).toBe("claude-sonnet-4-6");
    expect(resolveModelInput("opus 4.7", "claude")).toBe("claude-opus-4-7");
    expect(KNOWN_MODELS.has("claude-haiku-4-5-20251001")).toBe(true);
  });

  it("rejects an unknown model", () => {
    expect(resolveModelInput("claude-made-up-9", "claude")).toBeNull();
  });
});
