import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  McpHttpServerConfig,
  McpServerStatus,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { normalizeServerName, observedMcpServers } from "../mcp-auth/config.js";
import { redactSecrets, scanForSecrets } from "../secrets/redact.js";

/**
 * The MCP servers the owner's Claude on this Mac has: servers in
 * ~/.claude.json (user scope, and "local" scope for Boop's project), the
 * project's .mcp.json, and the claude.ai connectors the Mac's Claude is signed
 * in to. Sub-agents run Claude Code with only project settings, so they get
 * the connectors and .mcp.json but not the ~/.claude.json servers; Boop passes
 * those in explicitly for the integrations a spawn asks for.
 *
 * Configs (commands, env, headers) stay inside Boop and the Claude process.
 * Nothing here returns them in text: descriptions carry names, transports,
 * statuses and short, scrubbed errors only.
 */

export type LocalMcpScope = "user" | "local" | "project";
export type LocalMcpConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

export interface LocalMcpConfigEntry {
  name: string;
  scope: LocalMcpScope;
  /** Where it was found, for display ("~/.claude.json", ".mcp.json"). */
  from: string;
  transport: "stdio" | "http" | "sse";
  /** Absent when the entry can't be used (see problem). */
  config?: LocalMcpConfig;
  /** Why the entry can't be used, e.g. a missing environment variable. Never a value. */
  problem?: string;
}

export type LocalMcpStatus = "connected" | "needs-auth" | "failed" | "pending" | "disabled" | "unknown";

export interface LocalMcpToolInfo {
  name: string;
  readOnly?: boolean;
  destructive?: boolean;
}

export interface LocalMcpServerStatus {
  name: string;
  status: LocalMcpStatus;
  /** user | project | local | claudeai | plugin | dynamic | … */
  source?: string;
  /** Scrubbed, one line. */
  error?: string;
  tools?: LocalMcpToolInfo[];
}

const MAX_CLAUDE_JSON_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_LENGTH = 160;

export function localMcpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(String(env.BOOP_LOCAL_CLAUDE_MCP ?? "").trim());
}

// --- config files ---------------------------------------------------------------

async function readJsonFile(file: string, maxBytes = 1024 * 1024): Promise<unknown> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

class MissingEnvError extends Error {
  constructor(readonly variable: string) {
    super(variable);
  }
}

/** Claude Code's ${VAR} / ${VAR:-default} expansion. Throws MissingEnvError for an unset VAR without a default. */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (fallback !== undefined) return fallback;
    throw new MissingEnvError(name);
  });
}

