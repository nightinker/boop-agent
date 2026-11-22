import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeToolPrefix,
  describeLocalClaudeMcpServers,
  expandEnvVars,
  isWriteTool,
  localMcpStatuses,
  mergeLocalClaudeMcp,
  readLocalClaudeMcpConfigs,
  scrubMcpError,
  setLocalMcpStatusProbe,
  statusFromSdk,
  type LocalClaudeMcpServer,
  type LocalMcpConfigEntry,
  type LocalMcpServerStatus,
} from "../server/claude-mcp/local.js";
import { clearObservedMcpServers, noteMcpServerStatuses } from "../server/mcp-auth/config.js";
import {
  buildMcpServersForIntegrations,
  claudeToolPatternsForIntegrations,
  filterIntegrationsForOwner,
  getIntegration,
  registerIntegration,
} from "../server/integrations/registry.js";
import {
  describeLocalIntegrationsForPrompt,
  localClaudeMcpExecutionPrompt,
  localClaudeMcpServers,
  registerLocalClaudeMcpIntegrations,
  unselectedConnectorDenyRules,
} from "../server/integrations/claude-local-loader.js";
import { createMcpAuthDispatcherTools } from "../server/mcp-auth/tools.js";
import type { McpAuthService } from "../server/mcp-auth/service.js";
import type { RuntimeTool } from "../server/runtimes/types.js";

// Fake credentials, built at runtime so nothing token-shaped sits in the repo.
const fakeKey = "fake-server-key-" + "x".repeat(24);
const fakeHeader = "fake-header-" + "y".repeat(24);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "boop-local-mcp-test-"));
  clearObservedMcpServers();
  setLocalMcpStatusProbe(null);
});

afterEach(async () => {
  clearObservedMcpServers();
  setLocalMcpStatusProbe(null);
  await rm(dir, { recursive: true, force: true });
});

async function writeClaudeConfig() {
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "project");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "postmark-staging": { command: "node", args: ["${PM_DIR}/index.js"], env: { POSTMARK_SERVER_TOKEN: "${PM_KEY}" } },
        figma: { type: "http", url: "https://mcp.example.com/mcp?team=1", headers: { Authorization: `Bearer ${fakeHeader}` } },
        "needs-var": { type: "http", url: "https://${MISSING_HOST}/mcp" },
        shadowed: { command: "user-version" },
        weird: { type: "websocket", url: "wss://example.com" },
      },
      projects: {
        [path.resolve(cwd)]: { mcpServers: { shadowed: { command: "local-version" } } },
        "/somewhere/else": { mcpServers: { "other-project": { command: "nope" } } },
      },
    }),
  );
  await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { "team-tools": { command: "npx", args: ["team-tools"] } } }));
  return { home, cwd, env: { PM_DIR: "/opt/pm", PM_KEY: fakeKey } as NodeJS.ProcessEnv };
}

