import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { notifyConversation } from "../notify.js";
import { getRuntimeConfig } from "../runtime-config.js";
import { runAgentRuntime } from "../runtimes/index.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { isOwnerConversation } from "../self-build/plan.js";
import { formatSkillIndex } from "./format.js";
import {
  SKILLS_NAMESPACE,
  convexSkillStore,
  createSkillTools,
  newSkillToolsState,
} from "./tools.js";

export const LEARN_NAMESPACE = "boop-learn";
export const LEARN_ALLOWED_TOOLS = [`mcp__${LEARN_NAMESPACE}__learn_skill`];

export const LEARN_PROMPT = `You turn a source into a skill for Boop: the instructions for doing one class of task well, for this user.

The request says what to learn and where from:
- A link: read it with WebFetch (follow a few linked pages only if the procedure continues there).
- A file on this Mac: read it with Read.
- Notes the user pasted: they are in the request.
- "What we just did" or similar: work from the recent conversation below.

Then:
1. Call skill_list. If a skill already covers this class of task, call skill_view on it and extend it with action=patch. Otherwise create one with a class-level name (send-weekly-invoices, deploy-staging), never a name tied to one page, person or date.
2. Write lessons, not a copy of the source: when to use it, the steps in order, the exact commands, settings or tools that matter, the user's stated preferences, and pitfalls with one clause of why. Distil long sources; keep the body well under 20,000 characters. No private data such as passwords, tokens or account numbers.
3. Sections: ## When to use, ## Steps, ## Pitfalls, ## Check it worked.

Finish with one plain sentence for the user naming the skill and what it covers, or why you couldn't learn it (for example the page wouldn't load).`;

const LEARN_DISALLOWED_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit", "Agent", "Skill"];

export function learnRecord(request: string, conversation?: string): string {
  return [
    `LEARN REQUEST:\n${request}`,
    conversation ? `RECENT CONVERSATION:\n${conversation}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function recentConversation(conversationId: string): Promise<string | undefined> {
  const messages = await convex.query(api.messages.recent, { conversationId, limit: 12 }).catch(() => []);
  if (messages.length === 0) return undefined;
  return messages.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1200)}`).join("\n");
}

async function runLearn(conversationId: string, request: string): Promise<void> {
  const runtimeConfig = await getRuntimeConfig();
  const index = formatSkillIndex(await convex.query(api.skills.list, {}).catch(() => []));
  const state = newSkillToolsState();
  const started = Date.now();
  const result = await runAgentRuntime(runtimeConfig, {
    prompt: `${learnRecord(request, await recentConversation(conversationId))}\n\nCURRENT SKILL INDEX:\n${index}`,
    systemPrompt: LEARN_PROMPT,
    tools: createSkillTools(convexSkillStore("learn"), state),
    allowedTools: ["WebFetch", "WebSearch", "Read", "Glob", "Grep", `mcp__${SKILLS_NAMESPACE}__*`],
    disallowedTools: LEARN_DISALLOWED_TOOLS,
    mode: "background",
  });
  const usage = result.usage;
  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    await convex
      .mutation(api.usageRecords.record, {
        source: "skill-learn",
        conversationId,
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
  const summary = result.text.trim().split("\n").filter(Boolean).pop() ?? "";
  const message = state.wrote
    ? summary || "Learned it and saved it as a skill."
    : `I couldn't turn that into a skill. ${summary}`.trim();
  console.log(`[skills] learn ${state.wrote ? "saved" : "no change"}: ${summary.slice(0, 160)}`);
  await notifyConversation(conversationId, message, "skill_learned");
}

export async function startLearning(conversationId: string, request: string): Promise<string> {
  if (!isOwnerConversation(conversationId, process.env.BOOP_OWNER_NUMBERS)) {
    return "Only Boop's owner can teach it new skills.";
  }
  void runLearn(conversationId, request).catch(async (err) => {
    console.error("[skills] learn failed", err);
    await notifyConversation(
      conversationId,
      `I couldn't learn that: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      "skill_learned",
    );
  });
  return "Learning it now in the background. I'll text you when the skill is saved.";
}

export function createLearnTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      LEARN_NAMESPACE,
      "learn_skill",
      "Teach Boop a skill from a link, a file on this Mac, notes the user pasted, or what was just done in this conversation. Runs in the background and texts the user when the skill is saved.",
      {
        request: z
          .string()
          .describe(
            "What to learn and where from, written out fully: the task, the link or file path, or the pasted notes, or 'what we just did: <task>'.",
          ),
      },
      async ({ request }) => runtimeText(await startLearning(conversationId, request)),
    ),
  ];
}

export const LEARN_INSTRUCTIONS = `
Learning skills:
When the user asks you to learn how to do something, remember a procedure, or turn a link, a document, pasted notes or "what we just did" into a skill, call learn_skill with the full request (include the link, path or notes). Confirm in one line that you're on it; it texts them when the skill is saved. Not for personal facts: those go to write_memory.`;
