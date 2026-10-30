import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { getRuntimeConfig, type RuntimeConfig } from "../runtime-config.js";
import { runAgentRuntime } from "../runtimes/index.js";
import { formatSkillIndex } from "./format.js";
import {
  SKILLS_NAMESPACE,
  convexSkillStore,
  createSkillTools,
  newSkillToolsState,
  type SkillOrigin,
} from "./tools.js";

export interface ToolCallRecord {
  tool: string;
  input: string;
  result?: string;
}

/** Below this many tool calls a run is too simple to teach anything. */
export const DEFAULT_REVIEW_MIN_TOOL_CALLS = 10;
const SETTING_REVIEW_ENABLED = "skills_review_enabled";

/** Built-in tools the review must not use: it only reads and writes skills. */
const REVIEW_DISALLOWED_TOOLS = [
  "WebSearch",
  "WebFetch",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Agent",
  "Skill",
];

export const SKILL_REVIEW_PROMPT = `You maintain Boop's skill library: the instructions for doing each class of task well, for this user. Below is a record of work Boop just did. Decide whether it teaches something a future run should know, and if so, save it.

Act when any of these happened:
- The user corrected the approach, the format, the tone or the level of detail. Their preference belongs in the skill for that kind of task, so the next run starts already knowing it.
- A non-trivial technique, workaround, tool choice or sequence of steps worked and would save time next time.
- The run hit errors or dead ends before finding the path that worked.
- A skill that was used turned out wrong, missing a step, or out of date.

How to update, in order of preference:
1. Patch a skill that was used in this run (it is listed below). It was in play, so it is the right one to extend.
2. Patch an existing skill that covers this class of task (see the index).
3. Create a new skill only when nothing covers the class. Name it at the class level (send-weekly-invoices, triage-support-inbox), never after today's specific item, a person, a ticket number or an error message.

Rules:
- Call skill_view on a skill right before patching or rewriting it, and base the edit on what it returns. Prefer action=patch with a small old_string/new_string.
- Write lessons, not logs: steps in order, the tools and inputs that work, the user's preferences, and pitfalls as a rule plus one clause of why. No dates, ids, PR numbers, quoted chat or private data such as phone numbers, addresses or account numbers.
- Keep each skill short enough to load in full. Sections: ## When to use, ## Steps, ## Pitfalls, ## Check it worked.
- Never delete a skill. If two skills overlap, say so in your reply.

If the run was routine and taught nothing new, reply exactly "Nothing to save." and stop. Otherwise make the change, then reply with one line saying what you saved.`;

export function formatRunForReview(input: {
  task: string;
  integrations: string[];
  toolCalls: ToolCallRecord[];
  result: string;
  skillsViewed: string[];
  conversation?: string;
}): string {
  const calls = input.toolCalls
    .map((call, index) => {
      const result = call.result ? `\n   → ${call.result.replace(/\s+/g, " ")}` : "";
      return `${index + 1}. ${call.tool} ${call.input}${result}`;
    })
    .join("\n");
  return [
    `TASK:\n${input.task}`,
    `INTEGRATIONS: ${input.integrations.join(", ") || "none"}`,
    `SKILLS USED IN THIS RUN: ${input.skillsViewed.join(", ") || "none"}`,
    input.conversation ? `RECENT CONVERSATION WITH THE USER:\n${input.conversation}` : "",
    `TOOL CALLS (${input.toolCalls.length}):\n${calls || "none"}`,
    `RESULT RETURNED:\n${input.result.slice(0, 4000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function shouldReviewRun(input: {
  toolCallCount: number;
  wroteSkill: boolean;
  enabled: boolean;
  minToolCalls: number;
}): boolean {
  return input.enabled && !input.wroteSkill && input.toolCallCount >= input.minToolCalls;
}

async function reviewEnabled(): Promise<boolean> {
  const stored = await convex
    .query(api.settings.get, { key: SETTING_REVIEW_ENABLED })
    .catch(() => null);
  if (stored !== null) return stored !== "false";
  return process.env.BOOP_SKILL_REVIEW !== "false";
}

function minToolCalls(): number {
  const parsed = Number(process.env.BOOP_SKILL_REVIEW_MIN_TOOL_CALLS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_MIN_TOOL_CALLS;
}

async function recentConversation(conversationId?: string): Promise<string | undefined> {
  if (!conversationId) return undefined;
  const messages = await convex
    .query(api.messages.recent, { conversationId, limit: 6 })
    .catch(() => []);
  if (messages.length === 0) return undefined;
  return messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 600)}`)
    .join("\n");
}

