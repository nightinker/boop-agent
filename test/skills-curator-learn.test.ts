import { describe, expect, it, vi } from "vitest";

vi.mock("../server/broadcast.js", () => ({ broadcast: vi.fn() }));
vi.mock("../server/sendblue.js", () => ({ sendImessage: vi.fn() }));

import { decideCuration, type CuratableSkill } from "../server/skills/curator.js";
import { LEARN_ALLOWED_TOOLS, createLearnTools, learnRecord, startLearning } from "../server/skills/learn.js";
import { createSkillTools, newSkillToolsState, type SkillStore, type StoredSkill } from "../server/skills/tools.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function skill(name: string, idleDays: number, extra: Partial<CuratableSkill> = {}): CuratableSkill {
  return { name, status: "active", pinned: false, createdAt: 0, lastUsedAt: NOW - idleDays * DAY, ...extra };
}

describe("curator decisions", () => {
  it("marks skills unused for 14 days stale and archives them after 30", () => {
    const result = decideCuration(
      [skill("fresh", 2), skill("quiet", 20), skill("old", 45), skill("already-stale", 20, { stale: true })],
      NOW,
    );
    expect(result).toEqual({ markStale: ["quiet"], archive: ["old"] });
  });

  it("never touches pinned or archived skills", () => {
    const result = decideCuration(
      [skill("pinned", 90, { pinned: true }), skill("archived", 90, { status: "archived" })],
      NOW,
    );
    expect(result).toEqual({ markStale: [], archive: [] });
  });

  it("gives a never-used skill the full grace period from when it was made", () => {
    const result = decideCuration(
      [
        { name: "new", status: "active", pinned: false, createdAt: NOW - 3 * DAY },
        { name: "abandoned", status: "active", pinned: false, createdAt: NOW - 40 * DAY },
      ],
      NOW,
    );
    expect(result).toEqual({ markStale: [], archive: ["abandoned"] });
  });
});

function store(skills: StoredSkill[]): SkillStore & { archived: string[] } {
  const map = new Map(skills.map((s) => [s.name, s]));
  const archived: string[] = [];
  return {
    archived,
    list: async () => [...map.values()].map(({ name, description }) => ({ name, description })),
    get: async (name) => map.get(name) ?? null,
    create: async () => ({ staged: false }),
    update: async () => ({ staged: false }),
    recordView: async () => undefined,
    archive: async (name) => {
      archived.push(name);
    },
  };
}

const base = { description: "d", body: "## Steps\nx", pinned: false, status: "active" as const };

describe("merge pass archive tool", () => {
  it("only exists for the curator", () => {
    const s = store([]);
    expect(createSkillTools(s).some((t) => t.name === "skill_archive")).toBe(false);
    expect(createSkillTools(s, newSkillToolsState(), { allowArchive: true }).some((t) => t.name === "skill_archive")).toBe(true);
  });

  it("requires both skills to be read first, and archives into an active umbrella", async () => {
    const s = store([{ ...base, name: "pull-users" }, { ...base, name: "pull-nova-records" }]);
    const tools = createSkillTools(s, newSkillToolsState(), { allowArchive: true });
    const archive = tools.find((t) => t.name === "skill_archive")!;
    const view = tools.find((t) => t.name === "skill_view")!;

    const blind = await archive.handle({ name: "pull-users", absorbed_into: "pull-nova-records", reason: "same" });
    expect(blind.success).toBe(false);

    await view.handle({ name: "pull-users" });
    await view.handle({ name: "pull-nova-records" });
    const done = await archive.handle({ name: "pull-users", absorbed_into: "pull-nova-records", reason: "same" });
    expect(done.text).toMatch(/Archived/);
    expect(s.archived).toEqual(["pull-users"]);
  });

  it("refuses pinned skills and self-merges", async () => {
    const s = store([{ ...base, name: "a", pinned: true }, { ...base, name: "b" }]);
    const tools = createSkillTools(s, newSkillToolsState(), { allowArchive: true });
    const view = tools.find((t) => t.name === "skill_view")!;
    const archive = tools.find((t) => t.name === "skill_archive")!;
    await view.handle({ name: "a" });
    await view.handle({ name: "b" });
    expect((await archive.handle({ name: "a", absorbed_into: "b", reason: "x" })).text).toMatch(/pinned/);
    expect((await archive.handle({ name: "b", absorbed_into: "b", reason: "x" })).text).toMatch(/itself/);
    expect(s.archived).toEqual([]);
  });
});

describe("learn command", () => {
  it("includes the request and recent conversation for the learner", () => {
    const record = learnRecord("Learn how we just deployed staging", "USER: deploy it\nASSISTANT: done");
    expect(record).toContain("LEARN REQUEST:\nLearn how we just deployed staging");
    expect(record).toContain("RECENT CONVERSATION:\nUSER: deploy it");
  });

  it("is owner-only over iMessage", async () => {
    const previous = process.env.BOOP_OWNER_NUMBERS;
    process.env.BOOP_OWNER_NUMBERS = "+15551234567";
    try {
      expect(await startLearning("sms:+15550000000", "learn x")).toMatch(/Only Boop's owner/);
    } finally {
      process.env.BOOP_OWNER_NUMBERS = previous;
    }
  });

  it("gives the main agent one allowed learn_skill tool", () => {
    expect(createLearnTools("debug").map((t) => t.name)).toEqual(["learn_skill"]);
    expect(LEARN_ALLOWED_TOOLS).toEqual(["mcp__boop-learn__learn_skill"]);
  });
});