function stringRecord(value: unknown, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = expandEnvVars(v, env);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/** One config entry → an SDK server config. Unknown shapes return null (skipped). */
export function toLocalMcpConfigEntry(
  name: string,
  raw: unknown,
  scope: LocalMcpScope,
  from: string,
  env: NodeJS.ProcessEnv,
): LocalMcpConfigEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  const type = cfg.type === undefined ? (typeof cfg.command === "string" ? "stdio" : typeof cfg.url === "string" ? "http" : null) : String(cfg.type);
  const transport = type === "stdio" ? "stdio" : type === "sse" ? "sse" : type === "http" || type === "streamable-http" ? "http" : null;
  if (!transport) return null;
  const base = { name, scope, from, transport } as const;
  try {
    if (transport === "stdio") {
      if (typeof cfg.command !== "string" || !cfg.command.trim()) return null;
      const config: McpStdioServerConfig = {
        type: "stdio",
        command: expandEnvVars(cfg.command, env),
        ...(Array.isArray(cfg.args) ? { args: cfg.args.filter((a): a is string => typeof a === "string").map((a) => expandEnvVars(a, env)) } : {}),
      };
      const childEnv = stringRecord(cfg.env, env);
      if (childEnv && Object.keys(childEnv).length) config.env = childEnv;
      return { ...base, config };
    }
    if (typeof cfg.url !== "string") return null;
    const url = expandEnvVars(cfg.url, env);
    if (!/^https?:\/\//i.test(url)) return { ...base, problem: "its URL isn't http(s)" };
    const headers = stringRecord(cfg.headers, env);
    const config: McpHttpServerConfig | McpSSEServerConfig =
      transport === "sse" ? { type: "sse", url } : { type: "http", url };
    if (headers && Object.keys(headers).length) config.headers = headers;
    return { ...base, config };
  } catch (err) {
    if (err instanceof MissingEnvError) return { ...base, problem: `needs the environment variable ${err.variable}, which isn't set for Boop` };
    return { ...base, problem: "its config couldn't be read" };
  }
}

function entriesFrom(servers: unknown, scope: LocalMcpScope, from: string, env: NodeJS.ProcessEnv): LocalMcpConfigEntry[] {
  if (!servers || typeof servers !== "object") return [];
  const out: LocalMcpConfigEntry[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const entry = toLocalMcpConfigEntry(name, raw, scope, from, env);
    if (entry) out.push(entry);
  }
  return out;
}

export interface ReadLocalMcpOptions {
  home?: string;
  /** CLAUDE_CONFIG_DIR of the active Claude account; its .claude.json replaces ~/.claude.json. */
  configDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Servers from the Claude config files, one per name, with Claude Code's
 * precedence (local over project over user).
 */
export async function readLocalClaudeMcpConfigs(opts: ReadLocalMcpOptions = {}): Promise<LocalMcpConfigEntry[]> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const claudeJsonPath = opts.configDir ? path.join(opts.configDir, ".claude.json") : path.join(home, ".claude.json");
  const claudeJson = (await readJsonFile(claudeJsonPath, MAX_CLAUDE_JSON_BYTES)) as
    | { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> }
    | null;
  const projectMcp = (await readJsonFile(path.join(cwd, ".mcp.json"))) as { mcpServers?: unknown } | null;

  const byName = new Map<string, LocalMcpConfigEntry>();
  // Lowest precedence first; later ones replace earlier ones.
  for (const e of entriesFrom(claudeJson?.mcpServers, "user", "~/.claude.json", env)) byName.set(e.name, e);
  for (const e of entriesFrom(projectMcp?.mcpServers, "project", ".mcp.json", env)) byName.set(e.name, e);
  const local = claudeJson?.projects?.[path.resolve(cwd)]?.mcpServers;
  for (const e of entriesFrom(local, "local", "~/.claude.json (this project)", env)) byName.set(e.name, e);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- status from the Mac's Claude runtime ------------------------------------------

/** Error text safe to show in chat: one line, short, no credentials or URL query strings. */
export function scrubMcpError(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let text = String(raw).split("\n")[0].trim();
  text = text.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, "$1");
  text = scanForSecrets(redactSecrets(text)).redacted;
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

function toStatus(value: string | undefined): LocalMcpStatus {
  switch (value) {
    case "connected":
    case "needs-auth":
    case "failed":
    case "pending":
    case "disabled":
      return value;
    default:
      return "unknown";
  }
}

export function statusFromSdk(s: McpServerStatus): LocalMcpServerStatus {
  return {
    name: s.name,
    status: toStatus(s.status),
    ...(s.source ?? s.scope ? { source: s.source ?? s.scope } : {}),
    ...(s.error ? { error: scrubMcpError(s.error) } : {}),
    ...(s.tools
      ? {
          tools: s.tools.map((t) => ({
            name: t.name,
            ...(t.annotations?.readOnly !== undefined ? { readOnly: t.annotations.readOnly } : {}),
            ...(t.annotations?.destructive !== undefined ? { destructive: t.annotations.destructive } : {}),
          })),
        }
      : {}),
  };
}

export type McpStatusProbe = () => Promise<LocalMcpServerStatus[]>;

/**
 * Asks a Claude Code process with the owner's full config for its MCP server
 * statuses (the same view `claude` gives in a terminal). No model call: the
 * prompt never yields, and the process is stopped once the statuses settle.
 */
export function createSdkStatusProbe(opts: { timeoutMs?: number; env?: Record<string, string> } = {}): McpStatusProbe {
  return async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const abort = new AbortController();
    const prompt = (async function* () {
      await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
    })();
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    const q = query({
      prompt: prompt as AsyncIterable<never>,
      options: { abortController: abort, permissionMode: "bypassPermissions", ...(opts.env ? { env: opts.env } : {}) },
    });
    try {
      let statuses = await q.mcpServerStatus();
      while (statuses.some((s) => s.status === "pending") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        statuses = await q.mcpServerStatus();
      }
      return statuses.filter((s) => s.source !== "sdk").map(statusFromSdk);
    } finally {
      abort.abort();
    }
  };
}

const STATUS_TTL_MS = 5 * 60_000;
let cached: { at: number; statuses: LocalMcpServerStatus[] } | null = null;
let inflight: Promise<LocalMcpServerStatus[]> | null = null;
let defaultProbe: McpStatusProbe | null = null;

/** Test hook / wiring: replaces the probe and drops the cache. */
export function setLocalMcpStatusProbe(probe: McpStatusProbe | null): void {
  defaultProbe = probe;
  cached = null;
  inflight = null;
}

/** The last probe's result, without probing. */
export function cachedLocalMcpStatuses(): LocalMcpServerStatus[] | null {
  return cached?.statuses ?? null;
}

/** What Claude sessions reported in their init messages (status only), as a fallback. */
function observedStatuses(): LocalMcpServerStatus[] {
  return observedMcpServers().map((o) => ({ name: o.name, status: toStatus(o.status), ...(o.source ? { source: o.source } : {}) }));
}

/**
 * Statuses from the Mac's Claude runtime, cached for a few minutes. Falls
 * back to what Claude sessions last reported when no probe is wired or it fails.
 */
export async function localMcpStatuses(opts: { refresh?: boolean; probe?: McpStatusProbe; now?: number } = {}): Promise<LocalMcpServerStatus[]> {
  const now = opts.now ?? Date.now();
  if (!opts.refresh && cached && now - cached.at < STATUS_TTL_MS) return cached.statuses;
  const probe = opts.probe ?? defaultProbe;
  if (!probe) return cached?.statuses ?? observedStatuses();
  if (!inflight) {
    inflight = probe()
      .then((statuses) => {
        cached = { at: Date.now(), statuses };
        return statuses;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (err) {
    console.warn("[local-mcp] couldn't read MCP statuses from Claude:", scrubMcpError(err instanceof Error ? err.message : err));
    return cached?.statuses ?? observedStatuses();
  }
}

// --- naming, write tools, descriptions ----------------------------------------------

export function isClaudeAiConnector(s: { name: string; source?: string }): boolean {
  return s.source === "claudeai" || /^claude\.ai /i.test(s.name);
}

/** The prefix Claude Code gives a server's tools: "claude.ai Slack" → mcp__claude_ai_Slack__. */
export function claudeToolPrefix(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
}

const WRITE_VERBS = new Set(
  (
    "send create update delete remove post write publish promote schedule upload import set add assign move copy share " +
    "trash restore cancel run invite archive edit patch put submit reply forward transfer pay refund charge execute " +
    "trigger enable disable duplicate apply resolve complete convert spawn stop start merge insert append replace rename"
  ).split(" "),
);

/** "sendEmailWithTemplate", "slack_send_message", "GMAIL_SEND_EMAIL" → their words, lowercased. */
function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Tools that change something outside: annotated destructive / not read-only,
 * or (when the server didn't say) named like a write ("sendEmail",
 * "slack_send_message", "create-campaign-tool").
 */
export function isWriteTool(tool: LocalMcpToolInfo): boolean {
  if (tool.destructive === true) return true;
  if (tool.readOnly === true) return false;
  if (tool.readOnly === false) return true;
  return toolWords(tool.name).some((w) => WRITE_VERBS.has(w));
}

export type LocalMcpKind = "config" | "connector" | "plugin" | "other";

export interface LocalClaudeMcpServer {
  /** The name in Claude's config, e.g. "postmark-staging" or "claude.ai Slack". */
  name: string;
  kind: LocalMcpKind;
  /** The spawn_agent integration name, when sub-agents can be given it. */
  integration?: string;
  source?: string;
  from?: string;
  transport?: string;
  status: LocalMcpStatus;
  error?: string;
  /** Config problem (e.g. missing env var). */
  problem?: string;
  toolCount?: number;
  writeTools?: string[];
}

/**
 * Config files and runtime statuses → one list. `integrationFor` names the
 * spawn_agent integration for a server (undefined when it isn't offered).
 */
export function mergeLocalClaudeMcp(
  configs: LocalMcpConfigEntry[],
  statuses: LocalMcpServerStatus[],
  integrationFor: (server: { name: string; kind: LocalMcpKind }) => string | undefined,
): LocalClaudeMcpServer[] {
  const statusByName = new Map(statuses.map((s) => [s.name, s]));
  const out: LocalClaudeMcpServer[] = [];
  const seen = new Set<string>();
  const withTools = (s: LocalMcpServerStatus | undefined) =>
    s?.tools ? { toolCount: s.tools.length, writeTools: s.tools.filter(isWriteTool).map((t) => t.name) } : {};
  for (const c of configs) {
    seen.add(c.name);
    const s = statusByName.get(c.name);
    out.push({
      name: c.name,
      kind: "config",
      integration: integrationFor({ name: c.name, kind: "config" }),
      source: c.scope,
      from: c.from,
      transport: c.transport,
      status: c.problem ? "failed" : (s?.status ?? "unknown"),
      ...(s?.error ? { error: s.error } : {}),
      ...(c.problem ? { problem: c.problem } : {}),
      ...withTools(s),
    });
  }
  for (const s of statuses) {
    if (seen.has(s.name) || s.source === "sdk" || s.source === "dynamic") continue;
    const kind: LocalMcpKind = isClaudeAiConnector(s) ? "connector" : s.source === "plugin" || s.name.startsWith("plugin:") ? "plugin" : "other";
    out.push({
      name: s.name,
      kind,
      integration: kind === "connector" ? integrationFor({ name: s.name, kind }) : undefined,
      source: s.source,
      transport: kind === "connector" ? "claude.ai" : undefined,
      status: s.status,
      ...(s.error ? { error: s.error } : {}),
      ...withTools(s),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function statusWords(s: LocalClaudeMcpServer): string {
  if (s.problem) return `failed: ${s.problem}`;
  switch (s.status) {
    case "connected":
      return `connected${s.toolCount !== undefined ? ` (${s.toolCount} tools)` : ""}`;
    case "needs-auth":
      return "needs auth";
    case "failed":
      return `failed${s.error ? `: ${s.error}` : ""}`;
    case "pending":
      return "still connecting";
    case "disabled":
      return "disabled in Claude";
    default:
      return "status not checked yet";
  }
}

/** For list_mcp_servers / list_integrations. Names, statuses and short errors only. */
export function describeLocalClaudeMcpServers(servers: LocalClaudeMcpServer[]): string {
  if (servers.length === 0) return "No MCP servers found in the Mac's Claude config (~/.claude.json, .mcp.json) or claude.ai connectors.";
  const lines = servers.map((s) => {
    const where = s.kind === "connector" ? "claude.ai connector" : s.kind === "plugin" ? "Claude plugin" : s.from ?? s.source ?? "Claude";
    const use = s.integration
      ? `spawn_agent integration "${s.integration}"`
      : s.kind === "plugin"
        ? "Claude Code only (plugins aren't passed to sub-agents)"
        : "not offered to sub-agents";
    const auth =
      s.status === "needs-auth"
        ? ` — sign in with start_mcp_auth "${normalizeServerName(s.name) ?? s.name}"${s.transport === "stdio" ? " or in Claude on the Mac" : ""}`
        : "";
    return `- ${s.name} (${where}${s.transport && s.kind !== "connector" ? `, ${s.transport}` : ""}): ${statusWords(s)}; ${use}${auth}`;
  });
  return ["MCP servers on the Mac's Claude (usable by sub-agents through Claude on the Mac):", ...lines].join("\n");
}

export const LOCAL_MCP_DESCRIPTION_PREFIX = "MCP server from the Mac's Claude";

/** Dispatcher-facing: which integrations are local Claude MCP servers. */
export function isLocalMcpIntegrationDescription(description: string): boolean {
  return description.startsWith(LOCAL_MCP_DESCRIPTION_PREFIX);
}
