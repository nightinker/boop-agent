import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";

/**
 * Where remote secret entry (the public secrets host) gets its settings.
 *
 * The one source of truth is a small JSON file OUTSIDE Boop.app, so it
 * survives app restarts, reinstalls and runtime re-copies:
 *
 *   ~/.config/boop/secrets-remote.json   (or $BOOP_SECRETS_REMOTE_CONFIG)
 *   { "publicBaseUrl": "https://secret.example.com", "port": 3457 }
 *
 * The passcode is never in it: it stays in the secret store (Keychain) as
 * SECRETS_PORTAL_PASSCODE. SECRETS_PUBLIC_BASE_URL / SECRETS_PUBLIC_PORT in
 * the environment still work when there's no file, with a warning; when the
 * file exists it wins. Nothing here reads or logs a secret value.
 */

export const SECRETS_REMOTE_CONFIG_ENV = "BOOP_SECRETS_REMOTE_CONFIG";
export const DEFAULT_SECRETS_REMOTE_PORT = 3457;
export const PROBE_HEADER = "x-boop-secrets-probe";

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

export type SecretsRemoteConfigSource = "file" | "env" | "none";

export type SecretsRemoteConfigResolution =
  | {
      ok: true;
      config: SecretsPublicConfig;
      source: Exclude<SecretsRemoteConfigSource, "none">;
      configPath: string | null;
      warnings: string[];
    }
  | {
      ok: false;
      source: SecretsRemoteConfigSource;
      configPath: string | null;
      /** Each item says exactly what's missing or wrong and how to fix it. */
      missing: string[];
      reason: string;
      warnings: string[];
    };

/** Validates a base URL + optional port. `labels` name the fields in errors. */
export function parseSecretsPublicConfig(
  raw: { baseUrl: string | undefined; port: string | number | null | undefined },
  labels: { baseUrl: string; port: string },
): SecretsPublicConfigResult {
  const base = raw.baseUrl?.trim();
  if (!base) return { ok: false, reason: null };
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { ok: false, reason: `${labels.baseUrl} isn't a valid URL` };
  }
  if (url.protocol !== "https:") return { ok: false, reason: `${labels.baseUrl} must start with https://` };
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return { ok: false, reason: `${labels.baseUrl} must be just a scheme and host, e.g. https://secret.example.com` };
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || /^127\./.test(hostname) || hostname === "[::1]") {
    return { ok: false, reason: `${labels.baseUrl} must be a public host, not localhost` };
  }
  let port: number | null = null;
  const portRaw = typeof raw.port === "number" ? String(raw.port) : raw.port?.trim();
  if (portRaw) {
    const n = Number(portRaw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, reason: `${labels.port} must be a port number` };
    port = n;
  }
  return { ok: true, config: { baseUrl: url.origin, host: hostname, origin: url.origin, port } };
}

/** The config file's path: $BOOP_SECRETS_REMOTE_CONFIG, else ~/.config/boop/secrets-remote.json. */
export function secretsRemoteConfigPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME?.trim() || null;
  const explicit = env[SECRETS_REMOTE_CONFIG_ENV]?.trim();
  if (explicit) {
    if (explicit === "~" || explicit.startsWith("~/")) return home ? path.join(home, explicit.slice(1)) : null;
    return path.resolve(explicit);
  }
  return home ? path.join(home, ".config", "boop", "secrets-remote.json") : null;
}

export interface ResolveOptions {
  readFile?: (file: string) => string;
  exists?: (file: string) => boolean;
}

function exampleFile(): string {
  return `{"publicBaseUrl":"https://secret.example.com","port":${DEFAULT_SECRETS_REMOTE_PORT}}`;
}

/**
 * Reads the remote-entry config: the file first, then the legacy env vars.
 * Never throws; when it's off, `missing` says exactly what to add.
 */
