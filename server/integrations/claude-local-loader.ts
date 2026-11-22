import { activeClaudeConfigDir, envWithClaudeConfigDir } from "../claude-profiles.js";
import {
  cachedLocalMcpStatuses,
  claudeToolPrefix,
  createSdkStatusProbe,
  isWriteTool,
  LOCAL_MCP_DESCRIPTION_PREFIX,
  localMcpEnabled,
  localMcpStatuses,
  mergeLocalClaudeMcp,
  readLocalClaudeMcpConfigs,
  setLocalMcpStatusProbe,
  type LocalClaudeMcpServer,
  type LocalMcpConfigEntry,
  type LocalMcpKind,
  type LocalMcpServerStatus,
  type LocalMcpStatus,
} from "../claude-mcp/local.js";
import { normalizeServerName, observedMcpServers } from "../mcp-auth/config.js";
import { getIntegration, registerIntegration } from "./registry.js";

/**
 * Registers the MCP servers of the owner's Claude on this Mac as spawn_agent
 * integrations, by server name:
 * - ~/.claude.json servers (user scope, and local scope for Boop's project):
 *   sub-agents don't load these on their own, so Boop passes the server's
 *   config to the sub-agent's Claude process. Same command/URL as the owner's
 *   Claude, run on the Mac; nothing reaches chat or logs.
 * - claude.ai connectors and the project's .mcp.json: the sub-agent's Claude
 *   process loads them itself; selecting one allows its tools. Connectors that
 *   weren't selected are denied, so a sub-agent only touches what it was given.
 * All of them are owner-only. Codex sub-agents don't get them (no bridge).
 */

interface LocalIntegrationInfo {
  /** Name in the Claude config, e.g. "claude.ai Slack". */
  serverName: string;
  kind: LocalMcpKind;
  /** Tool-name prefix the sub-agent sees, e.g. mcp__postmark-staging__. */
  toolPrefix: string;
}

const localIntegrations = new Map<string, LocalIntegrationInfo>();

export const LOCAL_INTEGRATION_COLLISION_SUFFIX = "-claude";

function isLocalModule(name: string): boolean {
  const mod = getIntegration(name);
  return Boolean(mod && mod.description.startsWith(LOCAL_MCP_DESCRIPTION_PREFIX));
}

/**
 * The integration name for a server, or undefined when it isn't offered:
 * Boop's own project servers (boop-*), or a server Boop already authenticates
 * itself (start_mcp_auth), which wins.
 */
export function localIntegrationName(server: { name: string; kind: LocalMcpKind; scope?: string }): string | undefined {
  if (server.kind !== "config" && server.kind !== "connector") return undefined;
  if (server.scope === "project" && /^boop[-_]/i.test(server.name)) return undefined;
  const base =
    server.kind === "config" && /^[A-Za-z0-9_-]{1,64}$/.test(server.name) ? server.name : normalizeServerName(server.name);
  if (!base) return undefined;
  for (const candidate of [base, `${base}${LOCAL_INTEGRATION_COLLISION_SUFFIX}`]) {
    const existing = getIntegration(candidate);
    if (!existing) return candidate;
    if (isLocalModule(candidate) && localIntegrations.get(candidate)?.serverName === server.name) return candidate;
    // Boop authenticates this server itself: use that one, not Claude's copy.
    if (existing.description.startsWith("Remote MCP server") && normalizeServerName(server.name) === normalizeServerName(candidate)) {
      return undefined;
    }
  }
  return undefined;
}

function currentStatus(serverName: string): LocalMcpServerStatus | undefined {
  const cached = cachedLocalMcpStatuses();
  if (cached) return cached.find((s) => s.name === serverName);
  const seen = observedMcpServers().find((o) => o.name === serverName);
  return seen ? { name: seen.name, status: seen.status as LocalMcpStatus } : undefined;
}

/** Usable unless Claude reports it needs sign-in or is turned off. Failed servers stay selectable and report why. */
function usable(serverName: string): boolean {
  const status = currentStatus(serverName)?.status;
  return status !== "needs-auth" && status !== "disabled";
}

export function registerLocalConfigServer(entry: LocalMcpConfigEntry): string | undefined {
  const kind: LocalMcpKind = "config";
  const integration = localIntegrationName({ name: entry.name, kind, scope: entry.scope });
  if (!integration) return undefined;
  // .mcp.json servers are already loaded by the sub-agent's Claude (project settings).
  const providedByClaude = entry.scope === "project";
  const toolPrefix = claudeToolPrefix(providedByClaude ? entry.name : integration);
  localIntegrations.set(integration, { serverName: entry.name, kind, toolPrefix });
  const config = entry.config;
  registerIntegration({
    name: integration,
    description: `${LOCAL_MCP_DESCRIPTION_PREFIX} (${entry.from}, ${entry.transport}): ${entry.name}`,
    ownerOnly: true,
    isEnabled: async () => Boolean(config) && !entry.problem && usable(entry.name),
    ...(providedByClaude
      ? { claudeToolPatterns: [`${toolPrefix}*`] }
      : {
          createServer: async () => {
            if (!config) throw new Error(`${entry.name}: ${entry.problem ?? "no usable config"}`);
            return config;
          },
        }),
  });
  return integration;
}

