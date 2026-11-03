import { describe, expect, it } from "vitest";
import {
  hashRecord,
  isEmpty,
  mapObservation,
  mapPrompt,
  mapSummary,
  parseList,
  scrub,
  type ObservationRow,
  type PromptRow,
  type SummaryRow,
} from "../server/memory/claude-mem-import.js";
import { SECRET_PLACEHOLDER } from "../server/secrets/redact.js";
import { formatHistoryHits } from "../server/memory/tools.js";

const observation = (extra: Partial<ObservationRow> = {}): ObservationRow => ({
  id: 42,
  memory_session_id: "session-1",
  project: "demo-app",
  merged_into_project: null,
  type: "bugfix",
  title: "Webhook retries now back off",
  subtitle: "Retries wait 2, 4, 8 seconds",
  text: null,
  facts: JSON.stringify(["Retries are capped at 3", "The queue is drained on boot"]),
  narrative: "The webhook handler retried in a tight loop; it now backs off.",
  concepts: JSON.stringify(["gotcha"]),
  files_read: JSON.stringify(["src/a.ts"]),
  files_modified: JSON.stringify(["src/webhook.ts"]),
  created_at_epoch: 1_700_000_000_000,
  ...extra,
});

const summary = (extra: Partial<SummaryRow> = {}): SummaryRow => ({
  id: 7,
  memory_session_id: "session-1",
  project: "demo-app",
  merged_into_project: null,
  request: "Fix the webhook retry storm",
  investigated: "The retry loop",
  learned: "It had no backoff",
  completed: "Added exponential backoff",
  next_steps: null,
  notes: null,
  files_edited: JSON.stringify(["src/webhook.ts"]),
  created_at_epoch: 1_700_000_100_000,
  ...extra,
});

const prompt = (extra: Partial<PromptRow> = {}): PromptRow => ({
  id: 9,
  content_session_id: "content-1",
  project: "demo-app",
  prompt_number: 2,
  prompt_text: "Why does the webhook keep retrying?",
  created_at_epoch: 1_700_000_200_000,
  ...extra,
});

describe("scrub", () => {
  it("removes credentials the shared scanner knows", () => {
    const { text, removed } = scrub("use sk-ant-abcdefghijklmnopqrstuvwxyz123456 here");
    expect(text).not.toContain("sk-ant-");
    expect(text).toContain(SECRET_PLACEHOLDER);
    expect(removed).toBeGreaterThan(0);
  });

  it("removes lower-case password assignments but keeps the name", () => {
    const { text } = scrub("login with password: hunter2hunter2 then continue");
    expect(text).toBe(`login with password: ${SECRET_PLACEHOLDER} then continue`);
  });

  it("leaves code that only names a credential alone", () => {
    for (const plain of [
      "password: string",
      "uses Password::defaults() for policy",
      "token: $plainTextToken",
      "token: env('SNAILMARK_TOKEN')",
      "token: config.services.token",
    ]) {
      expect(scrub(plain)).toEqual({ text: plain, removed: 0 });
    }
  });

  it("removes bearer tokens and passwords inside URLs", () => {
    const { text } = scrub(
      "curl -H 'Authorization: Bearer abcDEF1234567890abcdef' https://admin:s3cretpass@db.example.com/x",
    );
    expect(text).not.toContain("abcDEF1234567890abcdef");
    expect(text).not.toContain("s3cretpass");
    expect(text).toContain("https://admin:");
    expect(text).toContain("@db.example.com/x");
  });

  it("removes Convex deploy keys", () => {
    const { text } = scrub("CONVEX_DEPLOY_KEY was prod:happy-animal-123|eyJ2MjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoifQ==");
    expect(text).not.toContain("eyJ2Mj");
  });

  it("leaves ordinary text, git SHAs and UUIDs alone", () => {
    const plain = "Commit 6f42453a1b2c3d4e5f60718293a4b5c6d7e8f901 fixed 123e4567-e89b-12d3-a456-426614174000.";
    expect(scrub(plain)).toEqual({ text: plain, removed: 0 });
  });
});

