import { z } from "zod";
import {
  CURATED_TOOLKITS,
  listConnectedToolkits,
  listToolkitMeta,
  listToolsForToolkit,
} from "./composio.js";
import { activeProvider as activeEmbeddingProvider } from "./embeddings.js";
import { listEnabledIntegrations } from "./integrations/registry.js";
import {
  COMPOSIO_ACCOUNT_INTEGRATION,
  currentComposioAccountToolkits,
} from "./integrations/composio-account-loader.js";
import { createClaudeMcpServer } from "./runtimes/claude.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeReasoningEffort, type RuntimeTool } from "./runtimes/types.js";
import {
  CODEX_MODEL_ALIASES,
  KNOWN_CODEX_MODELS,
  KNOWN_MODELS,
  MODEL_ALIASES,
  RUNTIME_ALIASES,
  getRuntimeConfig,
  getBrowserSettings,
  resolveModelInput,
  resolveRuntimeInput,
  setCodexReasoningEffort,
  setRuntimeModel,
  setRuntimeProvider,
} from "./runtime-config.js";
import {
  describeUserNow,
  resolveTimezoneInput,
  setUserTimezone,
} from "./timezone-config.js";
import { formatUptime, serverUptimeSeconds } from "./uptime.js";
import { checkCswapLogin, getClaudeAccount, listCswapAccounts, switchCswapAccount } from "./claude-account.js";
import {
  describeCswapAccount,
  formatCswapSection,
  resolveCswapInput,
  switchToCswapAccount,
  type CswapLookup,
} from "./claude-cswap-accounts.js";
import {
  clearClaudeProfile,
  clearClaudeProfileCache,
  describeProfile,
  formatProfileList,
  listClaudeProfiles,
  resolveProfileInput,
  setClaudeProfile,
} from "./claude-profiles.js";
import { isOwnerConversation } from "./self-build/plan.js";
import { convexSkillStore, createListSkillsTool } from "./skills/tools.js";

const NAMESPACE = "boop-self";

const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

const NOT_OWNER_ACCOUNT_MESSAGE = "Only Boop's owner can see or switch the Claude account Boop uses.";

/**
 * Owner-only, like self-build. With no conversation (e.g. a bare MCP
 * server) there is no owner to check, so the account tools refuse.
 */
function isOwner(conversationId: string | undefined): boolean {
  return conversationId !== undefined && isOwnerConversation(conversationId, process.env.BOOP_OWNER_NUMBERS);
}

async function lookupCswap(): Promise<CswapLookup> {
  try {
    return { ok: true, state: await listCswapAccounts() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `cswap is installed but \`cswap list\` failed: ${message.split("\n")[0].slice(0, 200)}` };
  }
}

