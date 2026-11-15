import { createHash, randomBytes } from "node:crypto";

/**
 * The OAuth side of the MCP authorization spec, as a client: protected
 * resource discovery (RFC 9728), authorization server metadata (RFC 8414 /
 * OpenID discovery), dynamic client registration (RFC 7591), PKCE (S256) and
 * the token endpoint (authorization_code and refresh_token, with the RFC 8707
 * `resource` indicator).
 *
 * Pure functions over an injected fetch. Nothing here logs, and no error
 * message ever includes a token, code or verifier.
 */

export type FetchLike = typeof fetch;

const TIMEOUT_MS = 15_000;
const MAX_METADATA_BYTES = 256 * 1024;

export class OAuthError extends Error {
  constructor(
    message: string,
    /** HTTP status from the token/registration endpoint, when there was one. */
    readonly status?: number,
    /** The OAuth `error` code, e.g. invalid_grant. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms, when the server said how long the token lives. */
  expiresAt?: number;
  scope?: string;
}

export type TokenEndpointAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  authMethod: TokenEndpointAuthMethod;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** MCP and OAuth endpoints must be HTTPS; plain HTTP only to this machine. */
export function assertSecureUrl(raw: string, what = "URL"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthError(`The ${what} isn't a valid URL.`);
  }
  if (url.username || url.password) throw new OAuthError(`The ${what} must not contain credentials.`);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  throw new OAuthError(`The ${what} must use https (${url.protocol}// isn't allowed).`);
}

