import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PROXY_KEY, MCP_PROXY_KEY_HEADER, mcpProxyUrl } from "../mcp-auth/routes.js";
import { mcpAuthService, type McpAuthService } from "../mcp-auth/service.js";
import type { McpCallResult } from "./links.js";
import type { NovaCaller } from "./runner.js";

/**
 * Talks to the owner's Nova MCP server from inside Boop, through the same
 * loopback proxy sub-agents use (/mcp-proxy/<name>), so the OAuth/bearer
 * token stays in the proxy and the action's result (the impersonation link)
 * stays in this process instead of an agent transcript.
 */

export const NOVA_RUN_ACTION_TOOL = "nova_run_action";

async function connect(name: string): Promise<Client> {
  const client = new Client({ name: "boop-nova-impersonation", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpProxyUrl(name)), {
    requestInit: { headers: { [MCP_PROXY_KEY_HEADER]: MCP_PROXY_KEY } },
  });
  await client.connect(transport);
  return client;
}

function caller(server: string, client: Client): NovaCaller {
  return {
    server,
    call: async (tool, args) => (await client.callTool({ name: tool, arguments: args })) as McpCallResult,
    close: () => client.close(),
  };
}

/**
 * Connect to `server` if given, otherwise to the first usable Boop-authenticated
 * MCP server that exposes nova_run_action.
 */
export async function connectNova(
  server?: string,
  service: () => McpAuthService = mcpAuthService,
): Promise<NovaCaller> {
  if (server) {
    if (!(await service().isUsable(server))) {
      throw new Error(`MCP server "${server}" isn't connected in Boop. Ask the owner to connect it (start_mcp_auth).`);
    }
    const client = await connect(server);
    return caller(server, client);
  }
  const entries = await service().config.list();
  for (const entry of entries) {
    if (!(await service().isUsable(entry.name).catch(() => false))) continue;
    let client: Client | null = null;
    try {
      client = await connect(entry.name);
      const { tools } = await client.listTools();
      if (tools.some((t) => t.name === NOVA_RUN_ACTION_TOOL)) return caller(entry.name, client);
    } catch {
      // Try the next server.
    }
    await client?.close().catch(() => undefined);
  }
  throw new Error(
    "No connected MCP server in Boop exposes nova_run_action. Ask the owner to connect the certificates.dev Nova MCP server (start_mcp_auth), then retry.",
  );
}
