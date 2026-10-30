import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import type { RuntimeTool } from "../runtimes/types.js";
import { registerIntegration } from "./registry.js";

const execFileAsync = promisify(execFile);

export const COMPOSIO_ACCOUNT_INTEGRATION = "composio-account";
const LOOKUP_TIMEOUT_MS = 30_000;
const EXECUTE_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 24_000;

/**
 * Boop's own Composio toolkits come from the project behind COMPOSIO_API_KEY.
 * The user's personal Composio account (the one the `composio` CLI is logged
 * in to) can hold connections that project never sees, including custom MCP
 * toolkits. This integration reaches them by calling the CLI.
 */
async function runComposio(args: string[], timeout: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("composio", args, {
      timeout,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    const detail = [failure.stderr, failure.stdout].filter(Boolean).join("\n").trim();
    throw new Error(detail || failure.message || String(err));
  }
}

export function truncateOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} characters]`;
}

export function parseConnectionSlugs(stdout: string): string[] {
  const data = JSON.parse(stdout) as Record<string, Array<{ status?: string }>>;
  return Object.entries(data)
    .filter(([, accounts]) =>
      Array.isArray(accounts) && accounts.some((account) => account.status === "ACTIVE"),
    )
    .map(([slug]) => slug)
    .sort();
}

export function displayToolkitName(slug: string): string {
  return slug
    .replace(/^custom_/, "")
    .split("_")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

type ConnectionMap = Record<string, Array<{ status?: string; word_id?: string }>>;

const PER_TOOLKIT_CONCURRENCY = 5;

/**
 * Every toolkit slug the personal account has connected, from Composio's
 * consumer API. `composio connections list` alone is cut short (it dropped 14
 * of 42 on 30 Oct 2026), so this is the authoritative list of what to ask for.
 * Returns null when the CLI login files or the API aren't available.
 */
async function fetchConnectedToolkitSlugs(): Promise<string[] | null> {
  try {
    const dir = join(homedir(), ".composio");
    const user = JSON.parse(await readFile(join(dir, "user_data.json"), "utf8")) as {
      api_key?: string;
      org_id?: string;
      base_url?: string;
    };
    const analytics = JSON.parse(await readFile(join(dir, "analytics.json"), "utf8")) as {
      apollo_user_id?: string;
    };
    if (!user.api_key || !user.org_id || !analytics.apollo_user_id) return null;
    const base = (user.base_url ?? "https://backend.composio.dev").replace(/\/$/, "");
    const userId = `consumer-${analytics.apollo_user_id}-${user.org_id}`;
    const res = await fetch(
      `${base}/api/v3.1/org/consumer/connected_toolkits?user_id=${encodeURIComponent(userId)}`,
      {
        headers: { "x-user-api-key": user.api_key, "x-org-id": user.org_id },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { toolkits?: unknown };
    return Array.isArray(body.toolkits)
      ? body.toolkits.filter((slug): slug is string => typeof slug === "string")
      : null;
  } catch {
    return null;
  }
}

export function mergeConnectionMaps(base: ConnectionMap, extra: ConnectionMap[]): ConnectionMap {
  const merged: ConnectionMap = { ...base };
  for (const map of extra) {
    for (const [slug, accounts] of Object.entries(map)) {
      if (!merged[slug] || merged[slug]!.length === 0) merged[slug] = accounts;
    }
  }
  return merged;
}

/** The full connection map: the CLI list, plus each toolkit it left out. */
async function fetchConnectionMap(): Promise<ConnectionMap> {
  const [listed, allSlugs] = await Promise.all([
    runComposio(["connections", "list"], LOOKUP_TIMEOUT_MS).then(
      (stdout) => JSON.parse(stdout) as ConnectionMap,
    ),
    fetchConnectedToolkitSlugs(),
  ]);
  const missing = (allSlugs ?? []).filter((slug) => !listed[slug]);
  const extra: ConnectionMap[] = [];
  for (let i = 0; i < missing.length; i += PER_TOOLKIT_CONCURRENCY) {
    const batch = missing.slice(i, i + PER_TOOLKIT_CONCURRENCY);
    const results = await Promise.all(
      batch.map((slug) =>
        runComposio(["connections", "list", "--toolkit", slug], LOOKUP_TIMEOUT_MS)
          .then((stdout) => JSON.parse(stdout) as ConnectionMap)
          .catch(() => ({}) as ConnectionMap),
      ),
    );
    extra.push(...results);
  }
  return mergeConnectionMaps(listed, extra);
}

export async function listComposioAccountToolkits(): Promise<string[]> {
  return parseConnectionSlugs(JSON.stringify(await fetchConnectionMap()));
}

async function wrap(run: () => Promise<string>) {
  try {
    return { text: truncateOutput(await run()) };
  } catch (err) {
    return {
      text: `Composio CLI failed: ${err instanceof Error ? err.message : String(err)}`,
      success: false,
    };
  }
}

export function createComposioAccountTools(
  toolkits: string[],
  namespace = COMPOSIO_ACCOUNT_INTEGRATION,
): RuntimeTool[] {
  const toolkitList = toolkits.join(", ");
  return [
    defineRuntimeTool(
      namespace,
      "composio_search_tools",
      `Find the tool slugs for a task across the user's personal Composio connections (${toolkitList}). Start here, then fetch the schema and execute.`,
      {
        queries: z
          .array(z.string())
          .describe('Plain-language use cases, e.g. ["list recent orders", "create an invoice"].'),
        toolkits: z
          .string()
          .optional()
          .describe("Optional comma-separated toolkit slugs to search within, e.g. custom_vueschool_staging."),
      },
      async ({ queries, toolkits: filter }) =>
        wrap(() =>
          runComposio(
            ["search", ...queries, "--limit", "5", ...(filter ? ["--toolkits", filter] : [])],
            LOOKUP_TIMEOUT_MS,
          ),
        ),
    ),
    defineRuntimeTool(
      namespace,
      "composio_get_tool_schema",
      "Get the input schema for a Composio tool slug before executing it.",
      { slug: z.string().describe("Tool slug, e.g. CUSTOM_VUESCHOOL_STAGING_NOVA_LIST_RECORDS.") },
      async ({ slug }) =>
        wrap(() => runComposio(["execute", slug, "--get-schema"], LOOKUP_TIMEOUT_MS)),
    ),
    defineRuntimeTool(
      namespace,
      "composio_execute_tool",
      "Run a Composio tool from the user's personal account. Anything that sends, posts, deletes or changes data outside Boop must be confirmed by the user first.",
      {
        slug: z.string().describe("Tool slug from composio_search_tools."),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Tool arguments matching the schema."),
        account: z
          .string()
          .optional()
          .describe("Connected account alias, word_id or id, when the toolkit has several."),
      },
      async ({ slug, arguments: toolArgs, account }) =>
        wrap(() =>
          runComposio(
            [
              "execute",
              slug,
              "-d",
              JSON.stringify(toolArgs ?? {}),
              ...(account ? ["--account", account] : []),
            ],
            EXECUTE_TIMEOUT_MS,
          ),
        ),
    ),
    defineRuntimeTool(
      namespace,
      "composio_list_connections",
      "List the user's personal Composio connections with their account aliases and status.",
      {},
      async () => wrap(() => runComposio(["connections", "list"], LOOKUP_TIMEOUT_MS)),
    ),
  ];
}

