import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { writePrivateFileAtomic } from "../secrets/store.js";
import type { TokenEndpointAuthMethod } from "./oauth.js";

/**
 * The list of remote MCP servers Boop authenticates for the owner, kept in
 * ~/.config/boop/mcp-servers.json (chmod 600). It holds names, URLs, OAuth
 * endpoints, client ids and status, never a token: access tokens, refresh
 * tokens, client secrets and static bearer tokens live in the secret store
 * (Keychain) under the names from secretNames().
 */

export type McpAuthKind = "oauth" | "bearer" | "none";
export type McpAuthState = "connected" | "needs-auth" | "needs-reauth";

export interface McpOAuthClientInfo {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientId: string;
  /** A client secret for this client is in the secret store. */
  clientSecretStored: boolean;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  /** Redirect URIs this client was registered with. */
  redirectUris: string[];
  /** True when Boop registered the client itself (RFC 7591). */
  dynamic: boolean;
  resource: string;
  scope?: string;
}

export interface McpServerEntry {
  name: string;
  url: string;
  auth: McpAuthKind;
  /** Bearer servers: the secret holding the token (default MCP_<NAME>_TOKEN). */
  secretName?: string;
  oauth?: McpOAuthClientInfo;
  /** Access token expiry (epoch ms), when the server gave one. */
  expiresAt?: number;
  state: McpAuthState;
  /** Why it needs (re-)auth. Never contains a token. */
  lastError?: string;
  updatedAt: number;
  /** The owner conversation that last started auth, for "needs re-auth" texts. */
  conversationId?: string;
}

interface ConfigFile {
  version: 1;
  servers: Record<string, McpServerEntry>;
}

export const MAX_SERVER_NAME_LENGTH = 48;

/**
 * "bannerstudio", "Banner Studio", "plugin:stripe:stripe" → bannerstudio,
 * banner-studio, stripe. Lowercase letters, digits, - and _. Null if nothing's left.
 */
export function normalizeServerName(raw: string): string | null {
  let name = String(raw ?? "").trim();
  const plugin = name.match(/^plugin:[^:]+:(.+)$/i);
  if (plugin) name = plugin[1];
  name = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, MAX_SERVER_NAME_LENGTH);
  return name && /^[a-z0-9]/.test(name) ? name : null;
}

/** Secret-store names for a server's credentials (UPPER_SNAKE_CASE). */
export function secretNames(name: string): { accessToken: string; refreshToken: string; clientSecret: string; clientId: string; bearer: string } {
  const prefix = `MCP_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/_+$/, "")}`;
  return {
    accessToken: `${prefix}_ACCESS_TOKEN`,
    refreshToken: `${prefix}_REFRESH_TOKEN`,
    clientSecret: `${prefix}_CLIENT_SECRET`,
    clientId: `${prefix}_CLIENT_ID`,
    bearer: `${prefix}_TOKEN`,
  };
}

export class McpServerConfigStore {
  readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(file: string = path.join(homedir(), ".config", "boop", "mcp-servers.json")) {
    this.file = file;
  }

  private async read(): Promise<ConfigFile> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as ConfigFile;
      if (parsed && typeof parsed.servers === "object" && parsed.servers) return { version: 1, servers: parsed.servers };
    } catch {
      // Missing or unreadable: start empty.
    }
    return { version: 1, servers: {} };
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<McpServerEntry[]> {
    return Object.values((await this.read()).servers).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<McpServerEntry | null> {
    return (await this.read()).servers[name] ?? null;
  }

  async put(entry: McpServerEntry): Promise<McpServerEntry> {
    return this.exclusive(async () => {
      const cfg = await this.read();
      cfg.servers[entry.name] = entry;
      await writePrivateFileAtomic(this.file, `${JSON.stringify(cfg, null, 2)}\n`);
      return entry;
    });
  }

  /** Applies a patch to an existing entry; null when there's no such server. */
  async update(name: string, patch: (entry: McpServerEntry) => McpServerEntry): Promise<McpServerEntry | null> {
    return this.exclusive(async () => {
      const cfg = await this.read();
      const current = cfg.servers[name];
      if (!current) return null;
      const next = patch({ ...current });
      cfg.servers[name] = next;
      await writePrivateFileAtomic(this.file, `${JSON.stringify(cfg, null, 2)}\n`);
      return next;
    });
  }
}

// --- what Claude sessions report ------------------------------------------------

export interface ObservedMcpServer {
  name: string;
  status: string;
  source?: string;
  seenAt: number;
}

const observed = new Map<string, ObservedMcpServer>();

/**
 * Called with the MCP server list from each Claude session's init message,
 * so list_mcp_servers can say which configured servers (plugins, claude.ai
 * connectors, ~/.claude.json) sit in "needs-auth". In memory only.
 */
export function noteMcpServerStatuses(
  servers: { name: string; status: string; source?: string }[] | undefined,
  now: number = Date.now(),
): void {
  if (!Array.isArray(servers)) return;
  for (const s of servers) {
    if (!s || typeof s.name !== "string" || typeof s.status !== "string") continue;
    // Boop's own in-process tool servers are never interesting here.
    if (s.source === "sdk") continue;
    observed.set(s.name, { name: s.name.slice(0, 120), status: s.status.slice(0, 40), ...(s.source ? { source: s.source.slice(0, 40) } : {}), seenAt: now });
  }
}

export function observedMcpServers(): ObservedMcpServer[] {
  return [...observed.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Test hook. */
export function clearObservedMcpServers(): void {
  observed.clear();
}
