import { execFile } from "node:child_process";
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

export async function listComposioAccountToolkits(): Promise<string[]> {
  return parseConnectionSlugs(await runComposio(["connections", "list"], LOOKUP_TIMEOUT_MS));
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

export async function registerComposioAccountIntegration(): Promise<void> {
  let toolkits: string[];
  try {
    toolkits = await listComposioAccountToolkits();
  } catch (err) {
    const missing = (err as Error).message.includes("ENOENT");
    console.log(
      missing
        ? "[composio-account] composio CLI not installed; skipping personal Composio connections"
        : `[composio-account] skipped: ${(err as Error).message.split("\n")[0]}`,
    );
    return;
  }
  if (toolkits.length === 0) {
    console.log("[composio-account] no active connections in the composio CLI account");
    return;
  }

  const names = toolkits.map(displayToolkitName).join(", ");
  registerIntegration({
    name: COMPOSIO_ACCOUNT_INTEGRATION,
    description: `The user's personal Composio account (via the composio CLI): ${names}. Use it for these services, including the custom ones Boop's own toolkits don't cover.`,
    createServer: async () =>
      createClaudeMcpServer(COMPOSIO_ACCOUNT_INTEGRATION, createComposioAccountTools(toolkits)),
    createTools: async () => createComposioAccountTools(toolkits),
  });
  console.log(
    `[composio-account] registered ${toolkits.length} personal Composio connection(s): ${toolkits.join(", ")}`,
  );
}