export function registerLocalConnector(status: Pick<LocalMcpServerStatus, "name" | "source">): string | undefined {
  const kind: LocalMcpKind = "connector";
  const integration = localIntegrationName({ name: status.name, kind });
  if (!integration) return undefined;
  const toolPrefix = claudeToolPrefix(status.name);
  localIntegrations.set(integration, { serverName: status.name, kind, toolPrefix });
  registerIntegration({
    name: integration,
    description: `${LOCAL_MCP_DESCRIPTION_PREFIX} (claude.ai connector): ${status.name}`,
    ownerOnly: true,
    isEnabled: async () => usable(status.name),
    claudeToolPatterns: [`${toolPrefix}*`],
  });
  return integration;
}

function registerConnectorsFrom(statuses: LocalMcpServerStatus[]): void {
  for (const s of statuses) {
    if (s.source === "claudeai" || /^claude\.ai /i.test(s.name)) registerLocalConnector(s);
  }
}

export interface LocalLoaderDeps {
  readConfigs?: () => Promise<LocalMcpConfigEntry[]>;
  /** Start a background status check through Claude (default true outside tests). */
  probe?: boolean;
  env?: NodeJS.ProcessEnv;
}

async function defaultReadConfigs(): Promise<LocalMcpConfigEntry[]> {
  const configDir = await activeClaudeConfigDir().catch(() => undefined);
  return readLocalClaudeMcpConfigs({ configDir });
}

export async function registerLocalClaudeMcpIntegrations(deps: LocalLoaderDeps = {}): Promise<void> {
  if (!localMcpEnabled(deps.env)) return;
  // The registry was cleared (refreshIntegrations): start the name map over too.
  for (const name of [...localIntegrations.keys()]) if (!getIntegration(name)) localIntegrations.delete(name);
  let configs: LocalMcpConfigEntry[] = [];
  try {
    configs = await (deps.readConfigs ?? defaultReadConfigs)();
  } catch (err) {
    console.warn("[local-mcp] couldn't read the Claude MCP config", err instanceof Error ? err.message : err);
  }
  const registered = configs.map(registerLocalConfigServer).filter(Boolean);
  registerConnectorsFrom(cachedLocalMcpStatuses() ?? observedMcpServers().map((o) => ({ name: o.name, status: o.status as LocalMcpStatus, source: o.source })));
  if (registered.length) console.log(`[local-mcp] ${registered.length} MCP server(s) from the Mac's Claude config: ${registered.join(", ")}`);

  const probe = deps.probe ?? !process.env.VITEST;
  if (probe) {
    const configDir = await activeClaudeConfigDir().catch(() => undefined);
    setLocalMcpStatusProbe(createSdkStatusProbe({ env: envWithClaudeConfigDir(configDir) }));
    // In the background: it starts Claude with the owner's MCP servers, which takes a few seconds.
    void localMcpStatuses()
      .then((statuses) => registerConnectorsFrom(statuses))
      .catch(() => undefined);
  }
}

/** Servers, statuses and integration names, for list_mcp_servers / list_integrations. */
export async function localClaudeMcpServers(opts: { refresh?: boolean; readConfigs?: () => Promise<LocalMcpConfigEntry[]> } = {}): Promise<LocalClaudeMcpServer[]> {
  if (!localMcpEnabled()) return [];
  const [configs, statuses] = await Promise.all([
    (opts.readConfigs ?? defaultReadConfigs)().catch(() => [] as LocalMcpConfigEntry[]),
    localMcpStatuses({ refresh: opts.refresh }),
  ]);
  // Connectors (and newly added servers) become selectable as soon as they're seen.
  registerConnectorsFrom(statuses);
  const integrationOf = new Map<string, string>();
  for (const [integration, info] of localIntegrations) {
    if (getIntegration(integration)) integrationOf.set(info.serverName, integration);
  }
  for (const c of configs) if (!integrationOf.has(c.name)) {
    const name = registerLocalConfigServer(c);
    if (name) integrationOf.set(c.name, name);
  }
  return mergeLocalClaudeMcp(configs, statuses, (s) => integrationOf.get(s.name));
}