describe("reading the Mac's Claude MCP config", () => {
  it("reads user, local and project servers with Claude's precedence and env expansion", async () => {
    const { home, cwd, env } = await writeClaudeConfig();
    const configs = await readLocalClaudeMcpConfigs({ home, cwd, env });
    const byName = Object.fromEntries(configs.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(["figma", "needs-var", "postmark-staging", "shadowed", "team-tools"]);
    expect(byName["postmark-staging"]).toMatchObject({
      scope: "user",
      transport: "stdio",
      config: { type: "stdio", command: "node", args: ["/opt/pm/index.js"], env: { POSTMARK_SERVER_TOKEN: fakeKey } },
    });
    expect(byName.figma.config).toMatchObject({ type: "http", url: "https://mcp.example.com/mcp?team=1" });
    expect(byName.shadowed).toMatchObject({ scope: "local", config: { command: "local-version" } });
    expect(byName["team-tools"]).toMatchObject({ scope: "project", from: ".mcp.json" });
    // A missing variable names the variable, never a value, and the server has no config.
    expect(byName["needs-var"].config).toBeUndefined();
    expect(byName["needs-var"].problem).toContain("MISSING_HOST");
  });

  it("expands ${VAR:-default} and refuses unset variables", () => {
    expect(expandEnvVars("${A:-fallback}/${B}", { B: "b" })).toBe("fallback/b");
    expect(() => expandEnvVars("${NOPE}", {})).toThrow();
  });

  it("returns nothing when there is no config", async () => {
    expect(await readLocalClaudeMcpConfigs({ home: path.join(dir, "none"), cwd: path.join(dir, "none"), env: {} })).toEqual([]);
  });
});

describe("statuses and write tools", () => {
  it("scrubs errors to one short line without query strings or credentials", () => {
    const scrubbed = scrubMcpError(`connect failed https://api.example.com/mcp?token=${fakeKey}\nstack trace`)!;
    expect(scrubbed).toBe("connect failed https://api.example.com/mcp");
    expect(scrubMcpError("x".repeat(500))!.length).toBeLessThanOrEqual(160);
    expect(scrubMcpError(undefined)).toBeUndefined();
  });

  it("maps SDK statuses without the server config", () => {
    const s = statusFromSdk({
      name: "ray-app",
      status: "failed",
      source: "user",
      error: "ECONNREFUSED: Unable to connect.",
      config: { type: "http", url: "http://localhost:1234/mcp", headers: { Authorization: fakeHeader } },
    });
    expect(s).toEqual({ name: "ray-app", status: "failed", source: "user", error: "ECONNREFUSED: Unable to connect." });
    expect(JSON.stringify(s)).not.toContain(fakeHeader);
  });

  it("tells write/send tools from read tools", () => {
    expect(isWriteTool({ name: "sendEmail" })).toBe(true);
    expect(isWriteTool({ name: "sendEmailWithTemplate" })).toBe(true);
    expect(isWriteTool({ name: "slack_send_message" })).toBe(true);
    expect(isWriteTool({ name: "GMAIL_SEND_EMAIL" })).toBe(true);
    expect(isWriteTool({ name: "create-campaign-tool" })).toBe(true);
    expect(isWriteTool({ name: "list_folder" })).toBe(false);
    expect(isWriteTool({ name: "getDeliveryStats" })).toBe(false);
    expect(isWriteTool({ name: "notion-fetch" })).toBe(false);
    expect(isWriteTool({ name: "dataset_preset_lookup" })).toBe(false);
    // Annotations win over the name.
    expect(isWriteTool({ name: "sendPreview", readOnly: true })).toBe(false);
    expect(isWriteTool({ name: "lookup", destructive: true })).toBe(true);
  });

  it("caches probe results and falls back to what Claude sessions reported", async () => {
    let calls = 0;
    const probe = async (): Promise<LocalMcpServerStatus[]> => {
      calls += 1;
      return [{ name: "figma", status: "connected", source: "user" }];
    };
    expect(await localMcpStatuses({ probe })).toEqual([{ name: "figma", status: "connected", source: "user" }]);
    await localMcpStatuses({ probe });
    expect(calls).toBe(1);
    await localMcpStatuses({ probe, refresh: true });
    expect(calls).toBe(2);

    setLocalMcpStatusProbe(null);
    noteMcpServerStatuses([{ name: "claude.ai Slack", status: "connected", source: "claudeai" }]);
    expect(await localMcpStatuses({ probe: async () => Promise.reject(new Error("no claude")) })).toEqual([
      { name: "claude.ai Slack", status: "connected", source: "claudeai" },
    ]);
  });

  it("describes servers with status, integration names and sign-in hints, never configs", async () => {
    const { home, cwd, env } = await writeClaudeConfig();
    const configs = await readLocalClaudeMcpConfigs({ home, cwd, env });
    const statuses: LocalMcpServerStatus[] = [
      { name: "postmark-staging", status: "connected", source: "user", tools: [{ name: "sendEmail" }, { name: "getDeliveryStats" }] },
      { name: "figma", status: "needs-auth", source: "user" },
      { name: "ray-app", status: "failed", source: "user", error: "ECONNREFUSED: Unable to connect." },
      { name: "claude.ai Slack", status: "connected", source: "claudeai", tools: [{ name: "slack_send_message" }] },
      { name: "plugin:stripe:stripe", status: "needs-auth", source: "plugin" },
      { name: "boop-secrets", status: "connected", source: "sdk" },
    ];
    const merged = mergeLocalClaudeMcp(configs, statuses, (s) => (s.name === "claude.ai Slack" ? "claude-ai-slack" : s.name));
    const pm = merged.find((s) => s.name === "postmark-staging")!;
    expect(pm).toMatchObject({ status: "connected", toolCount: 2, writeTools: ["sendEmail"], integration: "postmark-staging" });
    expect(merged.find((s) => s.name === "claude.ai Slack")).toMatchObject({ kind: "connector", integration: "claude-ai-slack" });
    expect(merged.some((s) => s.name === "boop-secrets")).toBe(false);

    const text = describeLocalClaudeMcpServers(merged);
    expect(text).toContain("postmark-staging (~/.claude.json, stdio): connected (2 tools)");
    expect(text).toContain('spawn_agent integration "postmark-staging"');
    expect(text).toContain('figma (~/.claude.json, http): needs auth; spawn_agent integration "figma" — sign in with start_mcp_auth "figma"');
    expect(text).toContain("ray-app (user): failed: ECONNREFUSED: Unable to connect.");
    expect(text).toContain("needs-var (~/.claude.json, http): failed: needs the environment variable MISSING_HOST");
    expect(text).toContain("claude.ai Slack (claude.ai connector): connected (1 tools)");
    expect(text).toContain("plugins aren't passed to sub-agents");
    expect(text).not.toContain(fakeKey);
    expect(text).not.toContain(fakeHeader);
    expect(text).not.toContain("index.js");
  });
});

describe("spawn_agent integrations from the Mac's Claude", () => {
  const connectorStatuses: LocalMcpServerStatus[] = [
    { name: "postmark-staging", status: "connected", source: "user", tools: [{ name: "sendEmail" }, { name: "sendEmailWithTemplate" }, { name: "getDeliveryStats" }] },
    { name: "ray-app", status: "failed", source: "user", error: "ECONNREFUSED: Unable to connect." },
    { name: "needs-login", status: "needs-auth", source: "user" },
    { name: "claude.ai Slack", status: "connected", source: "claudeai", tools: [{ name: "slack_send_message" }, { name: "slack_read_channel" }] },
    { name: "claude.ai Notion", status: "connected", source: "claudeai" },
  ];
  const configs: LocalMcpConfigEntry[] = [
    { name: "postmark-staging", scope: "user", from: "~/.claude.json", transport: "stdio", config: { type: "stdio", command: "node", env: { KEY: fakeKey } } },
    { name: "ray-app", scope: "user", from: "~/.claude.json", transport: "http", config: { type: "http", url: "http://localhost:1/mcp" } },
    { name: "needs-login", scope: "user", from: "~/.claude.json", transport: "http", config: { type: "http", url: "https://login.example.com/mcp" } },
    { name: "slack", scope: "user", from: "~/.claude.json", transport: "http", config: { type: "http", url: "https://slack.example.com/mcp" } },
    { name: "bannerstudio", scope: "user", from: "~/.claude.json", transport: "http", config: { type: "http", url: "https://banners.example.com/mcp" } },
    { name: "boop-self-builds", scope: "project", from: ".mcp.json", transport: "stdio", config: { type: "stdio", command: "npx" } },
    { name: "team-tools", scope: "project", from: ".mcp.json", transport: "stdio", config: { type: "stdio", command: "npx" } },
  ];

  async function load() {
    // A Composio toolkit and a server Boop authenticates itself, registered first.
    registerIntegration({ name: "slack", description: "Slack", createServer: async () => ({ type: "http", url: "https://composio.example.com" }) });
    registerIntegration({ name: "bannerstudio", description: "Remote MCP server bannerstudio (banners.example.com), authenticated by Boop", createServer: async () => ({ type: "http", url: "http://127.0.0.1/mcp-proxy/bannerstudio" }) });
    setLocalMcpStatusProbe(async () => connectorStatuses);
    await localMcpStatuses({ refresh: true });
    await registerLocalClaudeMcpIntegrations({ readConfigs: async () => configs, probe: false, env: {} });
  }

  it("registers config servers by name, connectors as claude-ai-*, and avoids collisions", async () => {
    await load();
    expect(getIntegration("postmark-staging")?.ownerOnly).toBe(true);
    expect(getIntegration("claude-ai-slack")?.claudeToolPatterns).toEqual(["mcp__claude_ai_Slack__*"]);
    // Composio's "slack" stays; Claude's copy gets a suffix.
    expect(getIntegration("slack")?.description).toBe("Slack");
    expect(getIntegration("slack-claude")).toBeDefined();
    // Boop's own authenticated server wins; Claude's copy isn't added.
    expect(getIntegration("bannerstudio-claude")).toBeUndefined();
    expect(getIntegration("boop-self-builds")).toBeUndefined();
    // .mcp.json servers are loaded by the sub-agent's Claude itself.
    expect(getIntegration("team-tools")?.createServer).toBeUndefined();
    expect(claudeToolPatternsForIntegrations(["team-tools"])).toEqual(["mcp__team-tools__*"]);
  });

  it("passes the server config to the sub-agent and keeps failed servers selectable", async () => {
    await load();
    const servers = await buildMcpServersForIntegrations(["postmark-staging", "claude-ai-slack", "ray-app"]);
    expect(Object.keys(servers).sort()).toEqual(["postmark-staging", "ray-app"]);
    expect(servers["postmark-staging"]).toMatchObject({ type: "stdio", command: "node" });
    expect(await getIntegration("ray-app")!.isEnabled!()).toBe(true);
    // Needs sign-in: not offered until it's authenticated (start_mcp_auth).
    expect(await getIntegration("needs-login")!.isEnabled!()).toBe(false);
    expect(describeLocalIntegrationsForPrompt(["postmark-staging", "ray-app", "gmail"])).toBe(
      "postmark-staging, ray-app (failed: ECONNREFUSED: Unable to connect.)",
    );
  });

  it("is owner-only and denies connectors a sub-agent wasn't given", async () => {
    await load();
    expect(filterIntegrationsForOwner(["gmail-x", "postmark-staging", "claude-ai-slack"], false)).toEqual(["gmail-x"]);
    expect(filterIntegrationsForOwner(["postmark-staging"], true)).toEqual(["postmark-staging"]);
    expect(unselectedConnectorDenyRules(["claude-ai-slack"])).toEqual(["mcp__claude_ai_Notion"]);
    expect(unselectedConnectorDenyRules([])).toEqual(["mcp__claude_ai_Notion", "mcp__claude_ai_Slack"]);
  });

  it("tells the sub-agent the tools it has, which ones need a draft, and to report failures plainly", async () => {
    await load();
    const prompt = localClaudeMcpExecutionPrompt(["postmark-staging", "claude-ai-slack", "ray-app", "gmail"]);
    expect(prompt).toContain('integration "postmark-staging"');
    expect(prompt).toContain("tools mcp__postmark-staging__*");
    expect(prompt).toContain("write/send tools (draft first): sendEmail, sendEmailWithTemplate");
    expect(prompt).not.toContain("getDeliveryStats");
    expect(prompt).toContain('claude.ai connector "claude.ai Slack"');
    expect(prompt).toContain("last status: failed (ECONNREFUSED");
    expect(prompt).toContain("save_draft");
    expect(prompt).toContain("never that the access doesn't exist");
    expect(prompt).not.toContain(fakeKey);
    expect(localClaudeMcpExecutionPrompt(["gmail"])).toBe("");
  });

  it("lists them, with integration names, for list_mcp_servers", async () => {
    await load();
    const servers = await localClaudeMcpServers({ readConfigs: async () => configs });
    const pm = servers.find((s) => s.name === "postmark-staging");
    expect(pm).toMatchObject({ integration: "postmark-staging", status: "connected" });
    expect(servers.find((s) => s.name === "slack")?.integration).toBe("slack-claude");
    expect(servers.find((s) => s.name === "claude.ai Notion")?.integration).toBe("claude-ai-notion");
    expect(claudeToolPrefix("claude.ai Certificates.dev Nova")).toBe("mcp__claude_ai_Certificates_dev_Nova__");
  });
});

describe("list_mcp_servers with the Mac's Claude servers", () => {
  function fakeService(supported = true): McpAuthService {
    return {
      supported,
      config: { list: async () => [] },
      describe: async () => "connected",
    } as unknown as McpAuthService;
  }
  const tool = (tools: RuntimeTool[], name: string) => tools.find((t) => t.name === name)!;
  const local: LocalClaudeMcpServer[] = [
    { name: "postmark-staging", kind: "config", integration: "postmark-staging", source: "user", from: "~/.claude.json", transport: "stdio", status: "connected", toolCount: 24 },
    { name: "ray-app", kind: "config", integration: "ray-app", source: "user", from: "~/.claude.json", transport: "http", status: "failed", error: "ECONNREFUSED: Unable to connect." },
  ];

  it("shows them to the owner, refreshing on request", async () => {
    const calls: boolean[] = [];
    const tools = createMcpAuthDispatcherTools("local:owner", {
      service: () => fakeService(),
      localServers: async (opts) => {
        calls.push(Boolean(opts.refresh));
        return local;
      },
    });
    const res = await tool(tools, "list_mcp_servers").handle({ refresh: true });
    expect(res.text).toContain("postmark-staging (~/.claude.json, stdio): connected (24 tools)");
    expect(res.text).toContain("ray-app (~/.claude.json, http): failed: ECONNREFUSED");
    expect(calls).toEqual([true]);
  });

  it("still lists them where Boop can't store MCP credentials", async () => {
    const tools = createMcpAuthDispatcherTools("local:owner", { service: () => fakeService(false), localServers: async () => local });
    const res = await tool(tools, "list_mcp_servers").handle({});
    expect(res.text).toContain("postmark-staging");
  });

  it("refuses anyone but the owner", async () => {
    const tools = createMcpAuthDispatcherTools("sms:+15550000001", {
      service: () => fakeService(),
      ownerNumbers: () => "+15550000002",
      localServers: async () => local,
    });
    const res = await tool(tools, "list_mcp_servers").handle({});
    expect(res.success).toBe(false);
    expect(res.text).not.toContain("postmark");
  });
});

describe("dispatcher and list_integrations wording", () => {
  it("groups the Mac's Claude servers in the dispatcher's integration list", async () => {
    const { describeIntegrationsForPrompt } = await import("../server/interaction-agent.js");
    const text = describeIntegrationsForPrompt([
      { name: "gmail", description: "Gmail" },
      { name: "postmark-staging", description: "MCP server from the Mac's Claude (~/.claude.json, stdio): postmark-staging" },
    ]);
    expect(text.split("\n")[0]).toBe("gmail");
    expect(text).toContain("Mac Claude MCP servers: postmark-staging");
  });

  it("shows status rows in list_integrations", async () => {
    const { localMcpIntegrationRow } = await import("../server/self-tools.js");
    expect(
      localMcpIntegrationRow({ name: "ray-app", kind: "config", integration: "ray-app", from: "~/.claude.json", status: "failed", error: "ECONNREFUSED" }),
    ).toEqual({ slug: "ray-app", status: "FAILED: ECONNREFUSED", account: `Mac's Claude MCP server "ray-app" (~/.claude.json) — spawn with integration "ray-app"` });
    expect(localMcpIntegrationRow({ name: "figma", kind: "config", status: "needs-auth", from: "~/.claude.json" }).status).toBe("NEEDS AUTH (start_mcp_auth)");
  });
});
