import { createHash, timingSafeEqual } from "node:crypto";
import { redactSecrets } from "../secrets/redact.js";
import { remoteEntryRuntime, type RemoteEntryRuntime } from "../secrets/remote-config.js";
import { SecretRequestRegistry, SECRET_REQUEST_TTL_MS } from "../secrets/requests.js";
import { secretStore, secretsSupported, type SecretStore } from "../secrets/store.js";
import { resolveRemoteEntryLink } from "../secrets/tools.js";
import { resolveSecretsRemoteConfig } from "../secrets/remote-config.js";
import { accessConfigFromEnv } from "../cloudflare-access.js";
import { McpServerConfigStore, secretNames, type McpOAuthClientInfo, type McpServerEntry } from "./config.js";
import {
  OAuthError,
  buildAuthorizationUrl,
  canonicalResource,
  createPkce,
  discoverAuthServer,
  discoverProtectedResource,
  isGrantRevoked,
  randomState,
  registerClient,
  requestTokens,
  supportsS256,
  type FetchLike,
  type OAuthClient,
  type TokenSet,
} from "./oauth.js";

/**
 * Boop's side of MCP server authentication, on the Mac.
 *
 *   start link  → the owner opens /mcp-auth/start/<token> (Mac, secrets host
 *                 behind its passcode, or the Access-protected PUBLIC_URL)
 *   beginFlow   → discovery, client registration, PKCE; redirects to the
 *                 server's sign-in page
 *   callback    → /mcp-auth/callback?code&state: exchanges the code and puts
 *                 the tokens in the secret store (Keychain)
 *   accessToken → what the loopback proxy adds to each request, refreshed
 *                 when it's about to expire
 *
 * Tokens only ever move between the authorization server, the Keychain and
 * the upstream MCP server. They are never returned to a tool, logged, or put
 * in the config file, and errors never quote them.
 */

/** Where a start link was opened, which decides the redirect URI. */
export type AuthOrigin = "local" | "access" | "secrets-host";

/** Refresh this long before the access token expires. */
export const REFRESH_SKEW_MS = 60_000;
export const PENDING_FLOW_TTL_MS = 10 * 60 * 1000;

export type TokenResult = { ok: true; token: string | null } | { ok: false; reason: string };

interface PendingFlow {
  name: string;
  verifier: string;
  redirectUri: string;
  resource: string;
  client: OAuthClient;
  tokenEndpoint: string;
  conversationId?: string;
  expiresAt: number;
}

export interface McpAuthServiceDeps {
  config?: McpServerConfigStore;
  store?: () => SecretStore;
  fetch?: FetchLike;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runtime?: RemoteEntryRuntime;
  links?: SecretRequestRegistry;
  /** Texts the owner (e.g. "needs re-auth" with a fresh link). */
  notify?: (conversationId: string, text: string) => Promise<void>;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeErrorMessage(err: unknown): string {
  const raw = err instanceof OAuthError ? err.message : "Something went wrong talking to the server.";
  return redactSecrets(raw).slice(0, 300);
}

export class McpAuthService {
  readonly config: McpServerConfigStore;
  readonly links: SecretRequestRegistry;
  private readonly store: () => SecretStore;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly runtime: RemoteEntryRuntime;
  private notifyFn?: (conversationId: string, text: string) => Promise<void>;
  private readonly pending = new Map<string, PendingFlow>();
  private readonly refreshing = new Map<string, Promise<TokenResult>>();

  constructor(deps: McpAuthServiceDeps = {}) {
    this.config = deps.config ?? new McpServerConfigStore();
    this.store = deps.store ?? secretStore;
    this.fetchImpl = deps.fetch ?? ((...args) => fetch(...args));
    this.now = deps.now ?? Date.now;
    this.env = deps.env ?? process.env;
    this.platform = deps.platform ?? process.platform;
    this.runtime = deps.runtime ?? remoteEntryRuntime;
    this.links = deps.links ?? new SecretRequestRegistry(this.now);
    this.notifyFn = deps.notify;
  }

  setNotifier(notify: (conversationId: string, text: string) => Promise<void>): void {
    this.notifyFn = notify;
  }

  get supported(): boolean {
    return secretsSupported(this.platform);
  }

  // --- redirect URIs ----------------------------------------------------------

