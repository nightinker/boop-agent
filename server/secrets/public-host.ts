import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import express from "express";
import { secretRequests, type SecretRequestRegistry } from "./requests.js";
import {
  deadLinkMessage,
  escapeHtml,
  renderEntryForm,
  saveFromLink,
  send,
  type SecretsRouterDeps,
} from "./routes.js";
import { secretStore, secretsSupported, type SecretStore } from "./store.js";

/**
 * The public secrets host: a minimal app that serves ONLY the one-time entry
 * pages, so the owner can type a secret from their phone through a tunnel
 * (e.g. https://secret.example.com) without the dashboard or API being
 * reachable there. Everything else on that host is a 404.
 *
 * Turned on by SECRETS_PUBLIC_BASE_URL (https only). Requests reach it two
 * ways, both without touching the rest of Boop:
 *   - on Boop's main port, any request whose Host (or X-Forwarded-Host) is
 *     that base URL's host is handed to this app before the dashboard's
 *     access check, and never falls through to it;
 *   - optionally on its own port (SECRETS_PUBLIC_PORT, bound to 127.0.0.1),
 *     which serves nothing but this app.
 *
 * Before the form is shown the visitor logs in with a passcode kept in the
 * secret store (Keychain) as SECRETS_PORTAL_PASSCODE; it's set like any other
 * secret, never in chat. Logging in also needs a live entry link, so a
 * passcode guess is only possible while a link is open. Login attempts and
 * dead-link hits are rate limited, forms carry a CSRF token tied to a
 * Secure/HttpOnly/SameSite=Strict session cookie, every response is no-store,
 * and plain-HTTP requests are refused. Nothing here logs values or tokens.
 */

export const SECRETS_PORTAL_PASSCODE_NAME = "SECRETS_PORTAL_PASSCODE";
export const MIN_PORTAL_PASSCODE_LENGTH = 8;
export const PORTAL_SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_COOKIE = "__Host-boop_secrets";
const MAX_SESSIONS = 200;

export interface SecretsPublicConfig {
  /** e.g. "https://secret.example.com" (no trailing slash). */
  baseUrl: string;
  /** Lower-case hostname requests are matched on. */
  host: string;
  origin: string;
  /** Optional dedicated port for the secrets-only app. */
  port: number | null;
}

export type SecretsPublicConfigResult =
  | { ok: true; config: SecretsPublicConfig }
  | { ok: false; reason: string | null };

/** Reads SECRETS_PUBLIC_BASE_URL (+ SECRETS_PUBLIC_PORT). Unset → off, not an error. */
export function secretsPublicConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SecretsPublicConfigResult {
  const raw = env.SECRETS_PUBLIC_BASE_URL?.trim();
  if (!raw) return { ok: false, reason: null };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "SECRETS_PUBLIC_BASE_URL isn't a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "SECRETS_PUBLIC_BASE_URL must start with https://" };
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return { ok: false, reason: "SECRETS_PUBLIC_BASE_URL must be just a scheme and host, e.g. https://secret.example.com" };
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || /^127\./.test(hostname) || hostname === "[::1]") {
    return { ok: false, reason: "SECRETS_PUBLIC_BASE_URL must be a public host, not localhost" };
  }
  const portRaw = env.SECRETS_PUBLIC_PORT?.trim();
  let port: number | null = null;
  if (portRaw) {
    const n = Number(portRaw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, reason: "SECRETS_PUBLIC_PORT must be a port number" };
    port = n;
  }
  return { ok: true, config: { baseUrl: url.origin, host: hostname, origin: url.origin, port } };
}

function headerList(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap((v) => v.split(","));
}

