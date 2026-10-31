import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import {
  buildMcpServersForIntegrations,
  buildRuntimeToolsForIntegrations,
  listIntegrations,
} from "./integrations/registry.js";
import { createDraftStagingTools } from "./draft-tools.js";
import { EMPTY_USAGE, type UsageTotals } from "./usage.js";
import { getRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { buildPromptWithImages, fetchStoredBytes } from "./images/content-blocks.js";
import { formatSkillIndex } from "./skills/format.js";
import {
  SKILLS_NAMESPACE,
  convexSkillStore,
  createSkillTools,
  newSkillToolsState,
} from "./skills/tools.js";
import { maybeReviewSkillsAfterRun, type ToolCallRecord } from "./skills/review.js";
import {
  ATTACHMENTS_NAMESPACE,
  IMAGE_ATTACHMENTS_PROMPT,
  createImageAttachmentTools,
} from "./images/attach-tool.js";
import { OutboundImageCollector, type OutboundImage } from "./images/outbound.js";
import { isUsageLimitError } from "./usage-limit.js";

const running = new Map<string, AbortController>();

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Composio surfaces the targeted account in a few different shapes depending on
// the tool. Pull whichever one is present so multi-account runs (e.g. 3 Gmail
// inboxes) make the chosen account visible per call.
function extractAccounts(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const accounts = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === "string" && v.trim()) accounts.add(v.trim());
  };
  const obj = input as Record<string, unknown>;
  // Direct fields on the top-level call (single-execute, native Composio tools).
  collect(obj.account);
  collect(obj.connectedAccountId);
  collect(obj.connected_account_id);
  if (Array.isArray(obj.accounts)) obj.accounts.forEach(collect);
  // COMPOSIO_MULTI_EXECUTE_TOOL fans out: { tools: [{ account, ... }] }.
  if (Array.isArray(obj.tools)) {
    for (const t of obj.tools) {
      if (t && typeof t === "object") {
        const tt = t as Record<string, unknown>;
        collect(tt.account);
        collect(tt.connectedAccountId);
        collect(tt.connected_account_id);
      }
    }
  }
  return [...accounts];
}

function isBrowserFillTool(toolName: string): boolean {
  const shortName = toolName.split("__").pop() ?? toolName;
  return shortName === "browser_fill";
}

export function redactToolInputForLog(toolName: string, input: unknown): unknown {
  if (!isBrowserFillTool(toolName)) return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    text: "[redacted]",
  };
}