  /** The callback URL for each place a start link can be opened, when that place exists. */
  redirectUris(): Record<AuthOrigin, string | null> {
    const port = Number(this.env.PORT ?? 3456);
    const remote = resolveSecretsRemoteConfig(this.env);
    const publicUrl = this.env.PUBLIC_URL?.trim();
    const access =
      publicUrl && !/localhost|127\.0\.0\.1/.test(publicUrl) && accessConfigFromEnv(this.env)
        ? `${publicUrl.replace(/\/+$/, "")}/mcp-auth/callback`
        : null;
    return {
      local: `http://localhost:${port}/mcp-auth/callback`,
      "secrets-host": remote.ok ? `${remote.config.baseUrl}/mcp-auth/callback` : null,
      access,
    };
  }

  // --- links ------------------------------------------------------------------

  /** A one-time start link for `name`; returns the lines to send the owner. */
  async createStartLink(name: string, conversationId?: string): Promise<{ local: string; remote: string | null; lines: string[] }> {
    const { token } = this.links.create({ name, description: `Authenticate ${name}`, ...(conversationId ? { conversationId } : {}) });
    const port = Number(this.env.PORT ?? 3456);
    const local = `http://localhost:${port}/mcp-auth/start/${token}`;
    const { remote, remoteLine } = await resolveRemoteEntryLink(`/mcp-auth/start/${token}`, {
      env: this.env,
      store: this.store,
      platform: this.platform,
      runtime: this.runtime,
    });
    const minutes = Math.round(SECRET_REQUEST_TTL_MS / 60_000);
    return {
      local,
      remote,
      lines: [
        `Sign-in link for ${name}:`,
        local,
        ...(remoteLine ? [remoteLine] : []),
        `It works once, for ${minutes} minutes. The local link only opens on the Mac itself.`,
      ],
    };
  }

  // --- the flow ---------------------------------------------------------------

  /**
   * Starts the OAuth flow for a live start link: discovery, a client
   * (registered dynamically where the server allows it), PKCE and state.
   * Returns the authorization URL to redirect the browser to. The link is
   * spent once this succeeds.
   */
  async beginFlow(token: string, origin: AuthOrigin): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
    const found = this.links.peek(token);
    if (!found.ok) {
      return {
        ok: false,
        message: found.reason === "expired" ? "This link has expired. Ask Boop for a new one." : found.reason === "used" ? "This link was already used. Ask Boop for a new one." : "This link isn't valid. Ask Boop for a new one.",
      };
    }
    const { name, conversationId } = found.request;
    const entry = await this.config.get(name);
    if (!entry) return { ok: false, message: `Boop doesn't know a server called ${name} any more. Ask Boop again.` };
    const redirectUri = this.redirectUris()[origin];
    if (!redirectUri) return { ok: false, message: "This way of opening the link isn't set up. Use the link on the Mac." };

    try {
      const discovery = await discoverProtectedResource(entry.url, this.fetchImpl);
      if (!discovery.authRequired) {
        this.links.consume(token);
        await this.config.update(name, (e) => ({ ...e, auth: "none", state: "connected", lastError: undefined, updatedAt: this.now() }));
        return { ok: false, message: `${name} answered without asking for sign-in, so there's nothing to authenticate. Boop can use it now.` };
      }
      const issuer = discovery.metadata?.authorization_servers?.[0] ?? new URL(entry.url).origin;
      const { metadata } = await discoverAuthServer(issuer, this.fetchImpl);
      if (!supportsS256(metadata)) {
        return { ok: false, message: `${name}'s sign-in server doesn't support PKCE (S256), which MCP requires. Boop can't authenticate it safely.` };
      }
      const resource = discovery.metadata?.resource ?? canonicalResource(entry.url);
      const scope = discovery.scope ?? discovery.metadata?.scopes_supported?.join(" ") ?? undefined;
      const client = await this.clientFor(entry, { issuer, metadata, redirectUri, resource, scope });
      const { verifier, challenge } = createPkce();
      const state = randomState();
      const url = buildAuthorizationUrl({
        authorizationEndpoint: metadata.authorization_endpoint,
        clientId: client.clientId,
        redirectUri,
        codeChallenge: challenge,
        state,
        resource,
        ...(scope ? { scope } : {}),
      });
      // Spend the link only now, so a discovery hiccup doesn't burn it.
      if (!this.links.consume(token).ok) return { ok: false, message: "This link was already used. Ask Boop for a new one." };
      this.sweep();
      this.pending.set(hash(state), {
        name,
        verifier,
        redirectUri,
        resource,
        client,
        tokenEndpoint: metadata.token_endpoint,
        ...(conversationId ? { conversationId } : {}),
        expiresAt: this.now() + PENDING_FLOW_TTL_MS,
      });
      return { ok: true, url };
    } catch (err) {
      return { ok: false, message: `Couldn't start sign-in for ${name}: ${safeErrorMessage(err)}` };
    }
  }

