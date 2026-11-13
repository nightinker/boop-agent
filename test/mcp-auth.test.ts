import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearObservedMcpServers,
  McpServerConfigStore,
  noteMcpServerStatuses,
  normalizeServerName,
  secretNames,
} from "../server/mcp-auth/config.js";
import { findConfiguredMcpServerUrl } from "../server/mcp-auth/discover.js";
import {
  assertSecureUrl,
  authServerMetadataUrls,
  canonicalResource,
  isGrantRevoked,
  OAuthError,
  parseWwwAuthenticate,
} from "../server/mcp-auth/oauth.js";
import { createMcpAuthRouter, createMcpProxyRouter, MCP_PROXY_KEY_HEADER } from "../server/mcp-auth/routes.js";
import { McpAuthService } from "../server/mcp-auth/service.js";
import { createMcpAuthDispatcherTools } from "../server/mcp-auth/tools.js";
import { createSecretsPublicApp, secretsPublicConfigFromEnv, SECRETS_PORTAL_PASSCODE_NAME } from "../server/secrets/public-host.js";
import { SecretRequestRegistry } from "../server/secrets/requests.js";
import { SecretStore } from "../server/secrets/store.js";
import type { RuntimeTool } from "../server/runtimes/types.js";

// Fake credentials, built at runtime so nothing token-shaped sits in the repo.
const tok = (label: string) => `fake-${label}-` + "x".repeat(24);
const PASSCODE = "correct" + "-horse-battery";

let dir: string;
let closers: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "boop-mcp-auth-test-"));
  clearObservedMcpServers();
});