const EXECUTION_SYSTEM = `You are a focused background worker for the user.

Your job:
1. Perform the task you were given, end to end.
2. Use your tools — WebSearch, WebFetch, and any integrations loaded for this spawn — to investigate and act.
3. Return a concise, well-structured answer — not a data dump.

Research discipline:
- Prefer WebSearch for fresh/factual questions. WebFetch when you need the content of a known URL.
- Cite real URLs only — NEVER invent sources. If a page failed to load, say so.
- Cross-check when it matters: one search is rarely enough for a claim.

Local browser:
- If the optional "browser" integration is loaded, Local browser use is enabled and it controls a local Patchright Chrome/Chromium profile on the user's machine.
- Use browser tools only when native integrations or WebFetch/WebSearch are insufficient: login-only portals, JS-heavy apps, visual workflows, or services likely to detect bots.
- If you hit a login, MFA, or bot wall and the task requires the user's session, call browser_request_login. It opens a visible local browser instance and returns the exact handoff message to show the user.
- After browser_request_login, stop and tell the user what to do next. Do not claim the task is complete until they confirm they logged in.
- Screenshots for a device ("mobile view", "iPhone view", "phone", "tablet view", "iPad", "desktop view", or a size like "1024x768"): call browser_screenshot with device (iphone, pixel, ipad, laptop, desktop) or width/height. Never fake it by resizing the window. Check the "Width check" line: if it says OK, attach the PNG path with attach_image; if it says MISMATCH, say the page did not fit the requested width instead of claiming success. Use fullPage only when the user asks for the whole page.

Apple data:
- If the "apple" integration is loaded, its tools return read-only local Apple data from the user's Mac. iMessage reads run from the local server with Full Disk Access; Apple Notes and Apple Reminders read from the local server with macOS Automation permission; Apple Calendar uses the optional Apple bridge. They never modify anything.
- Never include phone numbers in your response. For iMessage/SMS lookups, refer to contact names, message text, timing, or "the matching thread" instead of phone numbers.

MANDATORY: for any task that used WebSearch or WebFetch, end your response with
a "Sources:" section listing the ACTUAL URLs you fetched or found. Example:

  Sources:
  - https://www.lonelyplanet.com/japan/tokyo
  - https://www.japan-guide.com/e/e3008.html

No URLs = no sources section. Never write vague names like "Lonely Planet" or
"official guide" without the specific URL. The interaction agent relays your
output to the user verbatim, so if you don't include URLs, the user won't see
any.

Style:
- Optimize for iMessage delivery: short sentences, bullets over paragraphs, no tables.
- Prefer markdown with **bold** keywords and • bullets.
- Under 500 words unless explicitly asked for more.
- If you can't complete something, say why in one sentence.

Safety:
- Anything that sends a message, creates an event, or takes an external action: call save_draft with a JSON payload instead of the real send/create tool. Return the summary so the interaction agent can show it to the user.
- Only the interaction agent's send_draft tool commits. You never commit.`;

/**
 * Skills are Boop's procedural memory. The index (names and one-line
 * descriptions) is always in the prompt; full instructions load on demand.
 */
export function buildSkillsSection(index: string): string {
  return `

Skills (your playbook for this user):
- Before you start, check the saved skills below. If one covers this task, call skill_view and follow it.
- While you work: if you find a better way, recover from a dead end, or a skill turns out wrong or missing a step, fix it with skill_manage (skill_view it first). If you work out a repeatable multi-step procedure that no skill covers, create one at the class level.
- Skills hold lessons, not logs: steps, the tools that work, the user's preferences, pitfalls with a short why.

Saved skills:
${index}`;
}

export interface SpawnOptions {
  task: string;
  integrations: string[];
  conversationId?: string;
  name?: string;
  runtimeConfig?: RuntimeConfig;
  imageStorageIds?: string[];
  /**
   * Give the agent the attach_image tool. Only set this when the caller will
   * deliver SpawnResult.attachments to the user (e.g. over iMessage).
   */
  allowImageAttachments?: boolean;
}

export type SpawnExecutionAgentOpts = SpawnOptions;

export interface SpawnResult {
  agentId: string;
  result: string;
  status: "completed" | "failed" | "cancelled";
  /** Images the agent attached with attach_image, validated and loaded. */
  attachments: OutboundImage[];
  /**
   * The model runtime hit a spend/usage limit; `result` is that error, not a
   * real answer. Background callers must not forward it to the user.
   */
  usageLimited?: boolean;
}