const TOOLKIT_CACHE_MS = 60_000;
let toolkitCache: { at: number; toolkits: string[] } | null = null;
let toolkitRefresh: Promise<string[]> | null = null;

/**
 * The personal account changes outside Boop (connections added or removed in
 * Composio), so read it live, cached for a minute, instead of once at startup.
 */
export async function currentComposioAccountToolkits(options: { fresh?: boolean } = {}): Promise<string[]> {
  if (!options.fresh && toolkitCache && Date.now() - toolkitCache.at < TOOLKIT_CACHE_MS) {
    return toolkitCache.toolkits;
  }
  toolkitRefresh ??= listComposioAccountToolkits()
    .then((toolkits) => {
      toolkitCache = { at: Date.now(), toolkits };
      return toolkits;
    })
    .finally(() => {
      toolkitRefresh = null;
    });
  return toolkitRefresh;
}

export function describeComposioAccount(toolkits: string[]): string {
  const names = toolkits.map(displayToolkitName).join(", ");
  return `The user's personal Composio account (via the composio CLI): ${names}. Use it for these services, including the custom ones Boop's own toolkits don't cover.`;
}

export async function registerComposioAccountIntegration(): Promise<void> {
  try {
    const connections = await listComposioAccountConnections({ fresh: true });
    if (connections === null) throw new Error("spawn composio ENOENT");
  } catch (err) {
    const missing = (err as Error).message.includes("ENOENT");
    console.log(
      missing
        ? "[composio-account] composio CLI not installed; skipping personal Composio connections"
        : `[composio-account] skipped: ${(err as Error).message.split("\n")[0]}`,
    );
    return;
  }

  registerIntegration({
    name: COMPOSIO_ACCOUNT_INTEGRATION,
    get description() {
      return describeComposioAccount(toolkitCache?.toolkits ?? []);
    },
    isEnabled: async () => (await currentComposioAccountToolkits().catch(() => [])).length > 0,
    createServer: async () =>
      createClaudeMcpServer(
        COMPOSIO_ACCOUNT_INTEGRATION,
        createComposioAccountTools(await currentComposioAccountToolkits()),
      ),
    createTools: async () => createComposioAccountTools(await currentComposioAccountToolkits()),
  });
  console.log(
    `[composio-account] registered; ${toolkitCache?.toolkits.length ?? 0} personal Composio connection(s) right now, re-read every minute`,
  );
}

export interface ComposioAccountConnection {
  slug: string;
  name: string;
  active: number;
  total: number;
  custom: boolean;
}

export function parseConnectionSummary(stdout: string): ComposioAccountConnection[] {
  const data = JSON.parse(stdout) as Record<string, Array<{ status?: string }>>;
  return Object.entries(data)
    .filter(([, accounts]) => Array.isArray(accounts) && accounts.length > 0)
    .map(([slug, accounts]) => ({
      slug,
      name: displayToolkitName(slug),
      active: accounts.filter((account) => account.status === "ACTIVE").length,
      total: accounts.length,
      custom: slug.startsWith("custom_"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The personal account's connections for the dashboard, or null without the CLI. */
let summaryCache: { at: number; connections: ComposioAccountConnection[] } | null = null;

export async function listComposioAccountConnections(
  options: { fresh?: boolean } = {},
): Promise<ComposioAccountConnection[] | null> {
  if (!options.fresh && summaryCache && Date.now() - summaryCache.at < TOOLKIT_CACHE_MS) {
    return summaryCache.connections;
  }
  try {
    const stdout = JSON.stringify(await fetchConnectionMap());
    toolkitCache = { at: Date.now(), toolkits: parseConnectionSlugs(stdout) };
    const connections = parseConnectionSummary(stdout);
    summaryCache = { at: Date.now(), connections };
    return connections;
  } catch (err) {
    if ((err as Error).message.includes("ENOENT")) return null;
    throw err;
  }
}
