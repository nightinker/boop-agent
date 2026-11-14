import { z } from "zod";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { isOwnerConversation } from "../self-build/plan.js";
import { remoteEntryRuntime } from "../secrets/remote-config.js";
import { secretRequests, type SecretRequestRegistry } from "../secrets/requests.js";
import { secretStore, SECRETS_UNSUPPORTED_MESSAGE, validateSecretName, type SecretStore } from "../secrets/store.js";
import { createSecretRequestLink } from "../secrets/tools.js";
import { normalizeServerName, observedMcpServers, secretNames, type McpAuthKind, type McpServerEntry } from "./config.js";
import { findConfiguredMcpServerUrl } from "./discover.js";
import { assertSecureUrl, discoverProtectedResource, OAuthError, type FetchLike } from "./oauth.js";
import { mcpAuthService, type McpAuthService } from "./service.js";

export const MCP_AUTH_NAMESPACE = "boop-mcp-auth";

export const MCP_AUTH_DISPATCHER_ALLOWED_TOOLS = [
  `mcp__${MCP_AUTH_NAMESPACE}__list_mcp_servers`,
  `mcp__${MCP_AUTH_NAMESPACE}__start_mcp_auth`,
];

export const MCP_AUTH_DISPATCHER_PROMPT = `
Remote MCP servers that need sign-in (OAuth or a static token), e.g. "authenticate bannerstudio":
- list_mcp_servers shows each server Boop manages and its status (connected / needs auth / needs re-auth), plus servers Claude sessions reported as "needs-auth".
- start_mcp_auth(name) returns a one-time sign-in link: send it to the user. They open it on the Mac (or remotely behind the secrets passcode or dashboard login) and sign in with the service; tokens go straight into the Mac's Keychain and refresh automatically. Pass url when Boop doesn't know the server yet (ask the user for it if needed). For servers that use a fixed API token instead of OAuth, pass auth: "bearer" (optionally secretName); that returns a secret-entry link instead.
- Once connected, the server appears in spawn_agent's integrations under its name. If a sub-agent reports a server "needs re-authentication", call start_mcp_auth again for a fresh link.
- Never ask the user to paste a token in chat.`;

export const MCP_AUTH_EXECUTION_PROMPT = `
- If an MCP server's tool fails with "needs re-authentication" or "isn't authenticated", stop using it and say which server, so Boop can send the owner a sign-in link. Never try to obtain or handle its tokens yourself.`;

const NOT_OWNER_MESSAGE = "Only Boop's owner can see or authenticate MCP servers.";

interface ToolDeps {
  service?: () => McpAuthService;
  store?: () => SecretStore;
  requests?: SecretRequestRegistry;
  env?: NodeJS.ProcessEnv;
  ownerNumbers?: () => string | undefined;
  findUrl?: typeof findConfiguredMcpServerUrl;
  fetch?: FetchLike;
  /** Makes a newly added server available to spawn_agent right away. */
  onServerAdded?: (entry: McpServerEntry) => void;
}

function isOwner(conversationId: string, deps: ToolDeps): boolean {
  return isOwnerConversation(conversationId, (deps.ownerNumbers ?? (() => process.env.BOOP_OWNER_NUMBERS))());
}

export async function describeMcpServers(service: McpAuthService): Promise<string> {
  const entries = await service.config.list();
  const lines: string[] = [];
  for (const entry of entries) {
    let host = entry.url;
    try {
      host = new URL(entry.url).host;
    } catch {
      // Keep the raw value.
    }
    lines.push(`- ${entry.name} (${host}, ${entry.auth === "oauth" ? "OAuth" : entry.auth === "bearer" ? "static token" : "no auth"}): ${await service.describe(entry)}`);
  }
  const managed = new Set(entries.map((e) => e.name));
  const others = observedMcpServers().filter((o) => {
    const n = normalizeServerName(o.name);
    return !(n && managed.has(n)) && o.source !== "dynamic";
  });
  const needsAuth = others.filter((o) => o.status === "needs-auth");
  const otherLines = needsAuth.map(
    (o) => `- ${o.name}${o.source ? ` (${o.source})` : ""}: needs authentication in Claude sessions; not set up in Boop yet (start_mcp_auth "${normalizeServerName(o.name) ?? o.name}")`,
  );
  if (lines.length === 0 && otherLines.length === 0) {
    return "No MCP servers are set up for sign-in yet, and no Claude session has reported one needing authentication. Use start_mcp_auth(name, url) to add one.";
  }
  const out: string[] = [];
  if (lines.length) out.push("MCP servers Boop authenticates:", ...lines);
  if (otherLines.length) out.push("Reported as needing authentication by Claude sessions:", ...otherLines);
  return out.join("\n");
}

