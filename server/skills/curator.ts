import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { broadcast } from "../broadcast.js";
import { runningAgentIds } from "../execution-agent.js";
import { getRuntimeConfig } from "../runtime-config.js";
import { runAgentRuntime } from "../runtimes/index.js";
import { formatSkillIndex } from "./format.js";
import {
  SKILLS_NAMESPACE,
  convexSkillStore,
  createSkillTools,
  newSkillToolsState,
} from "./tools.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SETTING_CURATOR_ENABLED = "skills_curator_enabled";
export const SETTING_CONSOLIDATE = "skills_consolidate";
export const SETTING_LAST_RUN = "skills_curator_last_run";
export const SETTING_LAST_SUMMARY = "skills_curator_last_summary";
const SETTING_LAST_CONSOLIDATE = "skills_consolidate_last_run";

const PRUNE_EVERY_MS = DAY_MS;
const CONSOLIDATE_EVERY_MS = 7 * DAY_MS;

export interface CuratorConfig {
  staleAfterDays: number;
  archiveAfterDays: number;
}

export const DEFAULT_CURATOR_CONFIG: CuratorConfig = { staleAfterDays: 14, archiveAfterDays: 30 };

export interface CuratableSkill {
  name: string;
  status: "active" | "archived";
  pinned: boolean;
  stale?: boolean;
  lastUsedAt?: number;
  createdAt: number;
}

/**
 * The deterministic pass (no model): skills unused for a while go stale, then
 * archived. A never-used skill counts from when it was created, so it gets
 * the full grace period. Pinned skills are never touched.
 */
export function decideCuration(
  skills: CuratableSkill[],
  now: number,
  config: CuratorConfig = DEFAULT_CURATOR_CONFIG,
): { markStale: string[]; archive: string[] } {
  const markStale: string[] = [];
  const archive: string[] = [];
  for (const skill of skills) {
    if (skill.status !== "active" || skill.pinned) continue;
    const idleDays = (now - (skill.lastUsedAt ?? skill.createdAt)) / DAY_MS;
    if (idleDays >= config.archiveAfterDays) archive.push(skill.name);
    else if (idleDays >= config.staleAfterDays && !skill.stale) markStale.push(skill.name);
  }
  return { markStale, archive };
}

export const CONSOLIDATE_PROMPT = `You tidy Boop's skill library. Each skill is the instructions for one class of task, for this user. Over time narrow, overlapping skills pile up; merge them into class-level ones.

1. Read the index below. Look for skills that cover the same class of task or are narrow cases of a broader one.
2. For each group worth merging: skill_view every skill in it, pick or create the class-level umbrella, and patch the umbrella so it keeps every distinct step, preference and pitfall from the others (nothing useful may be lost). Then skill_archive each absorbed skill with absorbed_into set to the umbrella.
3. Leave skills that are distinct alone. Never touch pinned skills. Don't rewrite a skill just to restyle it.

If nothing overlaps, reply exactly "Nothing to merge." Otherwise reply with one line per merge: "a, b → umbrella".`;

async function setting(key: string): Promise<string | null> {
  return await convex.query(api.settings.get, { key }).catch(() => null);
}

async function consolidate(): Promise<string[]> {
  const skills = await convex.query(api.skills.list, {});
  const candidates = skills.filter((s) => !s.pinned);
  if (candidates.length < 2) return [];
  const runtimeConfig = await getRuntimeConfig();
  const state = newSkillToolsState();
  const started = Date.now();
  const result = await runAgentRuntime(runtimeConfig, {
    prompt: `SKILL INDEX:\n${formatSkillIndex(candidates)}`,
    systemPrompt: CONSOLIDATE_PROMPT,
    tools: createSkillTools(convexSkillStore("curator"), state, { allowArchive: true }),
    allowedTools: [`mcp__${SKILLS_NAMESPACE}__*`],
    disallowedTools: ["WebSearch", "WebFetch", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "Skill"],
    mode: "background",
  });
  const usage = result.usage;
  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    await convex
      .mutation(api.usageRecords.record, {
        source: "skill-curator",
        runtime: runtimeConfig.runtime,
        billingMode: runtimeConfig.billingMode,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd,
        durationMs: Date.now() - started,
      })
      .catch(() => undefined);
  }
  return result.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("→"));
}

export interface CuratorSummary {
  at: number;
  markedStale: string[];
  archived: string[];
  merged: string[];
  skipped?: string;
}

let running = false;

/**
 * Runs when due (daily prune, weekly merge pass if enabled) or right away
 * with `force`. Skips while agents are working so it never competes with a task.
 */
export async function runCurator(options: { force?: boolean; consolidate?: boolean } = {}): Promise<CuratorSummary> {
  const now = Date.now();
  const empty: CuratorSummary = { at: now, markedStale: [], archived: [], merged: [] };
  if (running) return { ...empty, skipped: "already running" };
  if ((await setting(SETTING_CURATOR_ENABLED)) === "false" && !options.force) {
    return { ...empty, skipped: "turned off" };
  }
  if (!options.force) {
    const last = Number((await setting(SETTING_LAST_RUN)) ?? 0);
    if (now - last < PRUNE_EVERY_MS) return { ...empty, skipped: "not due" };
    if (runningAgentIds().length > 0) return { ...empty, skipped: "agents busy" };
  }

  running = true;
  try {
    const skills = await convex.query(api.skills.list, { includeArchived: true });
    const decision = decideCuration(skills, now);
    if (decision.markStale.length || decision.archive.length) {
      await convex.mutation(api.skills.applyCuration, {
        ...decision,
        reason: `Unused for ${DEFAULT_CURATOR_CONFIG.archiveAfterDays}+ days`,
      });
    }

    let merged: string[] = [];
    const consolidateOn = options.consolidate ?? (await setting(SETTING_CONSOLIDATE)) === "true";
    const lastConsolidate = Number((await setting(SETTING_LAST_CONSOLIDATE)) ?? 0);
    if (consolidateOn && (options.force || now - lastConsolidate >= CONSOLIDATE_EVERY_MS)) {
      merged = await consolidate();
      await convex.mutation(api.settings.set, { key: SETTING_LAST_CONSOLIDATE, value: String(now) });
    }

    const summary: CuratorSummary = {
      at: now,
      markedStale: decision.markStale,
      archived: decision.archive,
      merged,
    };
    await convex.mutation(api.settings.set, { key: SETTING_LAST_RUN, value: String(now) });
    await convex.mutation(api.settings.set, { key: SETTING_LAST_SUMMARY, value: JSON.stringify(summary) });
    broadcast("skills_curated", summary);
    console.log(
      `[skills] curator: ${summary.markedStale.length} stale, ${summary.archived.length} archived, ${summary.merged.length} merged`,
    );
    return summary;
  } finally {
    running = false;
  }
}

export function startCuratorLoop(intervalMs = 6 * 60 * 60 * 1000): () => void {
  const tick = () => void runCurator().catch((err) => console.error("[skills] curator failed", err));
  const first = setTimeout(tick, 2 * 60 * 1000);
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