export function resolveSecretsRemoteConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveOptions = {},
): SecretsRemoteConfigResolution {
  const exists = opts.exists ?? existsSync;
  const readFile = opts.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const configPath = secretsRemoteConfigPath(env);
  const warnings: string[] = [];
  if (env.SECRETS_PORTAL_PASSCODE !== undefined) {
    warnings.push(
      "SECRETS_PORTAL_PASSCODE is set in the environment and is ignored; the passcode is only read from the Keychain (set it with request_secret on the Mac)",
    );
  }
  const envBase = env.SECRETS_PUBLIC_BASE_URL?.trim();
  const where = configPath ?? `$${SECRETS_REMOTE_CONFIG_ENV}`;

  if (configPath && exists(configPath)) {
    let data: unknown;
    try {
      data = JSON.parse(readFile(configPath));
    } catch (err) {
      const why = err instanceof SyntaxError ? "isn't valid JSON" : "couldn't be read";
      return {
        ok: false,
        source: "file",
        configPath,
        missing: [`${configPath} ${why}; it should look like ${exampleFile()}`],
        reason: `${configPath} ${why}`,
        warnings,
      };
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return {
        ok: false,
        source: "file",
        configPath,
        missing: [`${configPath} must be a JSON object like ${exampleFile()}`],
        reason: `${configPath} isn't a JSON object`,
        warnings,
      };
    }
    const obj = data as Record<string, unknown>;
    const missing: string[] = [];
    const baseRaw = typeof obj.publicBaseUrl === "string" ? obj.publicBaseUrl : undefined;
    if (!baseRaw?.trim()) missing.push(`"publicBaseUrl" in ${configPath} (e.g. "https://secret.example.com")`);
    let portRaw: string | number | undefined;
    if (obj.port === undefined) portRaw = DEFAULT_SECRETS_REMOTE_PORT;
    else if (typeof obj.port === "number" || typeof obj.port === "string") portRaw = obj.port;
    else missing.push(`"port" in ${configPath} must be a number, e.g. ${DEFAULT_SECRETS_REMOTE_PORT}`);
    if (missing.length) {
      return { ok: false, source: "file", configPath, missing, reason: `incomplete config in ${configPath}`, warnings };
    }
    const parsed = parseSecretsPublicConfig(
      { baseUrl: baseRaw, port: portRaw },
      { baseUrl: `"publicBaseUrl" in ${configPath}`, port: `"port" in ${configPath}` },
    );
    if (!parsed.ok) {
      const reason = parsed.reason ?? `"publicBaseUrl" in ${configPath} is empty`;
      return { ok: false, source: "file", configPath, missing: [reason], reason, warnings };
    }
    if (envBase) {
      const fromEnv = parseSecretsPublicConfig({ baseUrl: envBase, port: null }, { baseUrl: "", port: "" });
      if (!fromEnv.ok || fromEnv.config.baseUrl !== parsed.config.baseUrl) {
        warnings.push(`SECRETS_PUBLIC_BASE_URL in the environment is ignored; ${configPath} wins`);
      }
    }
    return { ok: true, config: parsed.config, source: "file", configPath, warnings };
  }

  if (envBase) {
    const parsed = parseSecretsPublicConfig(
      { baseUrl: envBase, port: env.SECRETS_PUBLIC_PORT },
      { baseUrl: "SECRETS_PUBLIC_BASE_URL", port: "SECRETS_PUBLIC_PORT" },
    );
    if (!parsed.ok) {
      const reason = parsed.reason ?? "SECRETS_PUBLIC_BASE_URL is empty";
      return { ok: false, source: "env", configPath, missing: [reason], reason, warnings };
    }
    warnings.push(
      `using SECRETS_PUBLIC_BASE_URL from the environment; move it to ${where} (${exampleFile()}) so it lives outside Boop.app`,
    );
    return { ok: true, config: parsed.config, source: "env", configPath, warnings };
  }

  return {
    ok: false,
    source: "none",
    configPath,
    missing: [`public base URL: create ${where} containing ${exampleFile()} (or run npm run secrets:remote-setup)`],
    reason: `not configured (no ${where}, and SECRETS_PUBLIC_BASE_URL is unset)`,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Runtime state: the dedicated listener, and a probe token for the tunnel check.

export type ListenerState = "off" | "starting" | "listening" | "failed";

export interface RemoteEntryRuntime {
  /** True once index.ts has applied the config (so status can tell "not started yet"). */
  started: boolean;
  /** The base URL the running server routes, or null when remote entry is off. */
  activeBaseUrl: string | null;
  listener: { state: ListenerState; port: number | null; error: string | null };
  /** Random per process; GET <base>/secrets/probe/<token> answers 204 only from this Boop. Not a secret: it unlocks nothing. */
  probeToken: string;
}

export const remoteEntryRuntime: RemoteEntryRuntime = {
  started: false,
  activeBaseUrl: null,
  listener: { state: "off", port: null, error: null },
  probeToken: randomBytes(16).toString("hex"),
};

export interface StartListenerOptions {
  port: number;
  handler: RequestListener;
  host?: string;
  /** Retries on EADDRINUSE (an old Boop may still be shutting down). Default 10. */
  retries?: number;
  retryDelayMs?: number;
  state?: RemoteEntryRuntime["listener"];
  log?: (line: string) => void;
}

/**
 * Starts the secrets-only listener on 127.0.0.1:<port>, retrying while the
 * port is still held by a previous process. Resolves once it's listening or
 * has given up; never rejects. The state object reflects the outcome.
 */
export function startSecretsRemoteListener(opts: StartListenerOptions): Promise<Server | null> {
  const state = opts.state ?? remoteEntryRuntime.listener;
  const host = opts.host ?? "127.0.0.1";
  const retries = opts.retries ?? 10;
  const delay = opts.retryDelayMs ?? 2_000;
  const log = opts.log ?? ((line: string) => console.log(line));
  state.port = opts.port;
  state.state = "starting";
  state.error = null;
  return new Promise((resolve) => {
    let attempt = 0;
    const tryListen = () => {
      const server = createServer(opts.handler);
      server.once("error", (err: NodeJS.ErrnoException) => {
        server.close();
        if (err.code === "EADDRINUSE" && attempt < retries) {
          attempt += 1;
          setTimeout(tryListen, delay);
          return;
        }
        state.state = "failed";
        state.error = err.code === "EADDRINUSE" ? `port ${opts.port} is in use by another process` : err.message;
        log(`[secrets] remote entry listener FAILED on ${host}:${opts.port}: ${state.error}`);
        resolve(null);
      });
      server.listen(opts.port, host, () => {
        state.state = "listening";
        state.error = null;
        log(`[secrets] remote entry listener up on ${host}:${opts.port}`);
        resolve(server);
      });
    };
    tryListen();
  });
}

export interface TunnelProbeResult {
  checked: boolean;
  reachable: boolean | null;
  detail: string;
}

/**
 * Fetches <baseUrl>/secrets/probe/<token> through the public internet. Only
 * this Boop process knows the token, so a 204 with the probe header means the
 * tunnel reaches this very instance.
 */
export async function probeSecretsTunnel(
  baseUrl: string,
  token: string = remoteEntryRuntime.probeToken,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<TunnelProbeResult> {
  const doFetch = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5_000);
  try {
    const res = await doFetch(`${baseUrl}/secrets/probe/${token}`, {
      method: "GET",
      redirect: "manual",
      signal: ctrl.signal,
      headers: { "cache-control": "no-store" },
    });
    if (res.status === 204 && res.headers.get(PROBE_HEADER) === "ok") {
      return { checked: true, reachable: true, detail: `${baseUrl} reaches this Boop` };
    }
    if (res.status === 404) {
      return {
        checked: true,
        reachable: false,
        detail: `${baseUrl} answered 404: the tunnel points at something other than this Boop (or at a Boop started with a different config)`,
      };
    }
    return { checked: true, reachable: false, detail: `${baseUrl} answered HTTP ${res.status} (tunnel down or misrouted?)` };
  } catch (err) {
    const msg = ctrl.signal.aborted ? "timed out" : err instanceof Error ? err.message : String(err);
    return { checked: true, reachable: false, detail: `couldn't reach ${baseUrl}: ${msg} (is the tunnel running?)` };
  } finally {
    clearTimeout(timer);
  }
}