function hostnameOf(authority: string): string | null {
  const trimmed = authority.trim().replace(/^"|"$/g, "");
  if (!trimmed || trimmed.includes("@")) return null;
  try {
    return new URL(`http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when a request was addressed to the secrets host. Host, X-Forwarded-Host
 * and Forwarded host= all count: matching more only sends more requests to
 * the restricted app, never fewer.
 */
export function isSecretsHostRequest(headers: IncomingHttpHeaders, config: SecretsPublicConfig): boolean {
  const authorities = [
    ...headerList(headers.host),
    ...headerList(headers["x-forwarded-host"]),
    ...headerList(headers.forwarded)
      .flatMap((entry) => entry.split(";"))
      .map((p) => p.trim())
      .filter((p) => p.toLowerCase().startsWith("host="))
      .map((p) => p.slice(5)),
  ];
  return authorities.some((a) => hostnameOf(a) === config.host);
}

/** True when the visitor's connection to the tunnel was HTTPS. */
export function isHttpsRequest(req: express.Request): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  const proto = headerList(req.headers["x-forwarded-proto"])[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  for (const entry of headerList(req.headers.forwarded)) {
    for (const p of entry.split(";")) {
      const [k, v] = p.split("=");
      if (k?.trim().toLowerCase() === "proto") return v?.trim().replace(/^"|"$/g, "").toLowerCase() === "https";
    }
  }
  return false;
}

/** Fixed-window counter per key, plus memory cleanup. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one hit; false when the key is over its limit. */
  hit(key: string): boolean {
    const now = this.now();
    if (this.hits.size > 5_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  blocked(key: string): boolean {
    const entry = this.hits.get(key);
    return Boolean(entry && entry.resetAt > this.now() && entry.count >= this.limit);
  }
}

/**
 * The client's address as seen by the tunnel: Cloudflare's header, else the
 * last X-Forwarded-For hop (ngrok appends the real one), else the socket.
 * Spoofable by a determined client, which is why every limit also has a
 * global bucket.
 */
function clientKey(req: express.Request): string {
  const cf = headerList(req.headers["cf-connecting-ip"])[0]?.trim();
  if (cf) return cf;
  const xff = headerList(req.headers["x-forwarded-for"]).map((v) => v.trim()).filter(Boolean);
  if (xff.length) return xff[xff.length - 1];
  return req.socket.remoteAddress ?? "unknown";
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time string compare (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k && !out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}

interface PortalSession {
  csrf: string;
  authed: boolean;
  expiresAt: number;
}

class SessionStore {
  // Keyed by the hash of the cookie value, so memory never holds the cookie.
  private readonly sessions = new Map<string, PortalSession>();
  constructor(private readonly now: () => number) {}

  get(id: string | undefined): PortalSession | null {
    if (!id) return null;
    const key = sha256(id).toString("hex");
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return s;
  }

  create(authed: boolean): { id: string; session: PortalSession } {
    const now = this.now();
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k);
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    const id = randomBytes(32).toString("base64url");
    const session = { csrf: randomBytes(32).toString("base64url"), authed, expiresAt: now + PORTAL_SESSION_TTL_MS };
    this.sessions.set(sha256(id).toString("hex"), session);
    return { id, session };
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(sha256(id).toString("hex"));
  }
}

export interface SecretsPublicAppDeps extends Pick<SecretsRouterDeps, "onSaved" | "onChanged"> {
  config: SecretsPublicConfig;
  store?: () => SecretStore;
  requests?: SecretRequestRegistry;
  platform?: NodeJS.Platform;
  now?: () => number;
}

function renderLogin(token: string, csrf: string, error?: string): string {
  return `<h1>🔐 Boop secrets</h1>
<p>Enter your secrets passcode to continue.</p>
<form method="post" action="/secrets/enter/${escapeHtml(token)}/login" autocomplete="off">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="passcode">Passcode</label>
<input id="passcode" name="passcode" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<button type="submit">Continue</button>
</form>`;
}

function notFound(res: express.Response): void {
  res.status(404);
  res.setHeader("Cache-Control", "no-store");
  res.type("text/plain").send("Not found");
}

/** The secrets-only app. Mount it at the root of the secrets host. */
export function createSecretsPublicApp(deps: SecretsPublicAppDeps): express.Express {
  const store = deps.store ?? secretStore;
  const requests = deps.requests ?? secretRequests;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const { config } = deps;
  const sessions = new SessionStore(now);
  // All requests: generous, just stops floods.
  const perClient = new RateLimiter(60, 60_000, now);
  // Failures (wrong passcode, bad/dead link, bad CSRF): tight, per client and overall.
  const failuresPerClient = new RateLimiter(10, 15 * 60_000, now);
  const failuresGlobal = new RateLimiter(30, 15 * 60_000, now);

  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (!secretsSupported(platform)) return notFound(res);
    if (!isHttpsRequest(req)) {
      res.status(403).type("text/plain").send("HTTPS only.");
      return;
    }
    if (!perClient.hit(clientKey(req))) return tooMany(res);
    next();
  });

  function tooMany(res: express.Response): void {
    res.setHeader("Retry-After", "900");
    send(res, 429, "Slow down", "<h1>Too many attempts</h1><p>Wait a few minutes, then ask Boop for a new link.</p>");
  }

  function failed(req: express.Request): void {
    failuresPerClient.hit(clientKey(req));
    failuresGlobal.hit("all");
  }

  function lockedOut(req: express.Request): boolean {
    return failuresPerClient.blocked(clientKey(req)) || failuresGlobal.blocked("all");
  }

  function sessionCookie(id: string): string {
    return `${SESSION_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(PORTAL_SESSION_TTL_MS / 1000)}`;
  }

  function currentSession(req: express.Request): { id?: string; session: PortalSession | null } {
    const id = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    return { id, session: sessions.get(id) };
  }

  /** Same-origin POST with a matching CSRF token from this session. */
  function csrfOk(req: express.Request, session: PortalSession | null): boolean {
    if (!session) return false;
    const origin = req.headers.origin;
    if (origin && origin !== config.origin) return false;
    const field = (req.body as { csrf?: unknown } | undefined)?.csrf;
    return typeof field === "string" && safeEqual(field, session.csrf);
  }

  async function passcodeMatches(input: unknown): Promise<boolean | null> {
    const stored = await store().get(SECRETS_PORTAL_PASSCODE_NAME).catch(() => null);
    if (!stored || stored.length < MIN_PORTAL_PASSCODE_LENGTH) return null;
    return typeof input === "string" && safeEqual(input, stored);
  }

  function liveLink(req: express.Request, res: express.Response) {
    const found = requests.peek(String(req.params.token));
    if (found.ok && found.request.name === SECRETS_PORTAL_PASSCODE_NAME) {
      // The passcode guards this host, so it can only be changed on the Mac.
      send(res, 403, "Not here", "<h1>Not available here</h1><p>Set the secrets passcode from the link on the Mac itself.</p>");
      return null;
    }
    if (!found.ok) {
      failed(req);
      send(res, 410, "Link expired", `<h1>Link no longer works</h1><p>${deadLinkMessage(found.reason)}</p>`);
      return null;
    }
    return found.request;
  }

  const form = express.urlencoded({ extended: false, limit: "32kb", parameterLimit: 5 });

  app.get("/secrets/enter/:token", async (req, res) => {
    if (lockedOut(req)) return tooMany(res);
    const request = liveLink(req, res);
    if (!request) return;
    let { id, session } = currentSession(req);
    if (!session) {
      ({ id, session } = sessions.create(false));
      res.setHeader("Set-Cookie", sessionCookie(id));
    }
    if (!session.authed) {
      if ((await passcodeMatches(undefined)) === null) {
        return send(
          res,
          503,
          "Not set up",
          `<h1>Remote entry isn't set up</h1><p>Set ${SECRETS_PORTAL_PASSCODE_NAME} on the Mac first (ask Boop to request it and open the local link), then try again.</p>`,
        );
      }
      return send(res, 200, "Log in", renderLogin(String(req.params.token), session.csrf));
    }
    const replaces = await store().has(request.name).catch(() => false);
    send(res, 200, `Set ${request.name}`, renderEntryForm(request, { replaces, csrfToken: session.csrf }));
  });

  app.post("/secrets/enter/:token/login", form, async (req, res) => {
    if (lockedOut(req)) return tooMany(res);
    const request = liveLink(req, res);
    if (!request) return;
    const { id, session } = currentSession(req);
    if (!csrfOk(req, session)) {
      failed(req);
      return send(res, 403, "Expired form", "<h1>This form expired</h1><p>Reload the link and try again.</p>");
    }
    const ok = await passcodeMatches((req.body as { passcode?: unknown }).passcode);
    if (ok === null) {
      return send(res, 503, "Not set up", `<h1>Remote entry isn't set up</h1><p>Set ${SECRETS_PORTAL_PASSCODE_NAME} on the Mac first.</p>`);
    }
    if (!ok) {
      failed(req);
      if (lockedOut(req)) return tooMany(res);
      return send(res, 401, "Log in", renderLogin(String(req.params.token), session!.csrf, "Wrong passcode."));
    }
    // New session id on login, so a cookie planted before it is worthless.
    sessions.destroy(id);
    const fresh = sessions.create(true);
    res.setHeader("Set-Cookie", sessionCookie(fresh.id));
    res.redirect(303, `/secrets/enter/${encodeURIComponent(String(req.params.token))}`);
  });

  app.post("/secrets/enter/:token", form, async (req, res) => {
    if (lockedOut(req)) return tooMany(res);
    const request = liveLink(req, res);
    if (!request) return;
    const { session } = currentSession(req);
    if (!session?.authed) {
      failed(req);
      return send(res, 401, "Log in", "<h1>Log in first</h1><p>Reload the link and enter your passcode.</p>");
    }
    if (!csrfOk(req, session)) {
      failed(req);
      return send(res, 403, "Expired form", "<h1>This form expired</h1><p>Reload the link and try again.</p>");
    }
    await saveFromLink(String(req.params.token), (req.body as { value?: unknown }).value, res, {
      store,
      requests,
      deps,
      formOptions: { csrfToken: session.csrf },
    });
  });

  // Everything else on this host — dashboard, API, websockets — doesn't exist.
  app.use((_req, res) => notFound(res));
  // No logging: an error here could quote a token or a value.
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    res.status(400).type("text/plain").send("Bad request");
  });
  return app;
}