afterEach(async () => {
  for (const close of closers.reverse()) await close();
  closers = [];
  clearObservedMcpServers();
  await rm(dir, { recursive: true, force: true });
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  closers.push(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A fake MCP server that is also its own OAuth authorization server:
 * RFC 9728 metadata, RFC 8414 metadata, dynamic registration, PKCE-checked
 * code exchange, refresh with rotation, and revocation on demand.
 */
async function fakeOAuthMcp(opts: { registration?: boolean } = {}) {
  const state = {
    base: "",
    codes: new Map<string, { challenge: string; redirectUri: string; resource: string }>(),
    validAccess: new Set<string>(),
    validRefresh: new Set<string>(),
    issued: 0,
    registeredRedirects: [] as string[],
    tokenRequests: [] as Record<string, string>[],
    mcpAuthHeaders: [] as string[],
    revoked: false,
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.post("/mcp", express.raw({ type: () => true }), (req, res) => {
    const auth = req.headers.authorization ?? "";
    state.mcpAuthHeaders.push(auth);
    const token = auth.replace(/^Bearer /, "");
    if (!state.validAccess.has(token)) {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`);
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.setHeader("mcp-session-id", "session-1");
    const body = JSON.parse(String(req.body));
    res.json({ jsonrpc: "2.0", id: body.id, result: { echoed: body.method } });
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({ resource: `${state.base}/mcp`, authorization_servers: [state.base], scopes_supported: ["mcp:tools"] });
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: state.base,
      authorization_endpoint: `${state.base}/authorize`,
      token_endpoint: `${state.base}/token`,
      ...(opts.registration === false ? {} : { registration_endpoint: `${state.base}/register` }),
      code_challenge_methods_supported: ["S256"],
    });
  });
  app.post("/register", express.json(), (req, res) => {
    state.registeredRedirects = req.body.redirect_uris;
    res.status(201).json({ client_id: "client-1", token_endpoint_auth_method: "none" });
  });
  const issue = () => {
    state.issued += 1;
    const access = tok(`access${state.issued}`);
    const refresh = tok(`refresh${state.issued}`);
    state.validAccess.clear();
    state.validAccess.add(access);
    state.validRefresh.clear();
    state.validRefresh.add(refresh);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
  };
  app.post("/token", (req, res) => {
    const body = req.body as Record<string, string>;
    state.tokenRequests.push(body);
    if (body.grant_type === "authorization_code") {
      const code = state.codes.get(body.code);
      state.codes.delete(body.code);
      const challenge = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
      if (!code || code.challenge !== challenge || code.redirectUri !== body.redirect_uri || code.resource !== body.resource) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      res.json(issue());
      return;
    }
    if (body.grant_type === "refresh_token") {
      if (state.revoked || !state.validRefresh.has(body.refresh_token)) {
        res.status(400).json({ error: "invalid_grant", error_description: "revoked" });
        return;
      }
      res.json(issue());
      return;
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });
  state.base = await listen(app);
  /** What a browser does at the authorize URL when the owner approves. */
  const approve = (authorizeUrl: string) => {
    const u = new URL(authorizeUrl);
    const code = `code-${state.codes.size + 1}`;
    state.codes.set(code, {
      challenge: u.searchParams.get("code_challenge")!,
      redirectUri: u.searchParams.get("redirect_uri")!,
      resource: u.searchParams.get("resource")!,
    });
    return { code, state: u.searchParams.get("state")! };
  };
  return { state, approve, url: `${state.base}/mcp` };
}

function setup(opts: { now?: () => number; env?: NodeJS.ProcessEnv } = {}) {
  const store = new SecretStore({ dir, prefer: "file", platform: "darwin", updateRedactor: false });
  const config = new McpServerConfigStore(path.join(dir, "mcp-servers.json"));
  const notes: { conversationId: string; text: string }[] = [];
  const env = { PORT: "3456", BOOP_SECRETS_REMOTE_CONFIG: path.join(dir, "missing.json"), ...opts.env };
  const service = new McpAuthService({
    config,
    store: () => store,
    platform: "darwin",
    env,
    now: opts.now,
    notify: async (conversationId, text) => {
      notes.push({ conversationId, text });
    },
  });
  return { store, config, service, notes, env };
}

async function connect(service: McpAuthService, fake: Awaited<ReturnType<typeof fakeOAuthMcp>>, name = "demo") {
  await service.config.put({ name, url: fake.url, auth: "oauth", state: "needs-auth", updatedAt: 0, conversationId: "local:owner" });
  const link = await service.createStartLink(name, "local:owner");
  const token = link.local.split("/").pop()!;
  const begun = await service.beginFlow(token, "local");
  if (!begun.ok) throw new Error(begun.message);
  return service.completeFlow(fake.approve(begun.url));
}

function tool(tools: RuntimeTool[], name: string) {
  return tools.find((t) => t.name === name)!;
}

describe("OAuth helpers", () => {
  it("parses WWW-Authenticate parameters", () => {
    expect(parseWwwAuthenticate('Bearer resource_metadata="https://x.example/.well-known/a", scope="a b", error=invalid_token')).toEqual({
      resource_metadata: "https://x.example/.well-known/a",
      scope: "a b",
      error: "invalid_token",
    });
    expect(parseWwwAuthenticate(null)).toEqual({});
  });

  it("only allows https, or http to this machine", () => {
    expect(() => assertSecureUrl("http://api.example.com/mcp")).toThrow(OAuthError);
    expect(() => assertSecureUrl("https://user:pw@api.example.com/mcp")).toThrow(OAuthError);
    expect(assertSecureUrl("https://api.example.com/mcp").host).toBe("api.example.com");
    expect(assertSecureUrl("http://127.0.0.1:9/mcp").port).toBe("9");
  });

  it("builds canonical resources and metadata URLs per the spec", () => {
    expect(canonicalResource("https://API.example.com/mcp/#x")).toBe("https://api.example.com/mcp");
    expect(authServerMetadataUrls("https://auth.example.com/tenant1")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
  });

  it("tells a revoked grant from a hiccup", () => {
    expect(isGrantRevoked(new OAuthError("x", 400, "invalid_grant"))).toBe(true);
    expect(isGrantRevoked(new OAuthError("x", 503))).toBe(false);
    expect(isGrantRevoked(new OAuthError("unreachable"))).toBe(false);
  });

  it("normalizes server names and derives secret names", () => {
    expect(normalizeServerName("Banner Studio")).toBe("banner-studio");
    expect(normalizeServerName("plugin:stripe:stripe")).toBe("stripe");
    expect(normalizeServerName("!!!")).toBeNull();
    expect(secretNames("banner-studio")).toMatchObject({
      accessToken: "MCP_BANNER_STUDIO_ACCESS_TOKEN",
      refreshToken: "MCP_BANNER_STUDIO_REFRESH_TOKEN",
      bearer: "MCP_BANNER_STUDIO_TOKEN",
    });
  });
});

describe("the OAuth flow", () => {
  it("discovers, registers, uses PKCE and keeps tokens only in the secret store", async () => {
    const fake = await fakeOAuthMcp();
    const { service, store, config, notes } = setup();
    await config.put({ name: "demo", url: fake.url, auth: "oauth", state: "needs-auth", updatedAt: 0 });
    const link = await service.createStartLink("demo", "local:owner");
    expect(link.local).toMatch(/^http:\/\/localhost:3456\/mcp-auth\/start\/[\w-]{40,}$/);
    const token = link.local.split("/").pop()!;

    const begun = await service.beginFlow(token, "local");
    expect(begun.ok).toBe(true);
    const authorize = new URL((begun as { url: string }).url);
    expect(authorize.origin + authorize.pathname).toBe(`${fake.state.base}/authorize`);
    expect(authorize.searchParams.get("client_id")).toBe("client-1");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:3456/mcp-auth/callback");
    expect(authorize.searchParams.get("resource")).toBe(fake.url);
    expect(authorize.searchParams.get("scope")).toBe("mcp:tools");
    expect(fake.state.registeredRedirects).toEqual(["http://localhost:3456/mcp-auth/callback"]);

    // The link is single use.
    expect(await service.beginFlow(token, "local")).toMatchObject({ ok: false });

    const done = await service.completeFlow(fake.approve(authorize.toString()));
    expect(done).toMatchObject({ ok: true, name: "demo" });
    expect(await store.get("MCP_DEMO_ACCESS_TOKEN")).toBe(tok("access1"));
    expect(await store.get("MCP_DEMO_REFRESH_TOKEN")).toBe(tok("refresh1"));

    // Neither the config file nor the owner's text holds a token.
    const file = await readFile(config.file, "utf8");
    expect(file).not.toContain("fake-");
    expect(file).toContain('"state": "connected"');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ conversationId: "local:owner" });
    expect(notes[0].text).toContain("demo is connected");
    expect(notes[0].text).not.toContain("fake-");

    // A replayed callback is refused.
    expect(await service.completeFlow({ state: authorize.searchParams.get("state"), code: "code-1" })).toMatchObject({ ok: false });
  });

  it("refuses an unknown state and reports a denied sign-in", async () => {
    const fake = await fakeOAuthMcp();
    const { service, config } = setup();
    expect(await service.completeFlow({ state: "nope", code: "x" })).toMatchObject({ ok: false });
    await config.put({ name: "demo", url: fake.url, auth: "oauth", state: "needs-auth", updatedAt: 0 });
    const token = (await service.createStartLink("demo")).local.split("/").pop()!;
    const begun = (await service.beginFlow(token, "local")) as { url: string };
    const st = new URL(begun.url).searchParams.get("state");
    const denied = await service.completeFlow({ state: st, error: "access_denied" });
    expect(denied.ok).toBe(false);
    expect(denied.message).toContain("cancelled or denied");
  });

  it("explains how to proceed when the server has no dynamic registration", async () => {
    const fake = await fakeOAuthMcp({ registration: false });
    const { service, config } = setup();
    await config.put({ name: "demo", url: fake.url, auth: "oauth", state: "needs-auth", updatedAt: 0 });
    const token = (await service.createStartLink("demo")).local.split("/").pop()!;
    const begun = await service.beginFlow(token, "local");
    expect(begun.ok).toBe(false);
    expect((begun as { message: string }).message).toContain("MCP_DEMO_CLIENT_ID");
  });

  it("refreshes an expiring token automatically, with rotation", async () => {
    let now = 1_000_000;
    const fake = await fakeOAuthMcp();
    const { service, store } = setup({ now: () => now });
    await connect(service, fake);
    expect(await service.accessToken("demo")).toEqual({ ok: true, token: tok("access1") });
    now += 3600 * 1000;
    expect(await service.accessToken("demo")).toEqual({ ok: true, token: tok("access2") });
    expect(await store.get("MCP_DEMO_REFRESH_TOKEN")).toBe(tok("refresh2"));
    const refresh = fake.state.tokenRequests.at(-1)!;
    expect(refresh).toMatchObject({ grant_type: "refresh_token", client_id: "client-1", resource: fake.url });
  });

  it("marks a revoked grant 'needs re-auth' and texts a fresh link once", async () => {
    let now = 1_000_000;
    const fake = await fakeOAuthMcp();
    const { service, notes } = setup({ now: () => now });
    await connect(service, fake);
    fake.state.revoked = true;
    now += 3600 * 1000;
    expect(await service.accessToken("demo")).toMatchObject({ ok: false });
    expect((await service.config.get("demo"))?.state).toBe("needs-reauth");
    expect(await service.isUsable("demo")).toBe(false);
    const reauth = notes.filter((n) => n.text.includes("needs re-authentication"));
    expect(reauth).toHaveLength(1);
    expect(reauth[0].text).toMatch(/http:\/\/localhost:3456\/mcp-auth\/start\/[\w-]{40,}/);
    expect(reauth[0].text).not.toContain("fake-");
    // Asking again doesn't text again.
    expect(await service.accessToken("demo")).toMatchObject({ ok: false });
    expect(notes.filter((n) => n.text.includes("needs re-authentication"))).toHaveLength(1);
    expect(await service.describe((await service.config.get("demo"))!)).toContain("needs re-auth");

    // Signing in again clears it.
    fake.state.revoked = false;
    await connect(service, fake);
    expect((await service.config.get("demo"))?.state).toBe("connected");
  });
});

describe("the MCP proxy", () => {
  async function proxy(service: McpAuthService) {
    const app = express();
    app.use("/mcp-proxy", createMcpProxyRouter(service, { key: "proxy-key" }));
    return listen(app);
  }

  const rpc = (base: string, headers: Record<string, string>) =>
    fetch(`${base}/mcp-proxy/demo`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });

  it("adds the token inside Boop and passes the response through", async () => {
    const fake = await fakeOAuthMcp();
    const { service } = setup();
    await connect(service, fake);
    const base = await proxy(service);
    const res = await rpc(base, { [MCP_PROXY_KEY_HEADER]: "proxy-key" });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("session-1");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { echoed: "tools/list" } });
    expect(fake.state.mcpAuthHeaders.at(-1)).toBe(`Bearer ${tok("access1")}`);
  });

  it("is closed without the proxy key", async () => {
    const fake = await fakeOAuthMcp();
    const { service } = setup();
    await connect(service, fake);
    const base = await proxy(service);
    expect((await rpc(base, {})).status).toBe(404);
    expect((await rpc(base, { [MCP_PROXY_KEY_HEADER]: "wrong" })).status).toBe(404);
  });

  it("refreshes and retries once on a 401, then reports needs re-auth when revoked", async () => {
    const fake = await fakeOAuthMcp();
    const { service } = setup();
    await connect(service, fake);
    const base = await proxy(service);
    // The server dropped the access token early (refresh still valid).
    fake.state.validAccess.clear();
    const ok = await rpc(base, { [MCP_PROXY_KEY_HEADER]: "proxy-key" });
    expect(ok.status).toBe(200);
    expect(fake.state.mcpAuthHeaders.at(-1)).toBe(`Bearer ${tok("access2")}`);

    fake.state.validAccess.clear();
    fake.state.revoked = true;
    const res = await rpc(base, { [MCP_PROXY_KEY_HEADER]: "proxy-key" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { id: number; error: { message: string } };
    expect(body.id).toBe(7);
    expect(body.error.message).toContain("needs re-authentication");
    expect(JSON.stringify(body)).not.toContain("fake-");
  });

  it("sends a static bearer token from the secret store", async () => {
    const fake = await fakeOAuthMcp();
    const { service, store } = setup();
    fake.state.validAccess.add(tok("static"));
    await service.config.put({ name: "demo", url: fake.url, auth: "bearer", secretName: "DEMO_TOKEN", state: "needs-auth", updatedAt: 0 });
    expect(await service.isUsable("demo")).toBe(false);
    await store.set("DEMO_TOKEN", tok("static"));
    expect(await service.isUsable("demo")).toBe(true);
    const base = await proxy(service);
    expect((await rpc(base, { [MCP_PROXY_KEY_HEADER]: "proxy-key" })).status).toBe(200);
    expect(fake.state.mcpAuthHeaders.at(-1)).toBe(`Bearer ${tok("static")}`);
    // A rejected static token flags the server.
    fake.state.validAccess.clear();
    expect((await rpc(base, { [MCP_PROXY_KEY_HEADER]: "proxy-key" })).status).toBe(503);
    expect((await service.config.get("demo"))?.state).toBe("needs-reauth");
  });
});

describe("the sign-in pages", () => {
  it("redirects a local start link to the server's sign-in, once", async () => {
    const fake = await fakeOAuthMcp();
    const { service, config } = setup();
    await config.put({ name: "demo", url: fake.url, auth: "oauth", state: "needs-auth", updatedAt: 0 });
    const app = express();
    app.use("/mcp-auth", createMcpAuthRouter(service, { isLocal: () => true }));
    const base = await listen(app);
    const token = (await service.createStartLink("demo")).local.split("/").pop()!;
    const first = await fetch(`${base}/mcp-auth/start/${token}`, { redirect: "manual" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toContain(`${fake.state.base}/authorize?`);
    const second = await fetch(`${base}/mcp-auth/start/${token}`, { redirect: "manual" });
    expect(second.status).toBe(400);
    expect(await second.text()).toContain("already used");

    const callback = await fetch(`${base}/mcp-auth/callback?${new URLSearchParams(fake.approve(first.headers.get("location")!))}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("demo is connected");
    const bogus = await fetch(`${base}/mcp-auth/callback?state=bogus&code=x`);
    expect(bogus.status).toBe(400);
  });

  it("asks for the secrets passcode on the public host before starting", async () => {
    const fake = await fakeOAuthMcp();
    const host = "secret.example.com";
    const { service, store, config } = setup({ env: { SECRETS_PUBLIC_BASE_URL: `https://${host}` } });
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    await config.put({ name: "demo", url: fake.url, auth: "oauth", state: "needs-auth", updatedAt: 0 });
    const cfg = secretsPublicConfigFromEnv({ SECRETS_PUBLIC_BASE_URL: `https://${host}` });
    if (!cfg.ok) throw new Error("bad config");
    const app = createSecretsPublicApp({
      config: cfg.config,
      store: () => store,
      requests: new SecretRequestRegistry(),
      platform: "darwin",
      mcpAuth: service,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    closers.push(() => new Promise((r) => server.close(r)));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, p: string, headers: Record<string, string> = {}, form?: Record<string, string>) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
        const body = form ? new URLSearchParams(form).toString() : undefined;
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method,
            path: p,
            headers: {
              host,
              "x-forwarded-proto": "https",
              ...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) } : {}),
              ...headers,
            },
          },
          (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
          },
        );
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
      });
    const cookieOf = (h: string | string[] | undefined) => String(Array.isArray(h) ? h[0] : h).split(";")[0];

    const link = await service.createStartLink("demo");
    expect(link.remote).toMatch(new RegExp(`^https://${host}/mcp-auth/start/`));
    const token = link.local.split("/").pop()!;
    const login = await call("GET", `/mcp-auth/start/${token}`);
    expect(login.status).toBe(200);
    expect(login.body).toContain('name="passcode"');
    expect(login.body).toContain(`action="/mcp-auth/start/${token}/login"`);
    const csrf = login.body.match(/name="csrf" value="([^"]+)"/)![1];

    const wrong = await call("POST", `/mcp-auth/start/${token}/login`, { cookie: cookieOf(login.headers["set-cookie"]), origin: `https://${host}` }, { csrf, passcode: "nope-nope-nope" });
    expect(wrong.status).toBe(401);

    const posted = await call("POST", `/mcp-auth/start/${token}/login`, { cookie: cookieOf(login.headers["set-cookie"]), origin: `https://${host}` }, { csrf, passcode: PASSCODE });
    expect(posted.status).toBe(303);
    const started = await call("GET", `/mcp-auth/start/${token}`, { cookie: cookieOf(posted.headers["set-cookie"]) });
    expect(started.status).toBe(303);
    const location = String(started.headers.location);
    expect(new URL(location).searchParams.get("redirect_uri")).toBe(`https://${host}/mcp-auth/callback`);

    const callback = await call("GET", `/mcp-auth/callback?${new URLSearchParams(fake.approve(location))}`);
    expect(callback.status).toBe(200);
    expect(callback.body).toContain("demo is connected");
  });
});

