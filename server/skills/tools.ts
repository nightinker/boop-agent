import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { broadcast } from "../broadcast.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import type { RuntimeTool } from "../runtimes/types.js";
import {
  applyPatch,
  formatSkillIndex,
  lintSkill,
  validateDescription,
  validateSkillName,
  type SkillSummary,
} from "./format.js";

export const SKILLS_NAMESPACE = "boop-skills";

export type SkillOrigin = "execution" | "review" | "correction" | "user";

export interface StoredSkill extends SkillSummary {
  body: string;
  pinned: boolean;
  status: "active" | "archived";
}

/** The storage the tools need; Convex in the app, an in-memory fake in tests. */
export interface SkillStore {
  list(): Promise<SkillSummary[]>;
  get(name: string): Promise<StoredSkill | null>;
  create(input: { name: string; description: string; body: string; reason?: string }): Promise<void>;
  update(input: {
    name: string;
    description?: string;
    body: string;
    action: "patch" | "rewrite";
    reason?: string;
  }): Promise<void>;
  recordView(name: string): Promise<void>;
}

export function convexSkillStore(origin: SkillOrigin, agentId?: string): SkillStore {
  return {
    list: async () =>
      (await convex.query(api.skills.list, {})).map((s) => ({
        name: s.name,
        description: s.description,
      })),
    get: async (name) => {
      const skill = await convex.query(api.skills.get, { name });
      return skill
        ? {
            name: skill.name,
            description: skill.description,
            body: skill.body,
            pinned: skill.pinned,
            status: skill.status,
          }
        : null;
    },
    create: async (input) => {
      await convex.mutation(api.skills.create, {
        ...input,
        createdBy: origin === "user" ? "user" : "agent",
        origin,
        agentId,
      });
    },
    update: async (input) => {
      await convex.mutation(api.skills.update, { ...input, origin, agentId });
    },
    recordView: async (name) => {
      await convex.mutation(api.skills.recordView, { name });
    },
  };
}

export interface SkillToolsState {
  /** Skills loaded with skill_view during this run; edits require a fresh view. */
  viewed: Set<string>;
  /** Whether this run wrote a skill (the background review is skipped if so). */
  wrote: boolean;
}

export function newSkillToolsState(): SkillToolsState {
  return { viewed: new Set(), wrote: false };
}

function withWarnings(message: string, body: string): string {
  const warnings = lintSkill(body);
  return warnings.length ? `${message}\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : message;
}

export function createSkillTools(
  store: SkillStore,
  state: SkillToolsState = newSkillToolsState(),
): RuntimeTool[] {
  return [
    defineRuntimeTool(
      SKILLS_NAMESPACE,
      "skill_list",
      "List the saved skills (name and when to use each).",
      {},
      async () => ({ text: formatSkillIndex(await store.list()) }),
    ),
    defineRuntimeTool(
      SKILLS_NAMESPACE,
      "skill_view",
      "Load a skill's full instructions. Load a matching skill before starting a task, and always load it again right before editing it.",
      { name: z.string().describe("Skill name from the skill index.") },
      async ({ name }) => {
        const skill = await store.get(name);
        if (!skill || skill.status !== "active") {
          return { text: `No skill named "${name}". Call skill_list to see what exists.`, success: false };
        }
        state.viewed.add(name);
        await store.recordView(name).catch(() => undefined);
        return {
          text: `# ${skill.name}\n${skill.description}${skill.pinned ? "\n(Pinned: read-only.)" : ""}\n\n${skill.body}`,
        };
      },
    ),
    defineRuntimeTool(
      SKILLS_NAMESPACE,
      "skill_manage",
      [
        "Save or improve a skill: the instructions for doing a class of task well, for this user.",
        "action=create: a new class-level skill (name, description, body).",
        "action=patch: a targeted fix (name, old_string, new_string). Preferred for updates.",
        "action=rewrite: replace the whole body (name, body, optional description).",
        "Call skill_view on the skill first for patch and rewrite. Capture lessons, not logs: steps, the commands and tools that work, the user's preferences, and pitfalls with one clause of why. No dates, PR numbers or chat quotes.",
      ].join(" "),
      {
        action: z.enum(["create", "patch", "rewrite"]),
        name: z.string().describe("Kebab-case, class-level name, e.g. send-weekly-invoices."),
        description: z
          .string()
          .optional()
          .describe("One line: what the skill covers and when to use it."),
        body: z.string().optional().describe("Full markdown body for create or rewrite."),
        old_string: z.string().optional().describe("Exact text to replace (patch)."),
        new_string: z.string().optional().describe("Replacement text (patch)."),
        reason: z.string().optional().describe("Why this change, in one sentence."),
      },
      async (args) => {
        const nameError = validateSkillName(args.name);
        if (nameError) return { text: nameError, success: false };

        if (args.action === "create") {
          const descriptionError = validateDescription(args.description ?? "");
          if (descriptionError) return { text: descriptionError, success: false };
          if (!args.body?.trim()) return { text: "create needs a body.", success: false };
          if (await store.get(args.name)) {
            return {
              text: `"${args.name}" already exists. Call skill_view and patch it instead.`,
              success: false,
            };
          }
          await store.create({
            name: args.name,
            description: args.description!.trim(),
            body: args.body,
            reason: args.reason,
          });
          state.wrote = true;
          state.viewed.add(args.name);
          broadcast("skill_updated", { name: args.name, action: "create" });
          return { text: withWarnings(`Created skill "${args.name}".`, args.body) };
        }

        const skill = await store.get(args.name);
        if (!skill) return { text: `No skill named "${args.name}".`, success: false };
        if (skill.pinned) return { text: `"${args.name}" is pinned; leave it as it is.`, success: false };
        if (!state.viewed.has(args.name)) {
          return {
            text: `Call skill_view for "${args.name}" first, then base your edit on what it returns.`,
            success: false,
          };
        }
        if (args.description !== undefined) {
          const descriptionError = validateDescription(args.description);
          if (descriptionError) return { text: descriptionError, success: false };
        }

        let body: string;
        if (args.action === "patch") {
          const patched = applyPatch(skill.body, args.old_string ?? "", args.new_string ?? "");
          if ("error" in patched) return { text: patched.error, success: false };
          body = patched.body;
        } else {
          if (!args.body?.trim()) return { text: "rewrite needs a body.", success: false };
          body = args.body;
        }

        await store.update({
          name: args.name,
          description: args.description?.trim(),
          body,
          action: args.action,
          reason: args.reason,
        });
        state.wrote = true;
        broadcast("skill_updated", { name: args.name, action: args.action });
        return { text: withWarnings(`Updated skill "${args.name}".`, body) };
      },
    ),
  ];
}
