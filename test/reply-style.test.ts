import { describe, expect, it } from "vitest";
import { INTERACTION_SYSTEM_PROMPT } from "../server/interaction-agent.js";
import {
  REPLY_STYLE_PROMPT,
  relayReminder,
  wantsDetailedReply,
} from "../server/reply-style.js";

describe("dispatcher reply style", () => {
  it("puts the mobile-text rules in the dispatcher system prompt", () => {
    expect(INTERACTION_SYSTEM_PROMPT).toContain(REPLY_STYLE_PROMPT);
    expect(REPLY_STYLE_PROMPT).toMatch(/1-3 short sentences/);
    expect(REPLY_STYLE_PROMPT).toMatch(/Don't recap/);
    expect(REPLY_STYLE_PROMPT).toMatch(/No headers/);
    expect(REPLY_STYLE_PROMPT).toMatch(/ONE short question/);
    expect(REPLY_STYLE_PROMPT).toMatch(/"explain", "more detail"/);
  });

  it("drops the old ~400-char default and keeps Sources verbatim", () => {
    expect(INTERACTION_SYSTEM_PROMPT).not.toMatch(/Keep replies under ~400 chars when you can/);
    expect(INTERACTION_SYSTEM_PROMPT).toMatch(/Pass through the Sources section the sub-agent included, VERBATIM/);
    expect(REPLY_STYLE_PROMPT).toMatch(/VERBATIM/);
  });

  it("reminds the dispatcher how to relay a sub-agent result", () => {
    const short = relayReminder(false);
    expect(short).toMatch(/1-3 short sentences/);
    expect(short).toMatch(/no recap/);
    expect(short).toMatch(/Sources\/URLs verbatim/);
    const long = relayReminder(true);
    expect(long).toMatch(/fuller answer is fine/);
    expect(long).toMatch(/Sources\/URLs verbatim/);
  });

  it("detects when the owner asks for a longer answer", () => {
    expect(wantsDetailedReply("explain")).toBe(true);
    expect(wantsDetailedReply("can you give me more detail on that?")).toBe(true);
    expect(wantsDetailedReply("Walk me through it")).toBe(true);
    expect(wantsDetailedReply("what's on my calendar tomorrow")).toBe(false);
    expect(wantsDetailedReply("find the flight receipt")).toBe(false);
    expect(wantsDetailedReply("detailing the car at 3")).toBe(false);
  });
});