export async function spawnExecutionAgent(opts: SpawnExecutionAgentOpts): Promise<SpawnResult> {
  const agentId = randomId("agent");
  const name = opts.name ?? (opts.integrations.join("+") || "general");
  const abort = new AbortController();
  running.set(agentId, abort);

  const shortId = agentId.slice(-6);
  const logAgent = (msg: string) => console.log(`[agent ${shortId}] ${msg}`);
  const taskPreview =
    opts.task.length > 120 ? opts.task.slice(0, 120) + "…" : opts.task;
  logAgent(
    `spawn: ${name} [${opts.integrations.join(", ") || "no integrations"}] images=${opts.imageStorageIds?.length ?? 0} — ${JSON.stringify(taskPreview)}`,
  );
  const agentStart = Date.now();
  const runtimeConfig = opts.runtimeConfig ?? (await getRuntimeConfig());

  await convex.mutation(api.agents.create, {
    agentId,
    conversationId: opts.conversationId,
    name,
    task: opts.task,
    runtime: runtimeConfig.runtime,
    model: runtimeConfig.model,
    reasoningEffort: runtimeConfig.reasoningEffort,
    billingMode: runtimeConfig.billingMode,
    mcpServers: opts.integrations,
  });
  broadcast("agent_spawned", { agentId, name, task: opts.task });

  await convex.mutation(api.agents.update, { agentId, status: "running" });

  const draftTools = opts.conversationId ? createDraftStagingTools(opts.conversationId) : [];
  const skillState = newSkillToolsState();
  const skillTools = createSkillTools(convexSkillStore("execution", agentId), skillState);
  const skillIndex = await convex
    .query(api.skills.list, {})
    .then((skills) => formatSkillIndex(skills))
    .catch(() => formatSkillIndex([]));
  const attachmentCollector = new OutboundImageCollector();
  const attachmentTools = opts.allowImageAttachments
    ? createImageAttachmentTools(attachmentCollector)
    : [];
  const toolCalls: ToolCallRecord[] = [];
  const integrationServers =
    runtimeConfig.runtime === "claude"
      ? await buildMcpServersForIntegrations(opts.integrations, opts.conversationId)
      : {};
  const integrationTools =
    runtimeConfig.runtime === "codex"
      ? await buildRuntimeToolsForIntegrations(opts.integrations, opts.conversationId)
      : [];
  const mcpServers = integrationServers;
  const runtimeTools = [...draftTools, ...attachmentTools, ...skillTools, ...integrationTools];
  const runtimeToolNamespaces = [...new Set(integrationTools.map((tool) => tool.namespace))];
  const allowedTools = [
    "WebSearch",
    "WebFetch",
    "Skill",
    ...Object.keys(mcpServers).flatMap((n) => [`mcp__${n}__*`]),
    ...(draftTools.length ? ["mcp__boop-drafts__*"] : []),
    ...(attachmentTools.length ? [`mcp__${ATTACHMENTS_NAMESPACE}__*`] : []),
    `mcp__${SKILLS_NAMESPACE}__*`,
    ...runtimeToolNamespaces.flatMap((n) => [`mcp__${n}__*`]),
  ];

  let buffer = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  let status: "completed" | "failed" | "cancelled" = "completed";
  let errorMsg: string | undefined;
  let usageLimited = false;

  try {
    const executionPrompt = await buildPromptWithImages({
      text: opts.task,
      imageStorageIds: opts.imageStorageIds,
      fetchBytes: fetchStoredBytes,
    });
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: executionPrompt,
      systemPrompt:
        EXECUTION_SYSTEM +
        (attachmentTools.length ? IMAGE_ATTACHMENTS_PROMPT : "") +
        buildSkillsSection(skillIndex),
      claudeMcpServers: mcpServers,
      tools: runtimeTools,
      allowedTools,
      abortController: abort,
      mode: "execution",
      onText: async (text) => {
        buffer += text;
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "text",
          content: text,
        });
      },
      onToolUse: async (toolName, input) => {
        const toolShort = toolName.replace(/^mcp__[a-z-]+__/, "");
        const accounts = extractAccounts(input);
        const acctSuffix = accounts.length ? ` [${accounts.join(", ")}]` : "";
        logAgent(`tool: ${toolShort}${acctSuffix}`);
        const logInput = redactToolInputForLog(toolName, input);
        toolCalls.push({ tool: toolShort, input: JSON.stringify(logInput).slice(0, 300) });
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "tool_use",
          toolName,
          ...(accounts.length ? { accounts } : {}),
          content: JSON.stringify(logInput).slice(0, 2000),
        });
        broadcast("agent_tool", { agentId, toolName, accounts });
      },
      onToolResult: async (_toolName, text) => {
        const last = toolCalls[toolCalls.length - 1];
        if (last && last.result === undefined) last.result = text.slice(0, 300);
        await convex.mutation(api.agents.addLog, {
          agentId,
          logType: "tool_result",
          content: text.slice(0, 2000),
        });
      },
    });
    if (!buffer) buffer = result.text;
    usage = result.usage;
    if (isUsageLimitError(buffer, result.errorCode) || isUsageLimitError(result.text)) {
      usageLimited = true;
      status = "failed";
      errorMsg = `usage limit: ${(buffer || result.text).trim().slice(0, 500)}`;
      buffer = "";
      await convex.mutation(api.agents.addLog, {
        agentId,
        logType: "error",
        content: errorMsg,
      });
    }
  } catch (err) {
    status = abort.signal.aborted ? "cancelled" : "failed";
    errorMsg = String(err);
    if (isUsageLimitError(err)) usageLimited = true;
    await convex.mutation(api.agents.addLog, {
      agentId,
      logType: "error",
      content: errorMsg,
    });
  } finally {
    running.delete(agentId);
  }

  const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
  logAgent(
    `done (${status}, ${elapsed}s, in/out tokens ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)})`,
  );

  await convex.mutation(api.agents.update, {
    agentId,
    status,
    result: buffer,
    error: errorMsg,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: usage.costUsd,
  });
  // Also append to the usage log so total-cost queries cover every layer.
  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    await convex.mutation(api.usageRecords.record, {
      source: "execution",
      conversationId: opts.conversationId,
      agentId,
      runtime: runtimeConfig.runtime,
      billingMode: runtimeConfig.billingMode,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - agentStart,
    });
  }
  broadcast("agent_done", { agentId, status, result: buffer.slice(0, 200) });

  if (status === "completed") {
    void maybeReviewSkillsAfterRun({
      agentId,
      conversationId: opts.conversationId,
      task: opts.task,
      integrations: opts.integrations,
      toolCalls,
      result: buffer,
      skillsViewed: [...skillState.viewed],
      wroteSkill: skillState.wrote,
      runtimeConfig,
    }).catch((err) => console.error(`[skills] review after ${shortId} failed`, err));
  }

  const attachments = status === "completed" ? attachmentCollector.list : [];
  if (attachmentCollector.list.length > 0) {
    logAgent(
      `attachments: ${attachments.length} delivered of ${attachmentCollector.list.length} attached`,
    );
  }
  return {
    agentId,
    result: buffer || errorMsg || "(no output)",
    status,
    attachments,
    ...(usageLimited ? { usageLimited } : {}),
  };
}

export function cancelAgent(agentId: string): boolean {
  const abort = running.get(agentId);
  if (!abort) return false;
  abort.abort();
  return true;
}

export function runningAgentIds(): string[] {
  return [...running.keys()];
}

export async function retryAgent(agentId: string): Promise<SpawnResult | null> {
  const existing = await convex.query(api.agents.get, { agentId });
  if (!existing) return null;
  const originalRuntime = existing as typeof existing & Partial<RuntimeConfig>;
  const runtimeConfig =
    originalRuntime.runtime && originalRuntime.model && originalRuntime.billingMode
      ? {
          runtime: originalRuntime.runtime,
          model: originalRuntime.model,
          reasoningEffort: originalRuntime.reasoningEffort,
          billingMode: originalRuntime.billingMode,
        }
      : undefined;
  // V1 limitation: image refs are not persisted to executionAgents and
  // therefore are not replayed on retry. Re-trigger from the original
  // turn if you need the image inputs.
  return await spawnExecutionAgent({
    task: existing.task,
    integrations: existing.mcpServers,
    conversationId: existing.conversationId,
    name: existing.name,
    runtimeConfig,
  });
}

export function availableIntegrations(): string[] {
  return listIntegrations().map((i) => i.name);
}
