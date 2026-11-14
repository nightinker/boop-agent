/**
 * Pure helpers for the Nova "Impersonate User" flow: finding the
 * impersonation link in an action result, describing a result without that
 * link, and the safety checks on accounts and target pages.
 *
 * An impersonation link is a credential (whoever opens it is signed in as the
 * customer), so nothing in here ever returns it inside a human-readable string.
 */

/** What an MCP tools/call returns (only the parts we read). */
export interface McpCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Keys Nova action responses use for "open this URL" (openInNewTab, redirect, download, visit). */
const LINK_KEYS = [
  "openInNewTab",
  "open_in_new_tab",
  "redirect",
  "impersonation_url",
  "impersonationUrl",
  "impersonate_url",
  "impersonateUrl",
  "login_url",
  "loginUrl",
  "url",
  "link",
  "href",
  "download",
  "visit",
  "path",
];

const URL_RE = /https?:\/\/[^\s"'<>\\)\]]+/gi;

/** Every string in the result's text blocks and structured content, JSON-decoded where possible. */
export function resultPayloads(result: McpCallResult): unknown[] {
  const out: unknown[] = [];
  if (result.structuredContent !== undefined) out.push(result.structuredContent);
  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = (block as { type?: unknown; text?: unknown }).text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (/^[[{]/.test(trimmed)) {
      try {
        out.push(JSON.parse(trimmed));
        continue;
      } catch {
        // Not JSON; keep the raw text.
      }
    }
    out.push(text);
  }
  return out;
}

/** The plain text of a result, for messages and lookups. */
export function resultText(result: McpCallResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content
    .map((b) => (b && typeof b === "object" ? (b as { text?: unknown }).text : undefined))
    .filter((t): t is string => typeof t === "string");
  if (texts.length) return texts.join("\n");
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return "";
}

function toUsableUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).toString();
    // Nova's Action::visit() returns an app-relative path.
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
  return null;
}

interface Candidate {
  url: string;
  score: number;
}

function collect(value: unknown, baseUrl: string, keyHint: string | null, out: Candidate[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const keyRank = keyHint ? LINK_KEYS.indexOf(keyHint) : -1;
    if (keyRank >= 0) {
      const url = toUsableUrl(value, baseUrl);
      if (url) {
        out.push({ url, score: 100 - keyRank + (/impersonat/i.test(url) ? 50 : 0) });
        return;
      }
    }
    for (const match of value.match(URL_RE) ?? []) {
      const url = toUsableUrl(match.replace(/[.,;:]+$/, ""), baseUrl);
      if (url) out.push({ url, score: 10 + (/impersonat/i.test(url) ? 50 : 0) });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, baseUrl, keyHint, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collect(child, baseUrl, LINK_KEYS.includes(key) ? key : keyHint && typeof child === "object" ? keyHint : null, out, depth + 1);
    }
  }
}

/**
 * The impersonation link in a nova_run_action result, or null when there is
 * no usable http(s) URL. Prefers Nova's own response keys (openInNewTab,
 * redirect, visit.path, ...) and URLs that mention impersonation.
 */