describe("chat tools", () => {
  it("are owner-only", async () => {
    const { service } = setup();
    const tools = createMcpAuthDispatcherTools("sms:+15550000001", { service: () => service, ownerNumbers: () => "+15550000002" });
    for (const name of ["list_mcp_servers", "start_mcp_auth"]) {
      const res = await tool(tools, name).handle({ name: "demo", url: "https://api.example.com/mcp" });
      expect(res.success).toBe(false);
      expect(res.text).toContain("Only Boop's owner");
    }
  });

  it("starts OAuth with a link and lists the status", async () => {
    const fake = await fakeOAuthMcp();
    const { service, store, env } = setup();
    const added: string[] = [];
    const tools = createMcpAuthDispatcherTools("local:owner", {
      service: () => service,
      store: () => store,
      env,
      onServerAdded: (e) => added.push(e.name),
    });
    const started = await tool(tools, "start_mcp_auth").handle({ name: "Demo", url: fake.url });
    expect(started.success).not.toBe(false);
    expect(started.text).toMatch(/http:\/\/localhost:3456\/mcp-auth\/start\/[\w-]{40,}/);
    expect(added).toEqual(["demo"]);

    noteMcpServerStatuses([
      { name: "plugin:stripe:stripe", status: "needs-auth", source: "plugin" },
      { name: "boop-secrets", status: "connected", source: "sdk" },
      { name: "demo", status: "connected", source: "dynamic" },
    ]);
    const listed = (await tool(tools, "list_mcp_servers").handle({})).text;
    expect(listed).toContain("demo");
    expect(listed).toContain("needs auth (not signed in yet)");
    expect(listed).toContain("plugin:stripe:stripe");
    expect(listed).toContain('start_mcp_auth "stripe"');
    expect(listed).not.toContain("boop-secrets");
  });

  it("routes static bearer tokens through request_secret", async () => {
    const { service, store, env } = setup();
    const requests = new SecretRequestRegistry();
    const tools = createMcpAuthDispatcherTools("local:owner", { service: () => service, store: () => store, requests, env });
    const res = await tool(tools, "start_mcp_auth").handle({ name: "snailmark", url: "https://api.example.com/mcp", auth: "bearer" });
    expect(res.text).toContain("MCP_SNAILMARK_TOKEN");
    expect(res.text).toMatch(/http:\/\/localhost:3456\/secrets\/enter\/[\w-]{40,}/);
    expect(requests.pending().map((p) => p.name)).toEqual(["MCP_SNAILMARK_TOKEN"]);
    const entry = await service.config.get("snailmark");
    expect(entry).toMatchObject({ auth: "bearer", secretName: "MCP_SNAILMARK_TOKEN" });
    expect(await service.describe(entry!)).toContain("not entered yet");
    await store.set("MCP_SNAILMARK_TOKEN", tok("snail"));
    expect(await service.describe(entry!)).toContain("connected");
  });

  it("finds a server's URL in the Claude config and asks when it can't", async () => {
    const home = path.join(dir, "home");
    await mkdir(path.join(home, ".claude", "plugins", "cache", "stripe"), { recursive: true });
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { bannerstudio: { type: "http", url: "https://banner.example.com/mcp", headers: { x: "y" } } } }),
    );
    await writeFile(
      path.join(home, ".claude", "plugins", "cache", "stripe", ".mcp.json"),
      JSON.stringify({ mcpServers: { stripe: { type: "http", url: "https://mcp.example.com" } } }),
    );
    expect(await findConfiguredMcpServerUrl("bannerstudio", { home, cwd: dir })).toMatchObject({ url: "https://banner.example.com/mcp" });
    expect(await findConfiguredMcpServerUrl("plugin:stripe:stripe", { home, cwd: dir })).toMatchObject({ url: "https://mcp.example.com" });
    expect(await findConfiguredMcpServerUrl("nothing", { home, cwd: dir })).toEqual({ url: null, candidates: [] });

    const { service } = setup();
    const tools = createMcpAuthDispatcherTools("local:owner", {
      service: () => service,
      findUrl: (name) => findConfiguredMcpServerUrl(name, { home, cwd: dir }),
    });
    const res = await tool(tools, "start_mcp_auth").handle({ name: "nothing" });
    expect(res.success).toBe(false);
    expect(res.text).toContain("Ask the user");
  });
});
