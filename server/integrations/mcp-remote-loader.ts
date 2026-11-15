import type { McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerEntry } from "../mcp-auth/config.js";
import { MCP_PROXY_KEY, MCP_PROXY_KEY_HEADER, mcpProxyUrl } from "../mcp-auth/routes.js";
import { mcpAuthService, type McpAuthService } from "../mcp-auth/service.js";
import { secretsSupported } from "../secrets/store.js";
import { getIntegration, registerIntegration } from "./registry.js";

/**
 * Remote MCP servers the owner authenticated through Boop (start_mcp_auth),
 * as integrations sub-agents can be given by name. A Claude sub-agent
 * connects to Boop's loopback proxy (/mcp-proxy/<name>), which adds the
 * Authorization header itself, so the token never enters the Claude process,
 * its arguments or its environment. Enabled only while credentials are
 * stored and not flagged "needs re-auth".
 *
 * Codex sub-agents don't get these yet (no runtime-tool bridge).
 */

export function mcpRemoteIntegrationName(entry: Pick<McpServerEntry, "name">): string {
  const existing = getIntegration(entry.name);
  // Don't shadow another integration with the same name (e.g. a Composio toolkit).
  return existing && !existing.description.startsWith("Remote MCP server") ? `${entry.name}-mcp` : entry.name;
}

export function registerMcpRemoteServer(entry: McpServerEntry, service: () => McpAuthService = mcpAuthService): string {
  const integration = mcpRemoteIntegrationName(entry);
  let host = entry.url;
  try {
    host = new URL(entry.url).host;
  } catch {
    // Keep the raw value.
  }
  registerIntegration({
    name: integration,
    description: `Remote MCP server ${entry.name} (${host}), authenticated by Boop`,
    isEnabled: () => service().isUsable(entry.name),
    createServer: async () => {
      // Refresh ahead of the session when the token is about to expire.
      await service().accessToken(entry.name).catch(() => undefined);
      const config: McpHttpServerConfig = {
        type: "http",
        url: mcpProxyUrl(entry.name),
        headers: { [MCP_PROXY_KEY_HEADER]: MCP_PROXY_KEY },
      };
      return config;
    },
  });
  return integration;
}

export async function registerMcpRemoteIntegrations(service: () => McpAuthService = mcpAuthService): Promise<void> {
  if (!secretsSupported()) return;
  let entries: McpServerEntry[] = [];
  try {
    entries = await service().config.list();
  } catch (err) {
    console.warn("[mcp-auth] couldn't read the MCP server list", err instanceof Error ? err.message : err);
    return;
  }
  for (const entry of entries) registerMcpRemoteServer(entry, service);
  if (entries.length) console.log(`[mcp-auth] registered ${entries.length} remote MCP server(s): ${entries.map((e) => e.name).join(", ")}`);
}