/** The canonical resource URI for an MCP server URL (RFC 8707): no fragment, no trailing slash. */
export function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.hash = "";
  const pathname = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${pathname}${u.search}`;
}

/** Parses `Bearer resource_metadata="…", scope="…", error="…"`. */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (let m = re.exec(header); m; m = re.exec(header)) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return out;
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_METADATA_BYTES) throw new OAuthError("The server's response was too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new OAuthError("The server's response wasn't JSON.", res.status);
  }
}

async function getJson(url: string, fetchImpl: FetchLike): Promise<Record<string, unknown> | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: timeoutSignal(), redirect: "follow" });
  } catch {
    return null;
  }
  if (!res.ok) {
    await discard(res);
    return null;
  }
  try {
    const body = await readJson(res);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface ResourceDiscovery {
  /** False when the MCP server answered an unauthenticated initialize. */
  authRequired: boolean;
  metadata: ProtectedResourceMetadata | null;
  /** Scope the server asked for in its 401, if any. */
  scope?: string;
  /** HTTP status of the unauthenticated probe (0 when unreachable). */
  probeStatus: number;
}

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "boop-auth-probe", version: "0.1.0" },
  },
});

/**
 * Asks the MCP server, without credentials, how to authenticate: an
 * initialize that should come back 401 with a resource_metadata pointer,
 * then the RFC 9728 well-known locations.
 */
export async function discoverProtectedResource(serverUrl: string, fetchImpl: FetchLike = fetch): Promise<ResourceDiscovery> {
  const url = assertSecureUrl(serverUrl, "MCP server URL");
  let probeStatus = 0;
  let challenge: Record<string, string> = {};
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: INITIALIZE_BODY,
      signal: timeoutSignal(),
    });
    probeStatus = res.status;
    challenge = parseWwwAuthenticate(res.headers.get("www-authenticate"));
    await discard(res);
  } catch {
    probeStatus = 0;
  }
  if (probeStatus >= 200 && probeStatus < 300) return { authRequired: false, metadata: null, probeStatus };

  const candidates: string[] = [];
  if (challenge.resource_metadata) {
    try {
      candidates.push(assertSecureUrl(new URL(challenge.resource_metadata, url).toString(), "resource metadata URL").toString());
    } catch {
      // Ignore a bad pointer and fall back to the well-known locations.
    }
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path) candidates.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  candidates.push(`${url.origin}/.well-known/oauth-protected-resource`);

  for (const candidate of candidates) {
    const body = await getJson(candidate, fetchImpl);
    if (!body) continue;
    const servers = Array.isArray(body.authorization_servers)
      ? body.authorization_servers.filter((s): s is string => typeof s === "string")
      : [];
    if (servers.length === 0) continue;
    return {
      authRequired: true,
      metadata: {
        resource: typeof body.resource === "string" ? body.resource : undefined,
        authorization_servers: servers,
        scopes_supported: Array.isArray(body.scopes_supported)
          ? body.scopes_supported.filter((s): s is string => typeof s === "string")
          : undefined,
      },
      ...(challenge.scope ? { scope: challenge.scope } : {}),
      probeStatus,
    };
  }
  return { authRequired: true, metadata: null, ...(challenge.scope ? { scope: challenge.scope } : {}), probeStatus };
}

/** RFC 8414 + OpenID discovery URLs for an issuer, in the order the MCP spec gives. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  if (!path) {
    return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * The authorization server's endpoints. Without published metadata, falls
 * back to the 2025-03-26 defaults (/authorize, /token, /register at the
 * issuer's origin), flagged as `legacy`.
 */
export async function discoverAuthServer(
  issuer: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ metadata: AuthServerMetadata; legacy: boolean }> {
  assertSecureUrl(issuer, "authorization server URL");
  for (const candidate of authServerMetadataUrls(issuer)) {
    const body = await getJson(candidate, fetchImpl);
    if (!body) continue;
    if (typeof body.authorization_endpoint !== "string" || typeof body.token_endpoint !== "string") continue;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : undefined);
    const metadata: AuthServerMetadata = {
      issuer: typeof body.issuer === "string" ? body.issuer : issuer,
      authorization_endpoint: assertSecureUrl(body.authorization_endpoint, "authorization endpoint").toString(),
      token_endpoint: assertSecureUrl(body.token_endpoint, "token endpoint").toString(),
      ...(typeof body.registration_endpoint === "string"
        ? { registration_endpoint: assertSecureUrl(body.registration_endpoint, "registration endpoint").toString() }
        : {}),
      code_challenge_methods_supported: strings(body.code_challenge_methods_supported),
      scopes_supported: strings(body.scopes_supported),
      token_endpoint_auth_methods_supported: strings(body.token_endpoint_auth_methods_supported),
    };
    return { metadata, legacy: false };
  }
  const origin = new URL(issuer).origin;
  return {
    metadata: {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
    },
    legacy: true,
  };
}

/** PKCE S256 must be on offer when the server lists its methods. */
export function supportsS256(metadata: AuthServerMetadata): boolean {
  const methods = metadata.code_challenge_methods_supported;
  return !methods || methods.length === 0 || methods.includes("S256");
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(32).toString("base64url");
}

/** RFC 7591 dynamic registration as a public client (PKCE, no secret) where the server allows it. */
export async function registerClient(
  registrationEndpoint: string,
  input: { redirectUris: string[]; clientName?: string; scope?: string; authMethods?: string[] },
  fetchImpl: FetchLike = fetch,
): Promise<OAuthClient> {
  assertSecureUrl(registrationEndpoint, "registration endpoint");
  const methods = input.authMethods;
  const authMethod: TokenEndpointAuthMethod =
    !methods || methods.length === 0 || methods.includes("none")
      ? "none"
      : methods.includes("client_secret_basic")
        ? "client_secret_basic"
        : "client_secret_post";
  let res: Response;
  try {
    res = await fetchImpl(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: input.clientName ?? "Boop",
        redirect_uris: input.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: authMethod,
        ...(input.scope ? { scope: input.scope } : {}),
      }),
      signal: timeoutSignal(),
    });
  } catch {
    throw new OAuthError("Couldn't reach the registration endpoint.");
  }
  const body = (await readJson(res).catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body.client_id !== "string") {
    throw new OAuthError(`Client registration was refused${describeError(body)}.`, res.status, typeof body?.error === "string" ? body.error : undefined);
  }
  const secret = typeof body.client_secret === "string" && body.client_secret ? body.client_secret : undefined;
  const returned = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : undefined;
  const effective: TokenEndpointAuthMethod =
    returned === "client_secret_basic" || returned === "client_secret_post" || returned === "none"
      ? returned
      : secret
        ? "client_secret_basic"
        : "none";
  return { clientId: body.client_id, ...(secret ? { clientSecret: secret } : {}), authMethod: secret ? effective : "none" };
}

export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope?: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("resource", input.resource);
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url.toString();
}

/** Only short, printable error codes/descriptions are quoted; nothing else from the body. */
function describeError(body: Record<string, unknown> | null): string {
  if (!body) return "";
  const code = typeof body.error === "string" ? body.error.slice(0, 60) : "";
  const desc = typeof body.error_description === "string" ? body.error_description.slice(0, 160) : "";
  const text = [code, desc].filter(Boolean).join(": ").replace(/[^\x20-\x7E]/g, "");
  return text ? ` (${text})` : "";
}

/** POSTs to the token endpoint and parses a token response. */
export async function requestTokens(
  tokenEndpoint: string,
  params: Record<string, string>,
  client: OAuthClient,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<TokenSet> {
  assertSecureUrl(tokenEndpoint, "token endpoint");
  const form = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.authMethod === "client_secret_basic" && client.clientSecret) {
    const enc = (v: string) => encodeURIComponent(v);
    headers.authorization = `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(client.clientSecret)}`).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.authMethod === "client_secret_post" && client.clientSecret) form.set("client_secret", client.clientSecret);
  }
  let res: Response;
  try {
    res = await fetchImpl(tokenEndpoint, { method: "POST", headers, body: form.toString(), signal: timeoutSignal() });
  } catch {
    throw new OAuthError("Couldn't reach the token endpoint.");
  }
  const body = (await readJson(res).catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body || typeof body.access_token !== "string" || !body.access_token) {
    throw new OAuthError(
      `The token endpoint refused the request${describeError(body)}.`,
      res.status,
      typeof body?.error === "string" ? body.error : undefined,
    );
  }
  const tokenType = typeof body.token_type === "string" ? body.token_type.toLowerCase() : "bearer";
  if (tokenType !== "bearer") throw new OAuthError(`Unsupported token type "${tokenType.slice(0, 20)}".`, res.status);
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now() + expiresIn * 1000 } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

/** True when a token-endpoint failure means the grant is gone (re-auth needed), not a hiccup. */
export function isGrantRevoked(err: unknown): boolean {
  if (!(err instanceof OAuthError) || err.status === undefined) return false;
  if (err.code && ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_token"].includes(err.code)) return true;
  return err.status === 400 || err.status === 401 || err.status === 403;
}
