import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { normalizeServerName } from "./config.js";

/**
 * Finds a remote MCP server's URL by name in the owner's Claude Code
 * configuration: ~/.claude.json (user and per-project servers), the repo's
 * .mcp.json, and the .mcp.json files of installed plugins. Only the `url` and
 * `type` of http/sse entries are read; headers, env and everything else in
 * those files are ignored and never returned.
 */

export interface DiscoveredMcpServer {
  name: string;
  url: string;
  from: string;
}

const MAX_CLAUDE_JSON_BYTES = 32 * 1024 * 1024;
const MAX_PLUGIN_DIRS = 400;

function remoteEntries(servers: unknown, from: string): DiscoveredMcpServer[] {
  if (!servers || typeof servers !== "object") return [];
  const out: DiscoveredMcpServer[] = [];
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== "object") continue;
    const { url, type } = cfg as { url?: unknown; type?: unknown };
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.includes("${")) continue;
    if (type !== undefined && !["http", "sse", "streamable-http"].includes(String(type))) continue;
    out.push({ name, url, from });
  }
  return out;
}

async function readJsonFile(file: string, maxBytes = 1024 * 1024): Promise<unknown> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function findPluginMcpFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < MAX_PLUGIN_DIRS) {
    const { dir, depth } = queue.shift()!;
    visited += 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === ".mcp.json") found.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < 6 && e.name !== "node_modules" && e.name !== ".git") {
        queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }
  }
  return found;
}

export async function listConfiguredRemoteMcpServers(
  opts: { home?: string; cwd?: string } = {},
): Promise<DiscoveredMcpServer[]> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const out: DiscoveredMcpServer[] = [];

  const claudeJson = (await readJsonFile(path.join(home, ".claude.json"), MAX_CLAUDE_JSON_BYTES)) as
    | { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> }
    | null;
  if (claudeJson) {
    out.push(...remoteEntries(claudeJson.mcpServers, "~/.claude.json"));
    for (const project of Object.values(claudeJson.projects ?? {})) {
      out.push(...remoteEntries(project?.mcpServers, "~/.claude.json (project)"));
    }
  }

  const projectMcp = (await readJsonFile(path.join(cwd, ".mcp.json"))) as { mcpServers?: unknown } | null;
  if (projectMcp) out.push(...remoteEntries(projectMcp.mcpServers, ".mcp.json"));

  for (const file of await findPluginMcpFiles(path.join(home, ".claude", "plugins"))) {
    const json = (await readJsonFile(file)) as { mcpServers?: unknown } | null;
    if (!json) continue;
    out.push(...remoteEntries(json.mcpServers ?? json, "Claude plugin"));
  }
  return out;
}

/** The URL configured for `name` in Claude Code, if exactly one turns up. */
export async function findConfiguredMcpServerUrl(
  name: string,
  opts: { home?: string; cwd?: string } = {},
): Promise<{ url: string; from: string } | { url: null; candidates: string[] }> {
  const wanted = normalizeServerName(name);
  const all = await listConfiguredRemoteMcpServers(opts);
  const matches = all.filter((s) => normalizeServerName(s.name) === wanted);
  const urls = [...new Set(matches.map((m) => m.url))];
  if (urls.length === 1) return { url: urls[0], from: matches[0].from };
  return { url: null, candidates: urls };
}