export function createSelfTools(conversationId?: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "get_config",
      "Return Boop's runtime configuration: active provider, model, billing mode, user's timezone, current local time, loaded integrations, and basic env info. Use when the user asks what model/provider/runtime Boop is using, what time it is, what timezone is active, or anything about the agent itself.",
      {},
      async () => {
        const integrations = (await listEnabledIntegrations()).map((i) => i.name);
        const tzInfo = await describeUserNow();
        const runtime = await getRuntimeConfig();
        const browser = await getBrowserSettings();
        const config = {
          runtime: runtime.runtime,
          model: runtime.model,
          reasoningEffort: runtime.reasoningEffort ?? null,
          billingMode: runtime.billingMode,
          claudeEnvDefault: process.env.BOOP_MODEL ?? "claude-sonnet-5-5",
          codexEnvDefault: process.env.BOOP_CODEX_MODEL ?? "gpt-5.5",
          availableClaudeModels: [...KNOWN_MODELS],
          availableCodexModels: [...KNOWN_CODEX_MODELS],
          userTimezone: tzInfo.isExplicit ? tzInfo.timezone : null,
          timezoneFallback: tzInfo.isExplicit ? null : tzInfo.timezone,
          currentLocalTime: tzInfo.now,
          integrationsLoaded: integrations,
          integrationCount: integrations.length,
          browser: {
            enabled: browser.enabled,
            showUi: browser.showUi,
            loginHandoffEnabled: browser.loginHandoffEnabled,
            profileDir: browser.profileDir,
            startUrl: browser.startUrl || null,
            channel: browser.channel,
            executablePath: browser.executablePath || null,
            extraArgs: browser.extraArgs,
          },
          composioEnabled: Boolean(process.env.COMPOSIO_API_KEY),
          embeddingsEnabled: true,
          embeddingsProvider: activeEmbeddingProvider(),
          sendblueEnabled: Boolean(process.env.SENDBLUE_API_KEY),
        };
        return runtimeText(JSON.stringify(config, null, 2));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "uptime",
      'Return how long the Boop server process has been running, as a compact line like "Up 3h 12m". Use when the user asks how long Boop has been up/running ("uptime?", "how long have you been up?"). Reply with just that line.',
      {},
      async () => runtimeText(formatUptime(serverUptimeSeconds())),
    ),
    createListSkillsTool(convexSkillStore("user"), NAMESPACE),
    defineRuntimeTool(
      NAMESPACE,
      "list_claude_accounts",
      "List the Claude accounts Boop can use and which one it is on: accounts managed by cswap (claude-swap, the owner's account switcher, e.g. \"cswap 3 — me@globex.example (Globex)\") and separate Claude config dirs signed in on this Mac (~/.claude, ~/.claude-work). Shows labels, emails and org names only, never credentials. Says clearly if cswap isn't installed. Owner only. Use when the owner asks which Claude account Boop is on or which ones it can switch to.",
      {},
      async () => {
        if (!isOwner(conversationId)) return runtimeText(NOT_OWNER_ACCOUNT_MESSAGE, false);
        const [{ profiles, savedLabel, active }, cswap] = await Promise.all([listClaudeProfiles(), lookupCswap()]);
        const runtime = (await getRuntimeConfig()).runtime;
        const sections = [
          "Config-dir accounts:\n" +
            formatProfileList(profiles, savedLabel, {
              otherAccounts: cswap.ok && cswap.state.accounts.length > 0,
            }),
          formatCswapSection(cswap, !active || active.isDefault),
        ];
        if (runtime === "codex") {
          sections.push(
            "Note: Boop is on the Codex runtime right now, so the Claude account only matters once you switch back to Claude.",
          );
        }
        return runtimeText(sections.join("\n\n"));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "set_claude_account",
      "Switch which Claude account Boop uses. Accepts a config-dir label from list_claude_accounts (e.g. \"default\", \"work\"), or a cswap account by number (\"cswap 8\" or \"8\"), email, or org name (e.g. \"globex\"). Config-dir labels win when a name matches both. A cswap account is switched with `cswap switch`, which also changes this Mac's main Claude login (as for the desktop app). Saves the choice and applies from the next turn; no restart needed. If the account needs a fresh browser login, it changes nothing and returns the steps for the owner to run in Terminal. Owner only. NEVER ask for, accept or repeat passwords, API keys, tokens or login codes: if the owner offers one, refuse and tell them to sign in with `claude` in Terminal instead.",
      {
        account: z
          .string()
          .describe('Config-dir label (e.g. "work"), cswap number ("cswap 8"), email, or org name (e.g. "globex").'),
      },
      async ({ account }) => {
        if (!isOwner(conversationId)) return runtimeText(NOT_OWNER_ACCOUNT_MESSAGE, false);
        const { profiles, active } = await listClaudeProfiles();
        const target = resolveProfileInput(account, profiles);
        const lines: string[] = [];
        if (target) {
          if (active?.label === target.label) {
            return runtimeText(`Boop is already using the ${describeProfile(target)} account.`);
          }
          await setClaudeProfile(target);
          lines.push(
            `Claude account set to ${describeProfile(target)}. Boop uses it from the next turn on; no restart needed.`,
          );
          const check = await getClaudeAccount({ fresh: true }).catch(() => null);
          if (check && !check.loggedIn) {
            lines.push(
              `Heads up: Claude Code reports that login as signed out. Run \`CLAUDE_CONFIG_DIR=${target.configDir} claude\` in Terminal to sign in again, or switch back.`,
            );
          }
        } else {
          const cswap = await lookupCswap();
          const match =
            cswap.ok && cswap.state.available
              ? resolveCswapInput(account, cswap.state.accounts)
              : ({ kind: "none" } as const);
          if (match.kind === "ambiguous") {
            return runtimeText(
              `"${account.slice(0, 60)}" matches more than one cswap account: ${match.accounts.map(describeCswapAccount).join("; ")}. Which one? (e.g. "cswap ${match.accounts[0].number}")`,
              false,
            );
          }
          if (match.kind === "none") {
            const known = [
              ...profiles.map((p) => p.label),
              ...(cswap.ok ? cswap.state.accounts.map((a) => `cswap ${a.number}`) : []),
            ];
            const cswapNote = !cswap.ok
              ? ` ${cswap.error}`
              : !cswap.state.available
                ? ` ${formatCswapSection(cswap, true).replace(/^cswap accounts: /, "")}`
                : "";
            return runtimeText(
              `No Claude account called "${account.slice(0, 60)}".` +
                (known.length ? ` Available: ${known.join(", ")}.` : "") +
                cswapNote +
                " To add one, sign in with `claude` in Terminal, then run `cswap add`.",
              false,
            );
          }
          const result = await switchToCswapAccount(match.account, !active || active.isDefault, {
            checkLogin: checkCswapLogin,
            switchAccount: switchCswapAccount,
            useMainLogin: async () => {
              await clearClaudeProfile();
              clearClaudeProfileCache();
            },
            readMainLogin: () => getClaudeAccount({ fresh: true }),
          });
          if (!result.ok) return runtimeText(result.text, false);
          lines.push(result.text);
        }
        if (process.env.ANTHROPIC_API_KEY) {
          lines.push(
            "Note: an Anthropic API key is set in Boop's environment, and Claude Code bills that key ahead of any signed-in account, so this switch won't change billing until it's removed.",
          );
        }
        if ((await getRuntimeConfig()).runtime === "codex") {
          lines.push("Boop is on the Codex runtime right now; the account applies once you switch back to Claude.");
        }
        return runtimeText(lines.join("\n"));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "set_timezone",
      `Save the user's timezone so Boop can reason about deadlines, "today", "9am tomorrow", and other local-time references correctly. Accepts an IANA timezone ID (e.g. "America/Chicago", "Europe/London") or a friendly alias ("central", "PT", "Dallas", "Tokyo", "UTC", etc.).

Use when the user tells you their timezone or location ("I'm in Dallas", "use central time", "I'm in London"), or proactively after asking when get_config returns a null userTimezone and you need local-time context for the user's request. Don't guess from prior messages — if you're unsure, just ask once.`,
      {
        timezone: z
          .string()
          .describe(
            'Timezone the user just told you. IANA format like "America/New_York" or alias like "eastern" / "Dallas".',
          ),
      },
      async ({ timezone }) => {
        const resolved = resolveTimezoneInput(timezone);
        if (!resolved) {
          return runtimeText(
            `"${timezone}" isn't a recognized timezone or alias. Pass a canonical IANA ID like "America/Chicago" / "Europe/London" / "Asia/Tokyo", or a friendly name like "central" / "pacific" / "London" / "Tokyo". Ask the user to clarify if needed.`,
            false,
          );
        }
        await setUserTimezone(resolved);
        const tzInfo = await describeUserNow();
        return runtimeText(
          `User timezone set to ${resolved}. Local time there is now ${tzInfo.now}. This will be used for all future date/time reasoning.`,
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "set_runtime",
      `Switch Boop's provider/runtime for future turns. The change applies to the next top-level turn. Accepts aliases: ${Object.keys(RUNTIME_ALIASES)
        .map((k) => `"${k}"`)
        .join(", ")}. Use "claude" for the Anthropic Claude Agent SDK provider and "codex" for the local Codex app-server provider backed by the user's ChatGPT/Codex subscription.`,
      { runtime: z.string().describe('Runtime/provider to use, e.g. "claude" or "codex".') },
      async ({ runtime }) => {
        const resolved = resolveRuntimeInput(runtime);
        if (!resolved) {
          return runtimeText(
            `Unknown runtime "${runtime}". Try one of: ${Object.keys(RUNTIME_ALIASES).join(", ")}.`,
            false,
          );
        }
        await setRuntimeProvider(resolved);
        return runtimeText(
          `Runtime set to ${resolved}. Next top-level turn will use ${resolved}; this current turn keeps the provider it started with.`,
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "set_model",
      `Switch the model for the currently active runtime. The change applies to the next top-level turn; this turn keeps the model it started with.

Claude aliases: ${Object.keys(MODEL_ALIASES).map((k) => `"${k}"`).join(", ")}
Claude canonical: ${[...KNOWN_MODELS].map((k) => `"${k}"`).join(", ")}
Codex aliases: ${Object.keys(CODEX_MODEL_ALIASES).map((k) => `"${k}"`).join(", ")}
Codex canonical: ${[...KNOWN_CODEX_MODELS].map((k) => `"${k}"`).join(", ")}

Use when the user says "use opus", "switch to sonnet", "use Codex mini", "make it faster", etc.`,
      {
        model: z
          .string()
          .describe('Model to use. Canonical ID like "claude-opus-5-5" or "gpt-5.4-mini", or an alias.'),
      },
      async ({ model }) => {
        const runtime = (await getRuntimeConfig()).runtime;
        const resolved = resolveModelInput(model, runtime);
        if (!resolved) {
          const known = runtime === "codex" ? [...KNOWN_CODEX_MODELS] : [...KNOWN_MODELS];
          const aliases = runtime === "codex" ? CODEX_MODEL_ALIASES : MODEL_ALIASES;
          return runtimeText(
            `Unknown ${runtime} model "${model}". Try one of: ${known.join(", ")} or aliases ${Object.keys(aliases).join(", ")}.`,
            false,
          );
        }
        await setRuntimeModel(resolved, runtime);
        return runtimeText(
          `${runtime} model override set to ${resolved}. Next top-level turn will use it; this current turn keeps the previous model.`,
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "set_codex_reasoning_effort",
      "Set Codex reasoning effort for future Codex turns. Use low for speed, medium for default work, high/xhigh for deeper work.",
      { effort: reasoningEffortSchema },
      async ({ effort }) => {
        await setCodexReasoningEffort(effort as RuntimeReasoningEffort);
        return runtimeText(`Codex reasoning effort set to ${effort}. Next Codex turn will use it.`);
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "list_integrations",
      "List the user's currently connected integrations (Gmail, Slack, etc.) with the actual account behind each connection. Use when the user asks 'what tools do I have connected?' or 'which Gmail account?' or 'what integrations are set up?'.",
      {},
      async () => {
        const connected = await listConnectedToolkits();
        const summary: Array<Record<string, string>> = connected.map((c) => ({
          slug: c.slug,
          status: c.status,
          account: c.accountLabel ?? c.accountEmail ?? c.alias ?? "(unknown)",
          connectionId: c.connectionId,
        }));
        const personal = await currentComposioAccountToolkits().catch(() => []);
        for (const slug of personal) {
          summary.push({
            slug,
            status: "ACTIVE",
            account: `personal Composio account — spawn with integration "${COMPOSIO_ACCOUNT_INTEGRATION}"`,
          });
        }
        return runtimeText(
          summary.length === 0
            ? "No integrations are currently connected. The user can connect new ones from the Connections panel in the debug UI."
            : JSON.stringify(summary, null, 2),
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "search_composio_catalog",
      "Search Composio's full toolkit catalog (1000+ services) by keyword. Returns matching toolkit slugs and descriptions. Use when the user asks 'is there a tool for X?', 'can you connect to Y?', or 'is Z available?' — e.g. 'is there a Notion integration?', 'can you talk to Zendesk?'.",
      {
        query: z
          .string()
          .describe("Keyword to match against toolkit slug, name, or description (case-insensitive)."),
        limit: z.number().int().min(1).max(50).optional().default(15),
      },
      async ({ query, limit }) => {
        const meta = await listToolkitMeta();
        const q = query.trim().toLowerCase();
        const matches: Array<{ slug: string; name: string; description?: string; toolsCount?: number }> = [];
        for (const t of meta.values()) {
          const haystack = `${t.slug} ${t.name} ${t.description ?? ""}`.toLowerCase();
          if (haystack.includes(q)) {
            matches.push({
              slug: t.slug,
              name: t.name,
              description: t.description,
              toolsCount: t.toolsCount,
            });
          }
          if (matches.length >= limit) break;
        }
        return runtimeText(
          matches.length === 0
            ? `No toolkits in Composio's catalog match "${query}".`
            : JSON.stringify(matches, null, 2),
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "inspect_toolkit",
      "Look up a specific Composio toolkit by exact slug. Returns whether it exists, whether it's currently connected, and (if requested) the list of tools it exposes. Use when the user asks 'what can the Slack tool do?' or 'is Notion connected?'.",
      {
        slug: z
          .string()
          .describe("Exact toolkit slug, e.g. 'gmail', 'slack', 'notion', 'linear'. Lowercase."),
        includeTools: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, also fetch the toolkit's tool list (slower)."),
      },
      async ({ slug, includeTools }) => {
        const lower = slug.trim().toLowerCase();
        const meta = await listToolkitMeta();
        const toolkit = meta.get(lower);
        if (!toolkit) {
          return runtimeText(
            `Toolkit "${lower}" is not in Composio's catalog. Try search_composio_catalog with a keyword to find similar ones.`,
            false,
          );
        }
        const connected = (await listConnectedToolkits()).filter((c) => c.slug === lower);
        const curated = CURATED_TOOLKITS.find((t) => t.slug === lower);
        const result: {
          slug: string;
          name: string;
          description?: string;
          toolsCount?: number;
          inCuratedList: boolean;
          authMode?: string;
          connections: Array<{ status: string; account: string; id: string }>;
          availableForSpawn: boolean;
          tools?: Array<{ slug: string; name: string; description?: string }>;
        } = {
          slug: toolkit.slug,
          name: toolkit.name,
          description: toolkit.description,
          toolsCount: toolkit.toolsCount,
          inCuratedList: Boolean(curated),
          authMode: curated?.authMode,
          connections: connected.map((c) => ({
            status: c.status,
            account: c.accountLabel ?? c.accountEmail ?? c.alias ?? "(unknown)",
            id: c.connectionId,
          })),
          availableForSpawn: (await listEnabledIntegrations()).some((i) => i.name === lower),
        };
        if (includeTools) {
          result.tools = await listToolsForToolkit(lower);
        }
        return runtimeText(JSON.stringify(result, null, 2));
      },
    ),
  ];
}

export function createSelfMcp() {
  return createClaudeMcpServer(NAMESPACE, createSelfTools());
}
