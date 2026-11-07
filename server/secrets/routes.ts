import express from "express";
import { secretRequests, type SecretRequest, type SecretRequestRegistry } from "./requests.js";
import {
  secretStore,
  secretsSupported,
  SECRETS_UNSUPPORTED_MESSAGE,
  validateSecretName,
  validateSecretValue,
  type SecretStore,
} from "./store.js";

/**
 * HTTP side of the secret store, mounted at /secrets. Like the rest of the
 * API it only answers the Mac itself or a visitor who passed the Cloudflare
 * Access login (index.ts checks that before any route runs).
 *
 *   GET  /secrets/enter/:token   the one-time entry page
 *   POST /secrets/enter/:token   saves the value; the link is then spent
 *   GET  /secrets/status         names + status for the dashboard (no values)
 *   POST /secrets/:name/delete   deletes one secret (the dashboard confirms)
 *
 * Request bodies are never logged, and the saved value is never echoed back.
 */

export interface SecretsRouterDeps {
  store?: () => SecretStore;
  requests?: SecretRequestRegistry;
  platform?: NodeJS.Platform;
  /** Told when a secret was saved from a link (name only), e.g. to text the owner. */
  onSaved?: (request: SecretRequest) => void | Promise<void>;
  onChanged?: () => void;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root { --bg:#f4f4f5; --card:#fff; --text:#18181b; --muted:#71717a; --border:#e4e4e7; --accent:#18181b; --accent-text:#fff; --err:#be123c; --ok:#047857; }
@media (prefers-color-scheme: dark) { :root { --bg:#18181b; --card:#202024; --text:#fafafa; --muted:#a1a1aa; --border:#3f3f46; --accent:#fafafa; --accent-text:#18181b; --err:#fda4af; --ok:#6ee7b7; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:24px; }
h1 { font-size:18px; margin:0 0 4px; }
p { margin:8px 0; color:var(--muted); }
code { font:13px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--text); word-break:break-all; }
label { display:block; margin:16px 0 6px; font-weight:600; }
input[type=password] { width:100%; padding:12px; font-size:16px; border-radius:10px; border:1px solid var(--border); background:var(--bg); color:var(--text); }
button { margin-top:16px; width:100%; padding:12px; font-size:16px; font-weight:600; border:0; border-radius:10px; background:var(--accent); color:var(--accent-text); cursor:pointer; }
.err { color:var(--err); }
.ok { color:var(--ok); }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function send(res: express.Response, status: number, title: string, body: string): void {
  res.status(status);
  res.setHeader("Cache-Control", "no-store");
  // same-origin, not no-referrer: under no-referrer a browser submits the
  // entry form with `Origin: null`, which the local trust check and the
  // public host's origin check both refuse. Other sites still get nothing.
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.type("html").send(page(title, body));
}

export function deadLinkMessage(reason: "unknown" | "expired" | "used"): string {
  if (reason === "expired") return "This link has expired. Ask Boop for a new one.";
  if (reason === "used") return "This link was already used. Ask Boop for a new one to change the value.";
  return "This link isn't valid. Ask Boop for a new one.";
}

export function renderEntryForm(
  request: SecretRequest,
  opts: { error?: string; replaces?: boolean; csrfToken?: string } = {},
): string {
  const minutesLeft = Math.max(1, Math.round((request.expiresAt - Date.now()) / 60_000));
  return `<h1>🔐 Set ${escapeHtml(request.name)}</h1>
<p>${escapeHtml(request.description || "Boop asked for this secret.")}</p>
<p>The value goes straight into this Mac's Keychain. It is never sent to chat, the AI model, memory or logs.${opts.replaces ? " <strong>It replaces the value stored now.</strong>" : ""}</p>
<form method="post" autocomplete="off">
${opts.csrfToken ? `<input type="hidden" name="csrf" value="${escapeHtml(opts.csrfToken)}">` : ""}
<label for="value">Value</label>
<input id="value" name="value" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>
${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ""}
<button type="submit">Save secret</button>
</form>
<p>This link works once and expires in about ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.</p>`;
}

/**
 * Saves the value typed on an entry page and spends the link. Shared by the
 * local router and the public secrets host, so both validate and save the
 * same way. Never logs the value or the token.
 */
export async function saveFromLink(
  token: string,
  raw: unknown,
  res: express.Response,
  ctx: {
    store: () => SecretStore;
    requests: SecretRequestRegistry;
    deps: Pick<SecretsRouterDeps, "onSaved" | "onChanged">;
    formOptions?: { csrfToken?: string };
  },
): Promise<void> {
  const { store, requests, deps } = ctx;
  const found = requests.peek(token);
  if (!found.ok) return send(res, 410, "Link expired", `<h1>Link no longer works</h1><p>${deadLinkMessage(found.reason)}</p>`);
  // Trailing newlines sneak in from copy-paste; nothing else is altered.
  const value = typeof raw === "string" ? raw.replace(/[\r\n]+$/, "") : raw;
  const valueError = validateSecretValue(value);
  if (valueError) {
    return send(res, 400, `Set ${found.request.name}`, renderEntryForm(found.request, { ...ctx.formOptions, error: valueError }));
  }
  // Spend the link before saving, so a second submit can't race in.
  const consumed = requests.consume(token);
  if (!consumed.ok) return send(res, 410, "Link expired", `<h1>Link no longer works</h1><p>${deadLinkMessage(consumed.reason)}</p>`);
  try {
    const saved = await store().set(consumed.request.name, value as string);
    deps.onChanged?.();
    void Promise.resolve(deps.onSaved?.(consumed.request)).catch(() => undefined);
    send(
      res,
      200,
      "Saved",
      `<h1 class="ok">✓ Saved ${escapeHtml(saved.name)}</h1><p>Stored in ${saved.backend === "keychain" ? "the macOS Keychain" : "Boop's private secrets file"}. You can close this tab and go back to Boop.</p>`,
    );
  } catch {
    // Not logged: the error could, in theory, quote the input.
    send(res, 500, "Not saved", `<h1 class="err">Couldn't save it</h1><p>Nothing was stored. Ask Boop for a new link and try again.</p>`);
  }
}

export function createSecretsRouter(deps: SecretsRouterDeps = {}): express.Router {
  const store = deps.store ?? secretStore;
  const requests = deps.requests ?? secretRequests;
  const platform = deps.platform ?? process.platform;
  const router = express.Router();

  router.get("/enter/:token", async (req, res) => {
    if (!secretsSupported(platform)) return send(res, 404, "Not available", `<h1>Not available</h1><p>${SECRETS_UNSUPPORTED_MESSAGE}</p>`);
    const found = requests.peek(req.params.token);
    if (!found.ok) return send(res, 410, "Link expired", `<h1>Link no longer works</h1><p>${deadLinkMessage(found.reason)}</p>`);
    const replaces = await store().has(found.request.name).catch(() => false);
    send(res, 200, `Set ${found.request.name}`, renderEntryForm(found.request, { replaces }));
  });

  router.post(
    "/enter/:token",
    express.urlencoded({ extended: false, limit: "32kb", parameterLimit: 5 }),
    async (req, res) => {
      if (!secretsSupported(platform)) return send(res, 404, "Not available", `<h1>Not available</h1><p>${SECRETS_UNSUPPORTED_MESSAGE}</p>`);
      await saveFromLink(req.params.token, (req.body as { value?: unknown } | undefined)?.value, res, { store, requests, deps });
    },
  );

  router.get("/status", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!secretsSupported(platform)) {
      res.json({ supported: false, message: SECRETS_UNSUPPORTED_MESSAGE, secrets: [], pending: [] });
      return;
    }
    try {
      const secrets = await store().list();
      const pending = requests.pending().filter((p) => !secrets.some((s) => s.name === p.name));
      res.json({ supported: true, secrets, pending });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/:name/delete", async (req, res) => {
    if (!secretsSupported(platform)) {
      res.status(409).json({ error: SECRETS_UNSUPPORTED_MESSAGE });
      return;
    }
    const nameError = validateSecretName(req.params.name);
    if (nameError) {
      res.status(400).json({ error: nameError });
      return;
    }
    try {
      const deleted = await store().delete(req.params.name);
      if (!deleted) {
        res.status(404).json({ error: `No secret named ${req.params.name}.` });
        return;
      }
      deps.onChanged?.();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
