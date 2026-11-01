/**
 * Secret redaction. Two jobs:
 *
 * 1. Known values: anything stored in the secret store is scrubbed from tool
 *    output, agent logs and replies, together with its common encodings
 *    (base64, base64url, URL-encoded, hex, JSON-escaped).
 * 2. Unknown values: a text from the owner that looks like a credential (AWS,
 *    Cloudflare, GitHub, Slack, OpenAI/Anthropic keys, private keys, long
 *    random tokens) is caught before it is saved anywhere.
 *
 * Everything here is synchronous and pure except the module-level cache of
 * known values, which the store refreshes whenever a secret changes.
 */

/** Values shorter than this are not redacted: they'd mangle ordinary output. */
export const MIN_REDACT_LENGTH = 4;

export interface KnownSecret {
  name: string;
  value: string;
}

/** Every string form a value is likely to show up in. */
export function secretVariants(value: string): string[] {
  const variants = new Set<string>();
  const add = (v: string) => {
    if (v.length >= MIN_REDACT_LENGTH) variants.add(v);
  };
  add(value);
  const trimmed = value.trim();
  add(trimmed);
  const b64 = Buffer.from(trimmed, "utf8").toString("base64");
  add(b64);
  add(b64.replace(/=+$/, ""));
  add(Buffer.from(trimmed, "utf8").toString("base64url"));
  add(encodeURIComponent(trimmed));
  // URL encoding with lowercase hex digits, as some tools emit it.
  add(encodeURIComponent(trimmed).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  add(trimmed.replace(/[^A-Za-z0-9\-_.~]/g, (c) => (c === " " ? "+" : encodeURIComponent(c))));
  add(Buffer.from(trimmed, "utf8").toString("hex"));
  add(JSON.stringify(trimmed).slice(1, -1));
  return [...variants];
}

/** Replaces every known value (and its encodings) with [REDACTED:NAME]. */
export function redactValues(text: string, secrets: KnownSecret[]): string {
  if (!text || secrets.length === 0) return text;
  const pairs: { needle: string; name: string }[] = [];
  for (const s of secrets) {
    if (!s.value || s.value.trim().length < MIN_REDACT_LENGTH) continue;
    for (const v of secretVariants(s.value)) pairs.push({ needle: v, name: s.name });
  }
  // Longest first, so an encoding that contains the raw value is caught whole.
  pairs.sort((a, b) => b.needle.length - a.needle.length);
  let out = text;
  for (const { needle, name } of pairs) {
    if (out.includes(needle)) out = out.split(needle).join(`[REDACTED:${name}]`);
  }
  return out;
}

// --- cache of known values -------------------------------------------------

let known: KnownSecret[] = [];

/** Called by the store whenever the set of secrets changes. */
export function setKnownSecrets(secrets: KnownSecret[]): void {
  known = secrets.filter((s) => s.value && s.value.trim().length >= MIN_REDACT_LENGTH);
}

export function knownSecretCount(): number {
  return known.length;
}

/** Scrubs every value in the secret store (as last loaded) from `text`. */
export function redactSecrets(text: string): string {
  return redactValues(text, known);
}

/** Like redactSecrets, for any JSON-able value (tool inputs in logs). */
export function redactSecretsDeep<T>(value: T): T {
  if (known.length === 0 || value === null || value === undefined) return value;
  if (typeof value === "string") return redactSecrets(value) as T;
  try {
    const json = JSON.stringify(value);
    const redacted = redactSecrets(json);
    return redacted === json ? value : (JSON.parse(redacted) as T);
  } catch {
    return value;
  }
}

// --- detecting secrets the owner pasted into chat ---------------------------

export const SECRET_PLACEHOLDER = "[possible secret removed]";

interface SecretPattern {
  kind: string;
  re: RegExp;
}

// Each pattern is global so every match is replaced.
const SECRET_PATTERNS: SecretPattern[] = [
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "API key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "Composio/Sendblue-style key", re: /\b(?:ak|sb)_[A-Za-z0-9]{24,}\b/g },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // KEY=value / KEY: value where the name says it's a credential.
  {
    kind: "credential assignment",
    re: /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|ACCESS_KEY_ID)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"']{8,})["']?/g,
  },
];

const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;

/**
 * A word that is long and random-looking: 64 hex chars (an R2/S3 secret), or
 * 32+ chars of mixed upper case, lower case and digits (a Cloudflare token,
 * most base64 secrets). Git SHAs (40 hex), UUIDs and plain words don't match.
 */
export function isRandomLookingToken(word: string): boolean {
  const w = word.replace(/^[("'`<[{]+|[)"'`>\]},.;:!?]+$/g, "");
  if (URLISH.test(w) || (w.includes("/") && w.includes("."))) return false;
  if (/^[0-9a-f]{64}$/i.test(w)) return true;
  if (w.length < 32 || w.length > 512) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(w)) return false;
  return /[A-Z]/.test(w) && /[a-z]/.test(w) && /[0-9]/.test(w);
}

export interface SecretScan {
  found: boolean;
  /** What kind of credential each hit looked like, deduped. */
  kinds: string[];
  /** The text with every hit replaced by SECRET_PLACEHOLDER. */
  redacted: string;
}

/** Looks for anything in a chat message that is probably a credential. */
export function scanForSecrets(text: string): SecretScan {
  if (!text) return { found: false, kinds: [], redacted: text };
  const kinds = new Set<string>();
  let redacted = text;
  for (const { kind, re } of SECRET_PATTERNS) {
    redacted = redacted.replace(re, (match, name?: string, value?: string) => {
      kinds.add(kind);
      if (kind === "credential assignment" && name && value) return `${name}=${SECRET_PLACEHOLDER}`;
      return SECRET_PLACEHOLDER;
    });
  }
  redacted = redacted.replace(/\S+/g, (word) => {
    if (word.includes(SECRET_PLACEHOLDER)) return word;
    if (!isRandomLookingToken(word)) return word;
    kinds.add("long random token");
    return SECRET_PLACEHOLDER;
  });
  // A value the store already knows is a secret too.
  const known2 = redactSecrets(redacted);
  if (known2 !== redacted) {
    kinds.add("stored secret");
    redacted = known2;
  }
  return { found: kinds.size > 0, kinds: [...kinds], redacted };
}

/** True when a message (as stored) had a secret removed on the way in. */
export function hadSecretRemoved(text: string): boolean {
  return text.includes(SECRET_PLACEHOLDER) || /\[REDACTED:[A-Z][A-Z0-9_]*\]/.test(text);
}

export const PASTED_SECRET_REPLY =
  "🔐 That looked like a password or API key, so I didn't keep it: Boop removed it from its chat history and won't save it to memory. " +
  "It still went over iMessage, so treat it as exposed and rotate it (make a new one, revoke the old one). " +
  "Then ask me to set it up securely and I'll send you a private link to enter it on your Mac. It never passes through chat.";