/** One review at a time, so two runs can't race to create the same skill. */
let queue: Promise<unknown> = Promise.resolve();

async function runReview(input: {
  record: string;
  origin: SkillOrigin;
  agentId?: string;
  conversationId?: string;
  runtimeConfig?: RuntimeConfig;
}): Promise<string> {
  const runtimeConfig = input.runtimeConfig ?? (await getRuntimeConfig());
  const index = formatSkillIndex(
    await convex.query(api.skills.list, {}).catch(() => []),
  );
  const state = newSkillToolsState();
  const started = Date.now();
  const result = await runAgentRuntime(runtimeConfig, {
    prompt: `${input.record}\n\nCURRENT SKILL INDEX:\n${index}`,
    systemPrompt: SKILL_REVIEW_PROMPT,
    tools: createSkillTools(convexSkillStore(input.origin, input.agentId), state),
    allowedTools: [`mcp__${SKILLS_NAMESPACE}__*`],
    disallowedTools: REVIEW_DISALLOWED_TOOLS,
    mode: "background",
  });
  const usage = result.usage;
  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    await convex
      .mutation(api.usageRecords.record, {
        source: "skill-review",
        conversationId: input.conversationId,
        agentId: input.agentId,
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
  const summary = result.text.trim().split("\n").pop() ?? "";
  console.log(
    `[skills] ${input.origin} review ${state.wrote ? "saved" : "no change"}: ${summary.slice(0, 160)}`,
  );
  return summary;
}

function enqueue(job: () => Promise<string>): Promise<string> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Hermes-style background review: after a tool-heavy run that didn't touch a
 * skill, a separate agent with only the skill tools decides what to save.
 * Runs after the reply is delivered, so the user never waits on it.
 */
export async function maybeReviewSkillsAfterRun(input: {
  agentId: string;
  conversationId?: string;
  task: string;
  integrations: string[];
  toolCalls: ToolCallRecord[];
  result: string;
  skillsViewed: string[];
  wroteSkill: boolean;
  runtimeConfig?: RuntimeConfig;
}): Promise<void> {
  const decision = shouldReviewRun({
    toolCallCount: input.toolCalls.length,
    wroteSkill: input.wroteSkill,
    enabled: await reviewEnabled(),
    minToolCalls: minToolCalls(),
  });
  if (!decision) return;
  const conversation = await recentConversation(input.conversationId);
  await enqueue(() =>
    runReview({
      record: formatRunForReview({ ...input, conversation }),
      origin: "review",
      agentId: input.agentId,
      conversationId: input.conversationId,
      runtimeConfig: input.runtimeConfig,
    }),
  );
}

/**
 * A correction or a stated preference is the strongest signal there is: the
 * user told Boop how they want something done. Fold it into the skill for that
 * kind of task.
 */
export async function reviewSkillsForCorrection(input: {
  conversationId: string;
  userMessage: string;
  assistantReply: string;
  corrections: string[];
  runtimeConfig?: RuntimeConfig;
}): Promise<void> {
  if (input.corrections.length === 0 || !(await reviewEnabled())) return;
  const conversation = await recentConversation(input.conversationId);
  const record = [
    "THE USER CORRECTED BOOP OR STATED A PREFERENCE.",
    `CORRECTIONS AND PREFERENCES NOTED:\n${input.corrections.map((c) => `- ${c}`).join("\n")}`,
    conversation ? `RECENT CONVERSATION:\n${conversation}` : "",
    `LATEST USER MESSAGE:\n${input.userMessage}`,
    `BOOP'S REPLY:\n${input.assistantReply}`,
    "Only act if it is about how to do a kind of task (steps, format, tone, level of detail, tools). Personal facts and tastes that aren't about doing a task belong in memory, not skills: reply \"Nothing to save.\" for those.",
  ]
    .filter(Boolean)
    .join("\n\n");
  await enqueue(() =>
    runReview({
      record,
      origin: "correction",
      conversationId: input.conversationId,
      runtimeConfig: input.runtimeConfig,
    }),
  );
}
