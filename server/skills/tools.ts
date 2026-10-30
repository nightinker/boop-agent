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
  summarizeSkillsForListing,
  validateDescription,
  validateSkillName,
  type SkillSummary,
} from "./format.js";

export const SKILLS_NAMESPACE = "boop-skills";
export const SETTING_WRITE_APPROVAL = "skills_write_approval";

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
  /** `staged: true` means it waits for the user's approval instead of applying. */
  create(input: {
    name: string;
    description: string;
    body: string;
    reason?: string;
  }): Promise<{ staged: boolean }>;
  update(input: {
    name: string;
    description: string;
    body: string;
    action: "patch" | "rewrite";
    reason?: string;
  }): Promise<{ staged: boolean }>;
  recordView(name: string): Promise<void>;
}

async function approvalRequired(origin: SkillOrigin): Promise<boolean> {
  if (origin === "user") return false;
  const stored = await convex
    .query(api.settings.get, { key: SETTING_WRITE_APPROVAL })
    .catch(() => null);
  return stored === "true";
}

export function convexSkillStore(origin: SkillOrigin, agentId?: string): SkillStore {
  const batchId = `${origin}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
      if (await approvalRequired(origin)) {
        await convex.mutation(api.skills.stage, {
          ...input,
          action: "create",
          origin,
          agentId,
          batchId,
        });
        return { staged: true };
      }
      await convex.mutation(api.skills.create, { ...input, origin, agentId });
      return { staged: false };
    },
    update: async (input) => {
      if (await approvalRequired(origin)) {
        await convex.mutation(api.skills.stage, { ...input, origin, agentId, batchId });
        return { staged: true };
      }
      await convex.mutation(api.skills.update, { ...input, origin, agentId });
      return { staged: false };
    },
    recordView: async (name) => {
      await convex.mutation(api.skills.recordView, { name });
    },
  };
}

/**
 * The dispatcher's read-only view of the skills: every saved skill as
 * {name, description}, with the description cut to its first line. Cheap and
 * synchronous from the user's point of view (one Convex query, no sub-agent).
 */
export function createListSkillsTool(store: Pick<SkillStore, "list">): RuntimeTool {
  return defineRuntimeTool(
    SKILLS_NAMESPACE,
    "list_skills",
    "List every saved skill as JSON {skills: [{name, description}]}, where description is the skill's one-line description. Use when the user asks what skills Boop has. An empty list means no skills are saved yet.",
    {},
    async () => {
      try {
        const skills = summarizeSkillsForListing(await store.list());
        return { text: JSON.stringify({ skills }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { text: `Could not load the saved skills: ${message}`, success: false };
      }
    },
  );
}

export interface SkillToolsState {
  /** Skills loaded with skill_view during this run; edits require a fresh view. */
  viewed: Set<string>;
  /** Edits this run staged for approval, so later edits build on them. */
  staged: Map<string, StoredSkill>;
  /** Whether this run wrote a skill (the background review is skipped if so). */
  wrote: boolean;
}

export function newSkillToolsState(): SkillToolsState {
  return { viewed: new Set(), staged: new Map(), wrote: false };
}

function withWarnings(message: string, body: string): string {
  const warnings = lintSkill(body);
  return warnings.length ? `${message}\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : message;
}

export function createSkillTools(
  store: SkillStore,
  state: SkillToolsState = newSkillToolsState(),
): RuntimeTool[] {
  const read = async (name: string) => state.staged.get(name) ?? (await store.get(name));
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
        const skill = await read(name);
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
          if (await read(args.name)) {
            return {
              text: `"${args.name}" already exists. Call skill_view and patch it instead.`,
              success: false,
            };
          }
          const { staged } = await store.create({
            name: args.name,
            description: args.description!.trim(),
            body: args.body,
            reason: args.reason,
          });
          state.wrote = true;
          state.viewed.add(args.name);
          if (staged) {
            state.staged.set(args.name, {
              name: args.name,
              description: args.description!.trim(),
              body: args.body,
              pinned: false,
              status: "active",
            });
          }
          broadcast("skill_updated", { name: args.name, action: "create", staged });
          return {
            text: withWarnings(
              staged
                ? `Proposed new skill "${args.name}"; it waits for the user's approval in the dashboard.`
                : `Created skill "${args.name}".`,
              args.body,
            ),
          };
        }

        const skill = await read(args.name);
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

        const { staged } = await store.update({
          name: args.name,
          description: args.description?.trim() || skill.description,
          body,
          action: args.action,
          reason: args.reason,
        });
        state.wrote = true;
        if (staged) {
          state.staged.set(args.name, {
            ...skill,
            body,
            description: args.description?.trim() || skill.description,
          });
        }
        broadcast("skill_updated", { name: args.name, action: args.action, staged });
        return {
          text: withWarnings(
            staged
              ? `Proposed an edit to "${args.name}"; it waits for the user's approval in the dashboard.`
              : `Updated skill "${args.name}".`,
            body,
          ),
        };
      },
    ),
  ];
}
