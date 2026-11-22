import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeTool } from "../runtimes/types.js";

export interface IntegrationModule {
  name: string;
  description: string;
  requiredEnv?: string[];
  isEnabled?: () => Promise<boolean>;
  /**
   * An in-process SDK server, a remote (http) one such as an authenticated MCP
   * server behind Boop's proxy, or a server from the Mac's Claude config.
   * Absent when the Claude process provides the tools itself (claudeToolPatterns).
   */
  createServer?: (ctx: IntegrationContext) => Promise<McpServerConfig>;
  createTools?: (ctx: IntegrationContext) => Promise<RuntimeTool[]>;
  /**
   * Claude runtime: tool-name patterns (e.g. "mcp__claude_ai_Slack__*") the
   * sub-agent's Claude process already loads by itself, such as claude.ai
   * connectors. They're allowed when the integration is selected.
   */
  claudeToolPatterns?: string[];
  /** Extra instructions for the sub-agent when this integration is loaded. */
  executionNote?: () => string;
  /** Only for the owner's conversations (local machine access). */
  ownerOnly?: boolean;
}

export interface IntegrationContext {
  conversationId?: string;
}

const registry = new Map<string, IntegrationModule>();

export function registerIntegration(mod: IntegrationModule): void {
  registry.set(mod.name, mod);
}

export function listIntegrations(): IntegrationModule[] {
  return [...registry.values()];
}

export async function listEnabledIntegrations(): Promise<IntegrationModule[]> {
  const out: IntegrationModule[] = [];
  for (const mod of registry.values()) {
    try {
      if (!mod.isEnabled || (await mod.isEnabled())) out.push(mod);
    } catch (err) {
      console.warn(`[integrations] failed to check ${mod.name} enabled state`, err);
    }
  }
  return out;
}

export function getIntegration(name: string): IntegrationModule | undefined {
  return registry.get(name);
}

export async function loadIntegrations(): Promise<void> {
  const { registerComposioToolkits } = await import("./composio-loader.js");
  await registerComposioToolkits();
  const { registerBrowserIntegration } = await import("./browser-loader.js");
  registerBrowserIntegration();
  const { registerImpersonationIntegration } = await import("./impersonation-loader.js");
  registerImpersonationIntegration();
  const { registerWebTestIntegration } = await import("./webtest-loader.js");
  registerWebTestIntegration();
  const { registerAppleIntegration } = await import("./apple-loader.js");
  registerAppleIntegration();
  const { registerComposioAccountIntegration } = await import("./composio-account-loader.js");
  await registerComposioAccountIntegration();
  // Last, so a remote MCP server never shadows a toolkit of the same name.
  const { registerMcpRemoteIntegrations } = await import("./mcp-remote-loader.js");
  await registerMcpRemoteIntegrations();
  // After Boop's own remote MCP servers: one Boop authenticates wins over the
  // same server in the Mac's Claude config.
  const { registerLocalClaudeMcpIntegrations } = await import("./claude-local-loader.js");
  await registerLocalClaudeMcpIntegrations();
  const loaded = [...registry.keys()];
  const enabled = (await listEnabledIntegrations()).map((i) => i.name);
  console.log(
    `[integrations] loaded: ${loaded.join(", ") || "(none — connect a toolkit from the Debug UI's Connections tab)"}; enabled: ${enabled.join(", ") || "(none)"}`,
  );
}

export async function refreshIntegrations(): Promise<void> {
  registry.clear();
  await loadIntegrations();
}

export function makeContext(conversationId?: string): IntegrationContext {
  return { conversationId };
}

export async function buildMcpServersForIntegrations(
  names: string[],
  conversationId?: string,
): Promise<Record<string, McpServerConfig>> {
  const ctx = makeContext(conversationId);
  const out: Record<string, McpServerConfig> = {};
  for (const name of names) {
    const mod = registry.get(name);
    if (!mod) {
      console.warn(`[integrations] unknown integration: ${name}`);
      continue;
    }
    if (!mod.createServer) continue; // provided by the Claude process itself (claudeToolPatterns)
    if (mod.isEnabled && !(await mod.isEnabled())) {
      console.warn(`[integrations] skipped disabled integration: ${name}`);
      continue;
    }
    try {
      out[name] = await mod.createServer(ctx);
    } catch (err) {
      console.error(`[integrations] failed to build ${name}`, err);
    }
  }
  return out;
}

export async function buildRuntimeToolsForIntegrations(
  names: string[],
  conversationId?: string,
): Promise<RuntimeTool[]> {
  const ctx = makeContext(conversationId);
  const out: RuntimeTool[] = [];
  for (const name of names) {
    const mod = registry.get(name);
    if (!mod) {
      console.warn(`[integrations] unknown integration: ${name}`);
      continue;
    }
    if (!mod.createTools) {
      console.warn(`[integrations] ${name} does not expose runtime tools`);
      continue;
    }
    if (mod.isEnabled && !(await mod.isEnabled())) {
      console.warn(`[integrations] skipped disabled integration: ${name}`);
      continue;
    }
    try {
      out.push(...(await mod.createTools(ctx)));
    } catch (err) {
      console.error(`[integrations] failed to build runtime tools for ${name}`, err);
    }
  }
  return out;
}

/** Claude runtime: allowedTools patterns for selected integrations the Claude process provides itself. */
export function claudeToolPatternsForIntegrations(names: string[]): string[] {
  return names.flatMap((name) => registry.get(name)?.claudeToolPatterns ?? []);
}

/** Drops owner-only integrations (local machine access) unless the conversation is the owner's. */
export function filterIntegrationsForOwner(names: string[], owner: boolean): string[] {
  if (owner) return names;
  return names.filter((name) => {
    const mod = registry.get(name);
    if (mod?.ownerOnly) {
      console.warn(`[integrations] ${name} is owner-only; not given to this conversation's agent`);
      return false;
    }
    return true;
  });
}
