import { describe, expect, it, vi } from "vitest";

vi.mock("../server/broadcast.js", () => ({ broadcast: vi.fn() }));

import {
  applyPatch,
  formatSkillIndex,
  lintSkill,
  validateDescription,
  validateSkillName,
} from "../server/skills/format.js";
import {
  createSkillTools,
  newSkillToolsState,
  type SkillStore,
  type StoredSkill,
} from "../server/skills/tools.js";
import { formatRunForReview, shouldReviewRun } from "../server/skills/review.js";
import { buildSkillsSection } from "../server/execution-agent.js";

function memoryStore(initial: StoredSkill[] = []): SkillStore & { skills: Map<string, StoredSkill> } {
  const skills = new Map(initial.map((s) => [s.name, { ...s }]));
  return {
    skills,
    list: async () => [...skills.values()].map(({ name, description }) => ({ name, description })),
    get: async (name) => skills.get(name) ?? null,
    create: async (input) => {
      skills.set(input.name, { ...input, pinned: false, status: "active" });
    },
    update: async (input) => {
      const skill = skills.get(input.name)!;
      skills.set(input.name, {
        ...skill,
        body: input.body,
        description: input.description ?? skill.description,
      });
    },
    recordView: async () => undefined,
  };
}

function tool(tools: ReturnType<typeof createSkillTools>, name: string) {
  return tools.find((t) => t.name === name)!;
}

const invoices: StoredSkill = {
  name: "send-weekly-invoices",
  description: "Draft and send the weekly client invoices",
  body: "## Steps\n1. List unbilled time.\n2. Draft the invoice.\n",
  pinned: false,
  status: "active",
};

describe("skill format helpers", () => {
  it("accepts kebab-case names and rejects others", () => {
    expect(validateSkillName("send-weekly-invoices")).toBeNull();
    expect(validateSkillName("Send Invoices")).toMatch(/lowercase/);
    expect(validateSkillName("")).toMatch(/needs a name/);
  });

  it("requires a short description", () => {
    expect(validateDescription("  ")).toMatch(/one-line/);
    expect(validateDescription("x".repeat(301))).toMatch(/under 300/);
    expect(validateDescription("Triage the support inbox")).toBeNull();
  });

  it("patches exactly one occurrence", () => {
    expect(applyPatch("a b c", "b", "B")).toEqual({ body: "a B c" });
    expect(applyPatch("a b b", "b", "B")).toEqual({ error: expect.stringMatching(/more than once/) });
    expect(applyPatch("a b c", "z", "Z")).toEqual({ error: expect.stringMatching(/not found/) });
    expect(applyPatch("a b c", "", "Z")).toEqual({ error: expect.stringMatching(/rewrite/) });
  });

  it("warns about logs, size and missing sections without blocking", () => {
    expect(lintSkill("## Steps\nDo it.")).toEqual([]);
    expect(lintSkill("Fixed in PR 12, PR 13, #145 and #146.").join(" ")).toMatch(/incident log/);
    expect(lintSkill("no sections").join(" ")).toMatch(/## When to use/);
    expect(lintSkill(`## Steps\n${"x".repeat(24_001)}`).join(" ")).toMatch(/trim/);
  });

  it("lists skills for the prompt, or invites the first one", () => {
    expect(formatSkillIndex([])).toMatch(/No skills saved yet/);
    expect(formatSkillIndex([{ name: "a", description: "Do A" }])).toBe("- a: Do A");
  });
});

describe("skill tools", () => {
  it("creates a skill and refuses a duplicate", async () => {
    const store = memoryStore();
    const state = newSkillToolsState();
    const manage = tool(createSkillTools(store, state), "skill_manage");

    const created = await manage.handle({
      action: "create",
      name: "triage-support-inbox",
      description: "Sort the support inbox by urgency",
      body: "## Steps\n1. Read unread mail.",
    });
    expect(created.text).toMatch(/Created/);
    expect(state.wrote).toBe(true);

    const again = await manage.handle({
      action: "create",
      name: "triage-support-inbox",
      description: "Again",
      body: "## Steps\nx",
    });
    expect(again.success).toBe(false);
    expect(again.text).toMatch(/already exists/);
  });

  it("refuses to edit a skill that wasn't viewed in this run", async () => {
    const store = memoryStore([invoices]);
    const tools = createSkillTools(store, newSkillToolsState());

    const blind = await tool(tools, "skill_manage").handle({
      action: "patch",
      name: invoices.name,
      old_string: "Draft the invoice.",
      new_string: "Draft the invoice in EUR.",
    });
    expect(blind.success).toBe(false);
    expect(blind.text).toMatch(/skill_view/);

    await tool(tools, "skill_view").handle({ name: invoices.name });
    const patched = await tool(tools, "skill_manage").handle({
      action: "patch",
      name: invoices.name,
      old_string: "Draft the invoice.",
      new_string: "Draft the invoice in EUR.",
    });
    expect(patched.text).toMatch(/Updated/);
    expect(store.skills.get(invoices.name)!.body).toContain("in EUR");
  });

  it("leaves pinned skills alone", async () => {
    const store = memoryStore([{ ...invoices, pinned: true }]);
    const tools = createSkillTools(store, newSkillToolsState());
    await tool(tools, "skill_view").handle({ name: invoices.name });
    const result = await tool(tools, "skill_manage").handle({
      action: "rewrite",
      name: invoices.name,
      body: "## Steps\nNew",
    });
    expect(result.success).toBe(false);
    expect(result.text).toMatch(/pinned/);
  });

  it("reports a missing skill on view", async () => {
    const result = await tool(createSkillTools(memoryStore()), "skill_view").handle({ name: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("background review", () => {
  it("reviews only tool-heavy runs that didn't already save a skill", () => {
    const base = { toolCallCount: 12, wroteSkill: false, enabled: true, minToolCalls: 10 };
    expect(shouldReviewRun(base)).toBe(true);
    expect(shouldReviewRun({ ...base, toolCallCount: 9 })).toBe(false);
    expect(shouldReviewRun({ ...base, wroteSkill: true })).toBe(false);
    expect(shouldReviewRun({ ...base, enabled: false })).toBe(false);
  });

  it("summarises the run for the reviewer", () => {
    const record = formatRunForReview({
      task: "Send this week's invoices",
      integrations: ["composio-account"],
      toolCalls: [{ tool: "composio_search_tools", input: '{"queries":["invoices"]}', result: "found 2" }],
      result: "Drafted 3 invoices.",
      skillsViewed: ["send-weekly-invoices"],
    });
    expect(record).toContain("TASK:\nSend this week's invoices");
    expect(record).toContain("SKILLS USED IN THIS RUN: send-weekly-invoices");
    expect(record).toContain("1. composio_search_tools");
    expect(record).toContain("→ found 2");
  });
});

describe("execution agent prompt", () => {
  it("adds the skill playbook and index", () => {
    const section = buildSkillsSection("- a: Do A");
    expect(section).toContain("Saved skills:\n- a: Do A");
    expect(section).toContain("skill_view");
  });
});
