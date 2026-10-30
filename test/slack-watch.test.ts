import { describe, expect, it, vi } from "vitest";

vi.mock("../server/broadcast.js", () => ({ broadcast: vi.fn() }));
vi.mock("../server/sendblue.js", () => ({ sendImessage: vi.fn() }));

import {
  DM_TRIGGER,
  CHANNEL_TRIGGER,
  decideSlackMessage,
  dueDigestSlot,
  formatDigest,
  mentionsUser,
  normalizeSlackPayload,
  ownerConversationId,
  parseClassification,
  parseDigestTimes,
  plainSlackText,
  slackPermalink,
  type SlackMessage,
} from "../server/proactive-slack.js";

const ME = "U011T23GEHM";
const msg = (extra: Partial<SlackMessage>): SlackMessage => ({ channel: "C1", ts: "1.1", text: "", user: "U2", ...extra });

describe("which Slack messages count", () => {
  it("keeps mentions of the user and DMs to them", () => {
    expect(decideSlackMessage(msg({ text: `hey <@${ME}> can you merge?` }), ME)).toEqual({ action: "consider", kind: "mention" });
    expect(decideSlackMessage(msg({ channelType: "im", text: "quick one" }), ME)).toEqual({ action: "consider", kind: "dm" });
  });

  it("ignores other people's mentions, bots, edits and joins", () => {
    expect(decideSlackMessage(msg({ text: "hey <@U999>" }), ME).action).toBe("ignore");
    expect(decideSlackMessage(msg({ text: `<@${ME}>`, botId: "B1" }), ME).action).toBe("ignore");
    expect(decideSlackMessage(msg({ text: `<@${ME}>`, subtype: "message_changed" }), ME).action).toBe("ignore");
    expect(decideSlackMessage(msg({ text: `<@${ME}>`, subtype: "channel_join" }), ME).action).toBe("ignore");
  });

  it("treats the user's own messages as replies, not mentions", () => {
    expect(decideSlackMessage(msg({ user: ME, text: `note to <@${ME}>` }), ME)).toEqual({ action: "mine" });
  });

  it("matches labelled mentions but not a longer id", () => {
    expect(mentionsUser(`<@${ME}|harley> hi`, ME)).toBe(true);
    expect(mentionsUser(`<@${ME}X> hi`, ME)).toBe(false);
  });
});

describe("payloads and text", () => {
  it("reads both trigger payloads and marks DMs", () => {
    const dm = normalizeSlackPayload(DM_TRIGGER, { channel: "D1", ts: "2.2", user: "U2", text: "hi", bot_id: null });
    expect(dm).toMatchObject({ channel: "D1", channelType: "im", user: "U2" });
    expect(normalizeSlackPayload(CHANNEL_TRIGGER, { channel: "C1", ts: "3.3", thread_ts: "1.1" })).toMatchObject({ threadTs: "1.1" });
    expect(normalizeSlackPayload(CHANNEL_TRIGGER, { text: "no channel" })).toBeNull();
  });

  it("builds permalinks for top-level messages and thread replies", () => {
    const url = "https://vueschoolteam.slack.com/";
    expect(slackPermalink(url, { channel: "C1", ts: "1700000000.123456" })).toBe(
      "https://vueschoolteam.slack.com/archives/C1/p1700000000123456",
    );
    expect(slackPermalink(url, { channel: "C1", ts: "1700000001.000200", threadTs: "1700000000.123456" })).toBe(
      "https://vueschoolteam.slack.com/archives/C1/p1700000001000200?thread_ts=1700000000.123456&cid=C1",
    );
  });

  it("turns Slack markup into readable text", () => {
    const names = new Map([[ME, "Harley"]]);
    expect(plainSlackText(`<@${ME}> see <https://x.dev/pr/1|PR 1> in <#C1|dev> &amp; <!here>`, names)).toBe(
      "@Harley see PR 1 in #dev & @here",
    );
  });

  it("falls back to a plain summary when the classifier answer is unusable", () => {
    expect(parseClassification('{"urgent": true, "summary": "Alex (DM): needs you"}', "f")).toEqual({ urgent: true, summary: "Alex (DM): needs you" });
    expect(parseClassification("not json", "fallback")).toEqual({ urgent: false, summary: "fallback" });
  });
});

describe("digest schedule", () => {
  it("parses, pads, sorts and drops bad times", () => {
    expect(parseDigestTimes("18:00, 9:30,nope,25:00,18:00")).toEqual(["09:30", "18:00"]);
    expect(parseDigestTimes(null)).toEqual(["11:00", "15:00", "18:00"]);
  });

  it("sends the latest passed slot once", () => {
    const times = ["11:00", "15:00", "18:00"];
    expect(dueDigestSlot(times, "2026-10-31", "10:59", null)).toBeNull();
    expect(dueDigestSlot(times, "2026-10-31", "11:00", null)).toBe("2026-10-31 11:00");
    expect(dueDigestSlot(times, "2026-10-31", "11:30", "2026-10-31 11:00")).toBeNull();
    expect(dueDigestSlot(times, "2026-10-31", "16:10", "2026-10-31 11:00")).toBe("2026-10-31 15:00");
    expect(dueDigestSlot(times, "2026-11-01", "11:05", "2026-10-31 18:00")).toBe("2026-11-01 11:00");
  });

  it("lists new mentions first and calls out texted ones still unanswered", () => {
    const text = formatDigest([
      { summary: "Alex in #dev: wants a review", permalink: "https://a", urgent: false },
      { summary: "Sam (DM): is prod down?", permalink: "https://b", urgent: true, notifiedAt: 1 },
    ])!;
    expect(text).toContain("Slack catch-up: 2 unanswered");
    expect(text.indexOf("Alex")).toBeLessThan(text.indexOf("Still waiting on you"));
    expect(text.indexOf("Still waiting on you")).toBeLessThan(text.indexOf("Sam"));
    expect(formatDigest([])).toBeNull();
  });
});

describe("where notices go", () => {
  it("prefers BOOP_USER_PHONE, then the first owner number", () => {
    expect(ownerConversationId({ BOOP_USER_PHONE: "+15550001111", BOOP_OWNER_NUMBERS: "+15552223333" })).toBe("sms:+15550001111");
    expect(ownerConversationId({ BOOP_OWNER_NUMBERS: "+15552223333, +15554445555" })).toBe("sms:+15552223333");
    expect(ownerConversationId({})).toBeNull();
  });
});