/**
 * Main-port middleware: requests addressed to the secrets host go to the
 * secrets-only app and never fall through to anything mounted after it.
 */
export function secretsHostDispatcher(config: SecretsPublicConfig, secretsApp: express.Express): express.RequestHandler {
  return (req, res, next) => {
    if (isSecretsHostRequest(req.headers, config)) secretsApp(req, res);
    else next();
  };
}

/** Link for request_secret, when the public host is configured. */
export function publicSecretEntryUrl(token: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const cfg = secretsPublicConfigFromEnv(env);
  return cfg.ok ? `${cfg.config.baseUrl}/secrets/enter/${token}` : null;
}

export interface RemoteSecretEntryStatus {
  enabled: boolean;
  baseUrl: string | null;
  port: number | null;
  passcodeSet: boolean;
  status: string;
}

/** For get_config: is remote entry on, where, and if not, why. */
export async function describeRemoteSecretEntry(
  opts: { env?: NodeJS.ProcessEnv; store?: () => SecretStore; platform?: NodeJS.Platform } = {},
): Promise<RemoteSecretEntryStatus> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const cfg = secretsPublicConfigFromEnv(env);
  const baseUrl = cfg.ok ? cfg.config.baseUrl : null;
  const port = cfg.ok ? cfg.config.port : null;
  if (!secretsSupported(platform)) {
    return { enabled: false, baseUrl, port, passcodeSet: false, status: "Remote secret entry: off (secrets only live on the Mac)" };
  }
  if (!cfg.ok) {
    return {
      enabled: false,
      baseUrl: null,
      port: null,
      passcodeSet: false,
      status: `Remote secret entry: off (${cfg.reason ?? "SECRETS_PUBLIC_BASE_URL not set"})`,
    };
  }
  let passcode: string | null = null;
  try {
    passcode = await (opts.store ?? secretStore)().get(SECRETS_PORTAL_PASSCODE_NAME);
  } catch {
    passcode = null;
  }
  const passcodeSet = Boolean(passcode && passcode.length >= MIN_PORTAL_PASSCODE_LENGTH);
  const where = `${cfg.config.baseUrl}${cfg.config.port ? ` (also on 127.0.0.1:${cfg.config.port})` : ""}`;
  return {
    enabled: passcodeSet,
    baseUrl: cfg.config.baseUrl,
    port: cfg.config.port,
    passcodeSet,
    status: passcodeSet
      ? `Remote secret entry: enabled at ${where}`
      : `Remote secret entry: configured at ${where} but locked until ${SECRETS_PORTAL_PASSCODE_NAME} (${MIN_PORTAL_PASSCODE_LENGTH}+ characters) is set on the Mac`,
  };
}