  /** Reuses the registered client when it fits, otherwise registers (or uses an owner-supplied client id). */
  private async clientFor(
    entry: McpServerEntry,
    ctx: { issuer: string; metadata: Awaited<ReturnType<typeof discoverAuthServer>>["metadata"]; redirectUri: string; resource: string; scope?: string },
  ): Promise<OAuthClient> {
    const names = secretNames(entry.name);
    const existing = entry.oauth;
    const sameServer =
      existing && existing.issuer === ctx.issuer && existing.tokenEndpoint === ctx.metadata.token_endpoint && existing.redirectUris.includes(ctx.redirectUri);
    let info: McpOAuthClientInfo;
    let client: OAuthClient;
    if (sameServer && existing) {
      const secret = existing.clientSecretStored ? await this.store().get(names.clientSecret) : null;
      client = { clientId: existing.clientId, authMethod: existing.tokenEndpointAuthMethod, ...(secret ? { clientSecret: secret } : {}) };
      info = { ...existing, resource: ctx.resource, ...(ctx.scope ? { scope: ctx.scope } : {}) };
    } else {
      const ownClientId = await this.store().get(names.clientId);
      if (ownClientId) {
        // A client the owner registered by hand with the provider.
        const secret = await this.store().get(names.clientSecret);
        client = { clientId: ownClientId, authMethod: secret ? "client_secret_post" : "none", ...(secret ? { clientSecret: secret } : {}) };
        info = this.clientInfo(ctx, client, [ctx.redirectUri], false, Boolean(secret));
      } else if (ctx.metadata.registration_endpoint) {
        // Only the redirect URI in use: some servers refuse a mix of http://localhost
        // and https. Opening a link from elsewhere later registers again.
        const uris = [ctx.redirectUri];
        client = await registerClient(
          ctx.metadata.registration_endpoint,
          { redirectUris: uris, clientName: "Boop", ...(ctx.scope ? { scope: ctx.scope } : {}), authMethods: ctx.metadata.token_endpoint_auth_methods_supported },
          this.fetchImpl,
        );
        if (client.clientSecret) await this.store().set(names.clientSecret, client.clientSecret);
        info = this.clientInfo(ctx, client, uris, true, Boolean(client.clientSecret));
      } else {
        throw new OAuthError(
          `the server doesn't support automatic client registration. Register an OAuth app with it (redirect URI ${ctx.redirectUri}) and have Boop request ${names.clientId} (and ${names.clientSecret} if it has one) with request_secret, then try again`,
        );
      }
    }
    await this.config.update(entry.name, (e) => ({ ...e, auth: "oauth", oauth: info, updatedAt: this.now() }));
    return client;
  }

  private clientInfo(
    ctx: { issuer: string; metadata: { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string }; resource: string; scope?: string },
    client: OAuthClient,
    redirectUris: string[],
    dynamic: boolean,
    clientSecretStored: boolean,
  ): McpOAuthClientInfo {
    return {
      issuer: ctx.issuer,
      authorizationEndpoint: ctx.metadata.authorization_endpoint,
      tokenEndpoint: ctx.metadata.token_endpoint,
      ...(ctx.metadata.registration_endpoint ? { registrationEndpoint: ctx.metadata.registration_endpoint } : {}),
      clientId: client.clientId,
      clientSecretStored,
      tokenEndpointAuthMethod: client.authMethod,
      redirectUris,
      dynamic,
      resource: ctx.resource,
      ...(ctx.scope ? { scope: ctx.scope } : {}),
    };
  }