export function createMcpAuthDispatcherTools(conversationId: string, deps: ToolDeps = {}): RuntimeTool[] {
  const service = deps.service ?? mcpAuthService;
  const store = deps.store ?? secretStore;
  const requests = deps.requests ?? secretRequests;
  const env = deps.env ?? process.env;
  const findUrl = deps.findUrl ?? findConfiguredMcpServerUrl;

  return [
    defineRuntimeTool(
      MCP_AUTH_NAMESPACE,
      "list_mcp_servers",
      "List remote MCP servers that need authentication and their status: connected, needs auth, needs re-auth (expired/revoked), plus servers Claude sessions reported as needing auth. Never shows tokens.",
      {},
      async () => {
        if (!isOwner(conversationId, deps)) return runtimeText(NOT_OWNER_MESSAGE, false);
        const svc = service();
        if (!svc.supported) return runtimeText(SECRETS_UNSUPPORTED_MESSAGE, false);
        return runtimeText(await describeMcpServers(svc));
      },
    ),
    defineRuntimeTool(
      MCP_AUTH_NAMESPACE,
      "start_mcp_auth",
      "Start authenticating a remote MCP server (e.g. bannerstudio, stripe) for the owner. Returns a one-time link the owner opens to sign in (OAuth: discovery, client registration, PKCE; Boop handles the callback and keeps the tokens in the Keychain, refreshing them automatically). For servers that take a static API token, pass auth: \"bearer\" to get a secret-entry link instead. Also the way to re-authenticate. Send the returned link to the user.",
      {
        name: z.string().min(1).max(80).describe("Server name, e.g. bannerstudio. Becomes the integration name sub-agents use."),
        url: z
          .string()
          .max(500)
          .optional()
          .describe("The MCP endpoint URL (https), e.g. https://api.example.com/mcp. Optional when Boop already knows the server or it's in the owner's Claude config."),
        auth: z.enum(["oauth", "bearer"]).optional().describe('Default "oauth". "bearer" = a fixed token sent as Authorization: Bearer, entered via a secret link.'),
        secretName: z
          .string()
          .optional()
          .describe("Bearer only: the secret holding the token, UPPER_SNAKE_CASE (default MCP_<NAME>_TOKEN). Reuse an existing secret name if the token is already stored."),
      },
      async (args) => {
        if (!isOwner(conversationId, deps)) return runtimeText(NOT_OWNER_MESSAGE, false);
        const svc = service();
        if (!svc.supported) return runtimeText(SECRETS_UNSUPPORTED_MESSAGE, false);
        const name = normalizeServerName(args.name);
        if (!name) return runtimeText("That server name has no letters or digits in it.", false);

        const existing = await svc.config.get(name);
        let url = args.url?.trim() || existing?.url;
        let foundIn: string | null = null;
        if (!url) {
          const found = await findUrl(args.name);
          if (found.url !== null) {
            url = found.url;
            foundIn = found.from;
          } else if (found.candidates.length > 1) {
            return runtimeText(`More than one URL is configured for ${name} (${found.candidates.join(", ")}). Ask the user which one and call again with url.`, false);
          } else {
            return runtimeText(`Boop doesn't know ${name}'s MCP URL. Ask the user for it (e.g. https://…/mcp) and call again with url.`, false);
          }
        }
        try {
          assertSecureUrl(url, "MCP server URL");
        } catch (err) {
          return runtimeText(err instanceof OAuthError ? err.message : "That URL isn't valid.", false);
        }

        const kind: McpAuthKind = args.auth ?? (existing?.auth === "bearer" && !args.url ? "bearer" : "oauth");
        const now = Date.now();
        if (kind === "bearer") {
          const secretName = args.secretName?.trim() || existing?.secretName || secretNames(name).bearer;
          const nameError = validateSecretName(secretName);
          if (nameError) return runtimeText(nameError, false);
          const entry: McpServerEntry = {
            name,
            url,
            auth: "bearer",
            secretName,
            state: "needs-auth",
            updatedAt: now,
            conversationId,
          };
          await svc.config.put(entry);
          deps.onServerAdded?.(entry);
          const link = await createSecretRequestLink(
            { name: secretName, description: `API token for the ${name} MCP server (${new URL(url).host}); sent as Authorization: Bearer` },
            conversationId,
            { store, requests, platform: process.platform, env, runtime: remoteEntryRuntime },
          );
          return runtimeText(
            `${name} uses a static token, stored as ${secretName}.\n${link.text}\nOnce it's saved, ${name} is available to sub-agents as the "${name}" integration.`,
            link.success !== false,
          );
        }

        // Check now that the server is reachable and wants OAuth, so the link isn't a dead end.
        const discovery = await discoverProtectedResource(url, deps.fetch).catch(() => null);
        if (discovery && !discovery.authRequired) {
          const entry: McpServerEntry = { name, url, auth: "none", state: "connected", updatedAt: now, conversationId };
          await svc.config.put(entry);
          deps.onServerAdded?.(entry);
          return runtimeText(`${name} answered without asking for sign-in, so there's nothing to authenticate. It's available to sub-agents as the "${name}" integration.`);
        }
        if (discovery && discovery.probeStatus === 0) {
          return runtimeText(`Couldn't reach ${url}. Check the URL with the user.`, false);
        }

        const entry: McpServerEntry = {
          ...(existing ?? { name, state: "needs-auth" as const, updatedAt: now }),
          name,
          url,
          auth: "oauth",
          // A changed URL means a different server: forget the old client.
          ...(existing && existing.url !== url ? { oauth: undefined, state: "needs-auth" as const } : {}),
          conversationId,
          updatedAt: now,
        };
        if (existing?.auth !== "oauth") delete entry.secretName;
        await svc.config.put(entry);
        deps.onServerAdded?.(entry);
        const link = await svc.createStartLink(name, conversationId);
        const advertises = discovery?.metadata ? "" : "\nNote: the server didn't publish OAuth metadata; if sign-in fails, it may need a static token instead (call again with auth: \"bearer\").";
        return runtimeText(
          [
            foundIn ? `Using ${url} (from ${foundIn}).` : null,
            ...link.lines,
            "Send the user the link. They sign in with the service on that page; tokens go straight into the Mac's Keychain, never chat. You'll get a message in this conversation when it's connected.",
            advertises || null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    ),
  ];
}