export function isLocalClaudeIntegration(name: string): boolean {
  return localIntegrations.has(name) && isLocalModule(name);
}

/** For the dispatcher's integration list: "postmark-staging, ray-app (failed: ECONNREFUSED…)". */
export function describeLocalIntegrationsForPrompt(names: string[]): string {
  return names
    .filter(isLocalClaudeIntegration)
    .map((name) => {
      const info = localIntegrations.get(name)!;
      const status = currentStatus(info.serverName);
      return status?.status === "failed" ? `${name} (failed: ${status.error ?? "couldn't connect"})` : name;
    })
    .join(", ");
}

/**
 * Deny rules for claude.ai connectors the sub-agent wasn't given: its Claude
 * process loads every connector, and it should only use the ones selected.
 */
export function unselectedConnectorDenyRules(selected: string[]): string[] {
  const chosen = new Set(selected.map((n) => localIntegrations.get(n)?.serverName).filter(Boolean));
  const connectorNames = new Set<string>();
  for (const info of localIntegrations.values()) if (info.kind === "connector") connectorNames.add(info.serverName);
  for (const s of cachedLocalMcpStatuses() ?? []) if (s.source === "claudeai") connectorNames.add(s.name);
  for (const o of observedMcpServers()) if (o.source === "claudeai") connectorNames.add(o.name);
  return [...connectorNames]
    .filter((n) => !chosen.has(n))
    .sort()
    .map((n) => claudeToolPrefix(n).replace(/__$/, ""));
}

export const LOCAL_CLAUDE_MCP_EXECUTION_PROMPT = `

MCP servers from the owner's Claude on this Mac:
The servers listed below are loaded for this run through Claude on the Mac. Use their tools; don't say you lack access to a service listed here.
- If a listed server's tools are missing from your tool list, or a call fails (ECONNREFUSED, timeout, "needs auth"), say plainly "<server> is configured on the Mac but <what happened>" — never that the access doesn't exist. For "needs auth", Boop can send the owner a sign-in link.
- Reading and looking things up is fine. Anything that sends, creates, updates or deletes on an external service (e.g. Postmark sendEmail / sendEmailWithTemplate, Slack messages, Notion pages, Customer.io writes) goes through save_draft first, with payload JSON {"integration": "<integration name below>", "tool": "<full tool name>", "arguments": {…}}. Only when your task says it is executing an approved draft, call exactly that tool with those arguments, once.
- Never print or repeat tokens, API keys, passwords, or a server's command, environment or headers.
Loaded servers:`;

/** The execution-agent prompt section for the local servers a spawn was given ("" when none). */
export function localClaudeMcpExecutionPrompt(selected: string[]): string {
  const lines: string[] = [];
  for (const name of selected) {
    if (!isLocalClaudeIntegration(name)) continue;
    const info = localIntegrations.get(name)!;
    const status = currentStatus(info.serverName);
    const writes = (status?.tools ?? []).filter(isWriteTool).map((t) => t.name);
    const shown = writes.slice(0, 12).join(", ") + (writes.length > 12 ? ", …" : "");
    const parts = [
      `- integration "${name}" (${info.kind === "connector" ? `claude.ai connector "${info.serverName}"` : `"${info.serverName}" from the Mac's Claude config`}): tools ${info.toolPrefix}*`,
      writes.length ? `; write/send tools (draft first): ${shown}` : "",
      status?.status === "failed" ? `; last status: failed (${status.error ?? "couldn't connect"})` : "",
    ];
    lines.push(parts.join(""));
  }
  return lines.length ? `${LOCAL_CLAUDE_MCP_EXECUTION_PROMPT}\n${lines.join("\n")}` : "";
}

export const LOCAL_CLAUDE_MCP_DISPATCHER_PROMPT = `
MCP servers from the owner's Claude on this Mac (owner only):
- The integrations under "Mac Claude MCP servers" are the MCP servers the owner's Claude has: ~/.claude.json servers (e.g. postmark-staging), the project's .mcp.json and claude.ai connectors (named claude-ai-<name>, e.g. claude-ai-slack). Pass them to spawn_agent by name like any other integration; the sub-agent calls their tools through Claude on the Mac. Example: "send a sample email through postmark-staging" → spawn_agent(integrations: ["postmark-staging"]) to prepare it as a draft.
- Sends and writes still go through drafts: the sub-agent saves a draft whose payload names the integration; after the user confirms, call send_draft with that same integration.
- list_mcp_servers shows each with its status (connected / needs auth / failed). Needs auth → start_mcp_auth. Failed (e.g. ECONNREFUSED, the local app isn't running) → tell the user plainly it's configured but failing and why; don't call it missing.
- Never say Boop has no access to a service listed here, and never paste a server's config, tokens or keys.`;