describe("parseList", () => {
  it("reads JSON arrays, plain text and nothing", () => {
    expect(parseList('["a", " b ", ""]')).toEqual(["a", "b"]);
    expect(parseList("just text")).toEqual(["just text"]);
    expect(parseList(null)).toEqual([]);
    expect(parseList("[]")).toEqual([]);
  });
});

describe("mapping claude-mem rows", () => {
  it("maps an observation with a stable id and searchable content", () => {
    const { record, secretsRemoved } = mapObservation(observation());
    expect(record).toMatchObject({
      sourceId: "claude-mem:observation:42",
      source: "claude-mem",
      kind: "observation",
      project: "demo-app",
      type: "bugfix",
      title: "Webhook retries now back off",
      sessionId: "session-1",
      occurredAt: 1_700_000_000_000,
    });
    expect(record.content).toContain("[demo-app · bugfix] Webhook retries now back off");
    expect(record.content).toContain("- Retries are capped at 3");
    expect(record.content).toContain("src/webhook.ts");
    expect(record.contentHash).toMatch(/^[0-9a-f]{32}$/);
    expect(secretsRemoved).toBe(0);
  });

  it("files a merged observation under the project it was merged into", () => {
    const { record } = mapObservation(observation({ merged_into_project: "demo-app-v2" }));
    expect(record.project).toBe("demo-app-v2");
  });

  it("scrubs secrets from every field before mapping", () => {
    const { record, secretsRemoved } = mapObservation(
      observation({
        title: "Set GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        narrative: "token: abcdefghijkl1234 was pasted",
      }),
    );
    expect(record.title).not.toContain("ghp_");
    expect(record.content).not.toContain("ghp_");
    expect(record.content).not.toContain("abcdefghijkl1234");
    expect(secretsRemoved).toBeGreaterThanOrEqual(2);
  });

  it("maps a session summary into labelled sections", () => {
    const { record } = mapSummary(summary());
    expect(record.sourceId).toBe("claude-mem:summary:7");
    expect(record.kind).toBe("summary");
    expect(record.title).toBe("Fix the webhook retry storm");
    expect(record.content).toContain("Learned: It had no backoff");
    expect(record.content).not.toContain("Next steps");
  });

  it("maps a prompt and takes its title from the first line", () => {
    const { record } = mapPrompt(prompt());
    expect(record.sourceId).toBe("claude-mem:prompt:9");
    expect(record.title).toBe("Why does the webhook keep retrying?");
    expect(record.content).toContain("prompt #2");
  });

  it("falls back to 'unknown' for a prompt with no session project", () => {
    expect(mapPrompt(prompt({ project: null })).record.project).toBe("unknown");
  });

  it("flags records with nothing to search", () => {
    expect(isEmpty(mapPrompt(prompt({ prompt_text: "   " })).record)).toBe(true);
    expect(isEmpty(mapPrompt(prompt()).record)).toBe(false);
  });

  it("gives the same row the same hash and a changed row a new one", () => {
    const a = mapObservation(observation()).record;
    const b = mapObservation(observation()).record;
    const c = mapObservation(observation({ narrative: "changed" })).record;
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
    const { contentHash, ...rest } = a;
    expect(hashRecord(rest)).toBe(contentHash);
  });
});

describe("formatHistoryHits", () => {
  it("keeps a prompt's text even though its title is the same words", () => {
    const { record } = mapPrompt(prompt());
    expect(formatHistoryHits([record])).toContain("\n  Why does the webhook keep retrying?");
  });

  it("says so when nothing matched", () => {
    expect(formatHistoryHits([])).toBe("No history matched.");
  });

  it("shows date, project, type, title and a snippet without the content prefix", () => {
    const { record } = mapObservation(observation());
    const out = formatHistoryHits([record]);
    expect(out).toContain("2023-11-14 [demo-app · bugfix] Webhook retries now back off (claude-mem:observation:42)");
    expect(out).toContain("Retries wait 2, 4, 8 seconds");
    expect(out).toContain("\n  Retries wait 2, 4, 8 seconds");
  });
});
