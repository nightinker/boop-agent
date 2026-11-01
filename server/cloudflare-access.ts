import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Cloudflare Access puts a signed token (JWT) on every request from someone
 * who passed its login. When Boop runs behind Access (CF_ACCESS_TEAM_DOMAIN
 * and CF_ACCESS_AUD set), a valid token lets that visitor use the dashboard
 * and its API, as if they were on the machine itself. Without both settings
 * nothing changes: only local requests are trusted.
 */

export interface AccessConfig {
  /** e.g. "your-team.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's Audience (AUD) tag. */
  audience: string;
  /** The site's own origin, e.g. "https://agent.example.com". */
  origin?: string;
}

export function accessConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AccessConfig | null {
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const audience = (env.CF_ACCESS_AUD ?? "").trim();
  if (!teamDomain || !audience) return null;
  let origin: string | undefined;
  try {
    origin = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : undefined;
  } catch {
    origin = undefined;
  }
  return { teamDomain, audience, origin };
}

type KeyFetcher = (teamDomain: string) => Promise<Map<string, KeyObject>>;

const KEY_CACHE_MS = 60 * 60_000;
let cachedKeys: { teamDomain: string; keys: Map<string, KeyObject>; at: number } | null = null;

const fetchKeys: KeyFetcher = async (teamDomain) => {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Cloudflare Access certs HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kid) keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
  }
  return keys;
};

async function signingKey(
  teamDomain: string,
  kid: string,
  fetcher: KeyFetcher,
  now: number,
): Promise<KeyObject | undefined> {
  const fresh = cachedKeys && cachedKeys.teamDomain === teamDomain && now - cachedKeys.at < KEY_CACHE_MS;
  if (fresh && cachedKeys!.keys.has(kid)) return cachedKeys!.keys.get(kid);
  // Unknown key id or stale cache: Cloudflare rotates keys, so fetch again.
  const keys = await fetcher(teamDomain);
  cachedKeys = { teamDomain, keys, at: now };
  return keys.get(kid);
}

/** Test hook: forget cached signing keys. */
export function resetAccessKeyCache(): void {
  cachedKeys = null;
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The verified token's email, or null if the token is missing or invalid. */
export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  opts: { fetcher?: KeyFetcher; now?: number } = {},
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodePart(headerPart);
  const payload = decodePart(payloadPart);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const now = opts.now ?? Date.now();
  let key: KeyObject | undefined;
  try {
    key = await signingKey(config.teamDomain, header.kid, opts.fetcher ?? fetchKeys, now);
  } catch (err) {
    console.warn("[access] couldn't load Cloudflare Access keys", err);
    return null;
  }
  if (!key) return null;

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerPart}.${payloadPart}`);
  if (!verifier.verify(key, Buffer.from(signaturePart, "base64url"))) return null;

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) return null;
  if (payload.iss !== `https://${config.teamDomain}`) return null;
  const seconds = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= seconds) return null;
  if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) return null;
  return typeof payload.email === "string" ? payload.email : "";
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * True when the request carries a valid Access token and, if the browser sent
 * an Origin, it's this site's own. The origin check stops other websites from
 * using the visitor's Access session to call Boop's API.
 */
export async function isAccessAuthenticatedRequest(
  request: { headers: IncomingHttpHeaders },
  config: AccessConfig | null = accessConfigFromEnv(),
  opts: { fetcher?: KeyFetcher; now?: number } = {},
): Promise<boolean> {
  if (!config) return false;
  const token = headerValue(request.headers, "cf-access-jwt-assertion");
  if (!token) return false;
  const origin = headerValue(request.headers, "origin");
  if (origin && (!config.origin || origin !== config.origin)) return false;
  return (await verifyAccessToken(token, config, opts)) !== null;
}