  private takePending(state: string): PendingFlow | null {
    const wanted = Buffer.from(hash(state), "hex");
    let key: string | undefined;
    for (const candidate of this.pending.keys()) {
      if (timingSafeEqual(Buffer.from(candidate, "hex"), wanted) && key === undefined) key = candidate;
    }
    if (!key) return null;
    const flow = this.pending.get(key)!;
    this.pending.delete(key);
    return flow.expiresAt > this.now() ? flow : null;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, f] of this.pending) if (f.expiresAt <= now) this.pending.delete(k);
    if (this.pending.size > 50) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.pending.delete(oldest[0]);
    }
  }

  /** Handles the redirect back from the authorization server. */
  async completeFlow(query: Record<string, unknown>): Promise<{ ok: boolean; name?: string; message: string }> {
    const state = typeof query.state === "string" ? query.state : "";
    const flow = state ? this.takePending(state) : null;
    if (!flow) return { ok: false, message: "This sign-in isn't valid any more (it expired or was already used). Ask Boop for a new link." };
    if (typeof query.error === "string") {
      const reason = query.error === "access_denied" ? "sign-in was cancelled or denied" : `the server said ${query.error.replace(/[^\w.-]/g, "").slice(0, 60)}`;
      return { ok: false, name: flow.name, message: `${flow.name} wasn't connected: ${reason}. Ask Boop for a new link to try again.` };
    }
    const code = typeof query.code === "string" ? query.code : "";
    if (!code) return { ok: false, name: flow.name, message: "The server didn't send a code back. Ask Boop for a new link." };
    try {
      const tokens = await requestTokens(
        flow.tokenEndpoint,
        { grant_type: "authorization_code", code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, resource: flow.resource },
        flow.client,
        this.fetchImpl,
        this.now,
      );
      await this.saveTokens(flow.name, tokens, { replaceRefresh: true });
      await this.config.update(flow.name, (e) => ({
        ...e,
        ...(flow.conversationId ? { conversationId: flow.conversationId } : {}),
      }));
      if (flow.conversationId) {
        await this.notify(flow.conversationId, `🔌 ${flow.name} is connected. Its tools are available to my sub-agents from the next task.`);
      }
      return { ok: true, name: flow.name, message: `${flow.name} is connected. You can close this tab and go back to Boop.` };
    } catch (err) {
      return { ok: false, name: flow.name, message: `${flow.name} wasn't connected: ${safeErrorMessage(err)} Ask Boop for a new link.` };
    }
  }

  private async saveTokens(name: string, tokens: TokenSet, opts: { replaceRefresh: boolean }): Promise<void> {
    const names = secretNames(name);
    const store = this.store();
    await store.set(names.accessToken, tokens.accessToken);
    if (tokens.refreshToken) await store.set(names.refreshToken, tokens.refreshToken);
    else if (opts.replaceRefresh) await store.delete(names.refreshToken).catch(() => false);
    await this.config.update(name, (e) => {
      const next: McpServerEntry = { ...e, auth: "oauth", state: "connected", updatedAt: this.now() };
      delete next.lastError;
      if (tokens.expiresAt) next.expiresAt = tokens.expiresAt;
      else delete next.expiresAt;
      return next;
    });
  }

  // --- tokens for the proxy ---------------------------------------------------

  /** The Authorization token to send upstream (null for servers without auth), refreshing if due. */
  async accessToken(name: string): Promise<TokenResult> {
    if (!this.supported) return { ok: false, reason: "MCP credentials only live on the owner's Mac." };
    const entry = await this.config.get(name);
    if (!entry) return { ok: false, reason: `No MCP server called ${name}.` };
    if (entry.auth === "none") return { ok: true, token: null };
    if (entry.state === "needs-reauth") return { ok: false, reason: `${name} needs re-authentication.` };
    if (entry.auth === "bearer") {
      const token = await this.store().get(entry.secretName ?? secretNames(name).bearer).catch(() => null);
      return token ? { ok: true, token } : { ok: false, reason: `${name}'s token isn't stored yet.` };
    }
    const access = await this.store().get(secretNames(name).accessToken).catch(() => null);
    if (!access) return { ok: false, reason: `${name} isn't authenticated yet.` };
    if (entry.expiresAt && entry.expiresAt - REFRESH_SKEW_MS <= this.now()) return this.refresh(name);
    return { ok: true, token: access };
  }

  /** Refreshes the access token, once at a time per server. */
  refresh(name: string): Promise<TokenResult> {
    const inFlight = this.refreshing.get(name);
    if (inFlight) return inFlight;
    const run = this.refreshUnlocked(name).finally(() => this.refreshing.delete(name));
    this.refreshing.set(name, run);
    return run;
  }

  private async refreshUnlocked(name: string): Promise<TokenResult> {
    const entry = await this.config.get(name);
    if (!entry?.oauth) return { ok: false, reason: `${name} isn't set up for OAuth.` };
    const names = secretNames(name);
    const refreshToken = await this.store().get(names.refreshToken).catch(() => null);
    if (!refreshToken) {
      await this.markNeedsReauth(name, "the access token expired and the server gave no refresh token");
      return { ok: false, reason: `${name} needs re-authentication.` };
    }
    const secret = entry.oauth.clientSecretStored ? await this.store().get(names.clientSecret).catch(() => null) : null;
    try {
      const tokens = await requestTokens(
        entry.oauth.tokenEndpoint,
        { grant_type: "refresh_token", refresh_token: refreshToken, resource: entry.oauth.resource },
        { clientId: entry.oauth.clientId, authMethod: entry.oauth.tokenEndpointAuthMethod, ...(secret ? { clientSecret: secret } : {}) },
        this.fetchImpl,
        this.now,
      );
      await this.saveTokens(name, tokens, { replaceRefresh: false });
      return { ok: true, token: tokens.accessToken };
    } catch (err) {
      if (isGrantRevoked(err)) {
        await this.markNeedsReauth(name, "the sign-in expired or was revoked");
        return { ok: false, reason: `${name} needs re-authentication.` };
      }
      // A network blip or a 5xx: keep the tokens and try again next time.
      return { ok: false, reason: `Couldn't refresh ${name}'s token right now: ${safeErrorMessage(err)}` };
    }
  }

  /**
   * The upstream server answered 401. OAuth servers get one refresh attempt;
   * otherwise (or if that fails) the server is marked "needs re-auth".
   */
  async handleUnauthorized(name: string): Promise<TokenResult> {
    const entry = await this.config.get(name);
    if (!entry) return { ok: false, reason: `No MCP server called ${name}.` };
    if (entry.auth === "oauth" && entry.state !== "needs-reauth") return this.refresh(name);
    if (entry.auth === "bearer") await this.markNeedsReauth(name, "the server rejected the stored token");
    return { ok: false, reason: `${name} needs re-authentication.` };
  }

  /** Flags a server and, the first time, texts the owner a fresh link. */
  async markNeedsReauth(name: string, reason: string): Promise<void> {
    let changed = false;
    const entry = await this.config.update(name, (e) => {
      changed = e.state !== "needs-reauth";
      return { ...e, state: "needs-reauth", lastError: reason, updatedAt: this.now() };
    });
    if (!entry || !changed || !entry.conversationId) return;
    let text: string;
    if (entry.auth === "bearer") {
      text = `⚠️ ${name}'s token stopped working (${reason}). Ask me to "authenticate ${name}" and I'll send a link to enter a new one.`;
    } else {
      const link = await this.createStartLink(name, entry.conversationId).catch(() => null);
      text = link
        ? `⚠️ ${name} needs re-authentication (${reason}). Sign in again here:\n${link.lines.slice(1).join("\n")}`
        : `⚠️ ${name} needs re-authentication (${reason}). Ask me to "authenticate ${name}" for a new link.`;
    }
    await this.notify(entry.conversationId, text);
  }

  private async notify(conversationId: string, text: string): Promise<void> {
    try {
      await this.notifyFn?.(conversationId, text);
    } catch {
      // Best effort; never let a texting failure break auth.
    }
  }

  /** Usable by sub-agents right now (credentials present, not flagged). */
  async isUsable(name: string): Promise<boolean> {
    if (!this.supported) return false;
    const entry = await this.config.get(name);
    if (!entry || entry.state === "needs-reauth") return false;
    if (entry.auth === "none") return true;
    const secret = entry.auth === "bearer" ? entry.secretName ?? secretNames(name).bearer : secretNames(name).accessToken;
    return this.store().has(secret).catch(() => false);
  }

  /** For list_mcp_servers: each server's status in words. Never touches values beyond "is it stored". */
  async describe(entry: McpServerEntry): Promise<string> {
    if (entry.state === "needs-reauth") return `needs re-auth (${entry.lastError ?? "sign-in no longer valid"})`;
    if (entry.auth === "none") return "connected (no sign-in needed)";
    const store = this.store();
    if (entry.auth === "bearer") {
      const secret = entry.secretName ?? secretNames(entry.name).bearer;
      return (await store.has(secret).catch(() => false)) ? `connected (static token ${secret})` : `needs auth (token ${secret} not entered yet)`;
    }
    const names = secretNames(entry.name);
    if (!(await store.has(names.accessToken).catch(() => false))) return "needs auth (not signed in yet)";
    const hasRefresh = await store.has(names.refreshToken).catch(() => false);
    if (entry.expiresAt && entry.expiresAt <= this.now()) {
      return hasRefresh ? "connected (access token expired; refreshes automatically on next use)" : "needs re-auth (token expired, no refresh token)";
    }
    const until = entry.expiresAt ? `, token valid until ${new Date(entry.expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z")}` : "";
    return `connected (OAuth${hasRefresh ? ", auto-refresh" : ""}${until})`;
  }
}

let defaultService: McpAuthService | null = null;

export function mcpAuthService(): McpAuthService {
  defaultService ??= new McpAuthService();
  return defaultService;
}

/** Test hook. */
export function setMcpAuthServiceForTests(service: McpAuthService | null): void {
  defaultService = service;
}
