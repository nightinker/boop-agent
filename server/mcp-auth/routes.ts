import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import express from "express";
import { isLoopbackAddress, isTrustedLocalRequest } from "../local-access.js";
import { escapeHtml, send } from "../secrets/routes.js";
import type { AuthOrigin, McpAuthService } from "./service.js";
import type { FetchLike } from "./oauth.js";

/**
 * HTTP side of MCP authentication.
 *
 * On the main app (the Mac, or the Access-protected PUBLIC_URL):
 *   GET /mcp-auth/start/:token   spends the one-time link, redirects to the server's sign-in
 *   GET /mcp-auth/callback       the OAuth redirect back; stores the tokens
 * The public secrets host serves the same two pages behind its passcode
 * (see secrets/public-host.ts).
 *
 * And the loopback-only proxy sub-agents connect through:
 *   ALL /mcp-proxy/:name         forwards to the real MCP server, adding the
 *                                Authorization header inside Boop, so tokens
 *                                never reach the Claude process, its argv or env.
 *
 * Nothing here logs a request, a query string, a code or a token.
 */

export const MCP_PROXY_KEY_HEADER = "x-boop-mcp-proxy-key";

/** A per-process key the proxy requires, on top of loopback-only access. */
export const MCP_PROXY_KEY = randomBytes(32).toString("base64url");

export function mcpProxyUrl(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const port = Number(env.PORT ?? 3456);
  return `http://127.0.0.1:${port}/mcp-proxy/${encodeURIComponent(name)}`;
}

function sameKey(a: string, b: string): boolean {
  const h = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(h(a), h(b));
}

export function renderResult(res: express.Response, result: { ok: boolean; message: string }): void {
  send(
    res,
    result.ok ? 200 : 400,
    result.ok ? "Connected" : "Not connected",
    result.ok
      ? `<h1 class="ok">✓ Connected</h1><p>${escapeHtml(result.message)}</p>`
      : `<h1 class="err">Not connected</h1><p>${escapeHtml(result.message)}</p>`,
  );
}

/** Starts the flow and redirects, or shows why it can't. Shared with the public secrets host. */
export async function startFromLink(
  service: McpAuthService,
  token: string,
  origin: AuthOrigin,
  res: express.Response,
): Promise<void> {
  const result = await service.beginFlow(token, origin);
  if (!result.ok) {
    renderResult(res, { ok: false, message: result.message });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.redirect(303, result.url);
}

export async function finishCallback(service: McpAuthService, query: Record<string, unknown>, res: express.Response): Promise<void> {
  const result = await service.completeFlow(query);
  renderResult(res, result);
}

export function createMcpAuthRouter(
  service: McpAuthService,
  opts: { isLocal?: (req: express.Request) => boolean } = {},
): express.Router {
  const isLocal = opts.isLocal ?? ((req: express.Request) => isTrustedLocalRequest(req));
  const router = express.Router();
  router.get("/start/:token", async (req, res) => {
    if (!service.supported) return renderResult(res, { ok: false, message: "MCP sign-in only works on the owner's Mac." });
    // Index.ts only lets the Mac itself or an Access-authenticated visitor this far.
    await startFromLink(service, String(req.params.token), isLocal(req) ? "local" : "access", res);
  });
  router.get("/callback", async (req, res) => {
    await finishCallback(service, req.query as Record<string, unknown>, res);
  });
  return router;
}

const FORWARD_REQUEST_HEADERS = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"];

function jsonRpcError(res: express.Response, status: number, message: string, body?: Buffer): void {
  let id: unknown = null;
  try {
    const parsed = body?.length ? JSON.parse(body.toString("utf8")) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) id = (parsed as { id?: unknown }).id ?? null;
  } catch {
    // Not JSON; answer with id null.
  }
  res.status(status).json({ jsonrpc: "2.0", id, error: { code: -32001, message } });
}

/**
 * The proxy. Mount it BEFORE express.json so the raw body is forwarded as is.
 * Only answers loopback requests carrying MCP_PROXY_KEY.
 */
export function createMcpProxyRouter(
  service: McpAuthService,
  opts: { key?: string; fetch?: FetchLike } = {},
): express.Router {
  const key = opts.key ?? MCP_PROXY_KEY;
  const fetchImpl: FetchLike = opts.fetch ?? ((...args) => fetch(...args));
  const router = express.Router();
  router.all("/:name", express.raw({ type: () => true, limit: "8mb" }), async (req, res) => {
    const provided = req.headers[MCP_PROXY_KEY_HEADER];
    if (!isLoopbackAddress(req.socket.remoteAddress) || typeof provided !== "string" || !sameKey(provided, key)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const name = String(req.params.name);
    const entry = await service.config.get(name).catch(() => null);
    if (!entry) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? (req.body as Buffer) : undefined;
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    const forward = async (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = {};
      for (const h of FORWARD_REQUEST_HEADERS) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      if (token) headers.authorization = `Bearer ${token}`;
      return fetchImpl(entry.url, {
        method: req.method,
        headers,
        ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body: new Uint8Array(body) } : {}),
        signal: abort.signal,
        redirect: "manual",
      });
    };

    const needsReauth = (reason: string) =>
      jsonRpcError(res, 503, `${reason} Tell Boop: it can send the owner a sign-in link (start_mcp_auth "${name}").`, body);

    try {
      let auth = await service.accessToken(name);
      if (!auth.ok) return needsReauth(auth.reason);
      let upstream = await forward(auth.token);
      if (upstream.status === 401 && entry.auth !== "none") {
        await upstream.body?.cancel().catch(() => undefined);
        auth = await service.handleUnauthorized(name);
        if (!auth.ok) return needsReauth(auth.reason);
        upstream = await forward(auth.token);
        if (upstream.status === 401) {
          await upstream.body?.cancel().catch(() => undefined);
          await service.markNeedsReauth(name, "the server rejected a freshly refreshed token");
          return needsReauth(`${name} needs re-authentication.`);
        }
      }
      res.status(upstream.status);
      for (const h of FORWARD_RESPONSE_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!upstream.body) {
        res.end();
        return;
      }
      Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => res.end()).pipe(res);
    } catch {
      // Not logged: the error could carry request details.
      if (!res.headersSent) jsonRpcError(res, 502, `Couldn't reach the ${name} MCP server.`, body);
      else res.end();
    }
  });
  return router;
}