export function extractImpersonationLink(result: McpCallResult, baseUrl: string): string | null {
  if (result.isError) return null;
  const candidates: Candidate[] = [];
  for (const payload of resultPayloads(result)) collect(payload, baseUrl, null, candidates);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

/** Replace every URL (and long token-like run) in a text with a placeholder. */
export function scrubLinks(text: string): string {
  return text
    .replace(URL_RE, "[link removed]")
    .replace(/(["'\s=:/])\/[A-Za-z0-9._~\-/]*(?:\?[^\s"']*)/g, "$1[link removed]")
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[token removed]");
}

/** Remove one specific link (and its encodings) from a text. */
export function removeLink(text: string, link: string | null): string {
  if (!link) return text;
  const variants = new Set([link, encodeURIComponent(link), JSON.stringify(link).slice(1, -1)]);
  try {
    const u = new URL(link);
    if (u.search.length > 8) variants.add(u.search.slice(1));
    if (u.pathname.length > 24) variants.add(u.pathname);
  } catch {
    // Not a URL; the raw value is enough.
  }
  let out = text;
  for (const v of [...variants].sort((a, b) => b.length - a.length)) {
    if (v) out = out.split(v).join("[impersonation link removed]");
  }
  return out;
}

/** What the action returned, quoted for the user, minus anything link- or token-shaped. */
export function describeActionResult(result: McpCallResult, maxLength = 1200): string {
  const text = scrubLinks(resultText(result)).trim();
  if (!text) return "(an empty result)";
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** A URL with its query string and fragment dropped, safe to show (tokens usually live there). */
export function safeDisplayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(unparseable URL)";
  }
}

export type AccountRef = { kind: "id"; id: string } | { kind: "email"; email: string };

export function parseAccount(raw: string): AccountRef | null {
  const value = raw.trim();
  if (/^\d+$/.test(value)) return { kind: "id", id: value };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { kind: "email", email: value.toLowerCase() };
  return null;
}

/** Records in a nova_list_records result that carry an id and the exact email. */
export function findUserIdsByEmail(result: McpCallResult, email: string): string[] {
  const wanted = email.trim().toLowerCase();
  const ids = new Set<string>();
  const visit = (value: unknown, depth = 0) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    const id = obj.id;
    const matches = Object.entries(obj).some(
      ([key, v]) => typeof v === "string" && /email/i.test(key) && v.trim().toLowerCase() === wanted,
    );
    if (matches && (typeof id === "string" || typeof id === "number")) ids.add(String(id));
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };
  for (const payload of resultPayloads(result)) visit(payload);
  return [...ids];
}

export interface NovaActionInfo {
  uriKey: string;
  name: string;
  allowlisted: boolean | null;
}

/** The actions in a nova_list_actions result. */
export function parseNovaActions(result: McpCallResult): NovaActionInfo[] {
  const out: NovaActionInfo[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 6 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    const obj = value as Record<string, unknown>;
    const uriKey = obj.uriKey ?? obj.uri_key ?? obj.action;
    if (typeof uriKey === "string") {
      const name = typeof obj.name === "string" ? obj.name : uriKey;
      const allowlisted = typeof obj.allowlisted === "boolean" ? obj.allowlisted : null;
      out.push({ uriKey, name, allowlisted });
      return;
    }
    for (const v of Object.values(obj)) visit(v, depth + 1);
  };
  for (const payload of resultPayloads(result)) visit(payload);
  return out;
}

export function findImpersonateAction(actions: NovaActionInfo[]): NovaActionInfo | null {
  return actions.find((a) => /impersonat/i.test(a.uriKey) || /impersonat/i.test(a.name)) ?? null;
}

/** "certificates.dev" for "www.certificates.dev" and "app.certificates.dev". */
export function siteOf(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  return labels.slice(-2).join(".");
}

export interface TargetCheck {
  allowed: string[];
  rejected: { url: string; reason: string }[];
}

/**
 * Target pages must be http(s) and on the same site as the impersonation
 * link: the session only exists there, and it keeps the browser from being
 * pointed anywhere else while signed in as someone.
 */
export function checkTargets(targets: string[], baseUrl: string): TargetCheck {
  const site = siteOf(new URL(baseUrl).hostname);
  const out: TargetCheck = { allowed: [], rejected: [] };
  for (const raw of targets) {
    const value = raw.trim();
    let url: URL;
    try {
      url = value.startsWith("/") ? new URL(value, baseUrl) : new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      out.rejected.push({ url: value, reason: "not a valid URL" });
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      out.rejected.push({ url: value, reason: "only http(s) pages can be captured" });
    } else if (siteOf(url.hostname) !== site) {
      out.rejected.push({ url: value, reason: `not on ${site}, where the impersonated session lives` });
    } else {
      out.allowed.push(url.toString());
    }
  }
  return out;
}

/** The page we ended up on looks like a sign-in screen (the session didn't take). */
export function looksSignedOut(url: string): boolean {
  try {
    return /\/(login|log-in|signin|sign-in|auth\/login|register)(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** HTTP methods the impersonated session may send. Anything else is blocked (read-only). */
export const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
