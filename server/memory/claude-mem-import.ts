/**
 * Turns claude-mem rows (observations, session summaries, user prompts) into
 * archiveRecords. Pure: no database, no network, so it is easy to test and
 * the import script can run it in a dry run without touching Convex.
 *
 * Every text is scrubbed of credentials before it leaves this module.
 */
import { createHash } from "node:crypto";
import { SECRET_PLACEHOLDER, scanForSecrets } from "../secrets/redact.js";

export const SOURCE = "claude-mem";

export type ArchiveKind = "observation" | "summary" | "prompt";

export interface ArchiveRecordInput {
  sourceId: string;
  source: string;
  kind: ArchiveKind;
  project: string;
  title: string;
  content: string;
  type?: string;
  sessionId?: string;
  occurredAt: number;
  contentHash: string;
}

export interface ObservationRow {
  id: number;
  memory_session_id: string | null;
  project: string | null;
  merged_into_project: string | null;
  type: string | null;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at_epoch: number;
}

export interface SummaryRow {
  id: number;
  memory_session_id: string | null;
  project: string | null;
  merged_into_project: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  files_edited: string | null;
  created_at_epoch: number;
}

export interface PromptRow {
  id: number;
  content_session_id: string | null;
  project: string | null;
  prompt_number: number | null;
  prompt_text: string | null;
  created_at_epoch: number;
}

/** Observation types claude-mem itself marks as private; skipped unless asked for. */
export const SENSITIVE_OBSERVATION_TYPES = new Set(["sensitive"]);

const MAX_CONTENT = 30_000;
const MAX_TITLE = 200;

// Credentials the shared scanner does not look for but this history holds:
// lower-case password assignments, bearer headers, passwords inside URLs and
// Convex deploy keys.
const EXTRA_PATTERNS: RegExp[] = [
  /\b(password|passwd|pwd|secret|token|api[_-]?key)(\s*(?<!:)[=:](?!:)\s*)["']?([^\s"',;]{6,})["']?/gi,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi,
  /\b(?:prod|dev|preview|project):[a-z0-9-]+\|[A-Za-z0-9+/=_-]{20,}/g,
];

/**
 * A value after "password:" or "token=" that is a type, a variable or a call
 * rather than a credential: `string`, `$token`, `env('X')`, `config.token`.
 */
function looksLikeCodeNotSecret(value: string): boolean {
  if (value.startsWith("[")) return true;
  if (/^[a-z_]+[?!|]*$/.test(value)) return true;
  if (/^[$@&*]/.test(value)) return true;
  if (/^[A-Za-z_][\w.]*\(/.test(value)) return true;
  if (/^[a-z_]+(\.[a-z_]+)+$/i.test(value)) return true;
  return false;
}

/** Removes anything that looks like a credential. Returns the clean text and how many hits were removed. */
export function scrub(text: string): { text: string; removed: number } {
  if (!text) return { text: "", removed: 0 };
  let removed = 0;
  let out = text;
  for (const re of EXTRA_PATTERNS) {
    out = out.replace(re, (match, name?: string, sep?: string, value?: string) => {
      const isAssignment = typeof name === "string" && typeof sep === "string" && /[=:]/.test(sep);
      if (isAssignment && typeof value === "string" && looksLikeCodeNotSecret(value)) return match;
      removed++;
      if (isAssignment) return `${name}${sep}${SECRET_PLACEHOLDER}`;
      if (typeof name === "string" && /:\/\//.test(name)) return `${name}${SECRET_PLACEHOLDER}@`;
      if (typeof name === "string" && /^(Bearer|Basic)$/.test(name)) return `${name} ${SECRET_PLACEHOLDER}`;
      return SECRET_PLACEHOLDER;
    });
  }
  const scan = scanForSecrets(out);
  if (scan.found) {
    const before = countPlaceholders(out);
    out = scan.redacted;
    removed += Math.max(1, countPlaceholders(out) - before);
  }
  return { text: out, removed };
}

function countPlaceholders(text: string): number {
  return text.split(SECRET_PLACEHOLDER).length - 1;
}

/** claude-mem stores lists as JSON arrays in text columns; tolerate plain text too. */
export function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    // Not JSON: treat as a single entry.
  }
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function hashRecord(record: Omit<ArchiveRecordInput, "contentHash">): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify([
      record.sourceId,
      record.kind,
      record.project,
      record.title,
      record.content,
      record.type ?? "",
      record.sessionId ?? "",
      record.occurredAt,
    ]),
  );
  return h.digest("hex").slice(0, 32);
}

function finish(
  base: Omit<ArchiveRecordInput, "contentHash" | "title" | "content">,
  rawTitle: string,
  rawContent: string,
): { record: ArchiveRecordInput; secretsRemoved: number } {
  const title = scrub(oneLine(rawTitle));
  const content = scrub(rawContent.trim());
  const withoutHash = {
    ...base,
    title: clip(title.text, MAX_TITLE) || "(untitled)",
    content: clip(content.text, MAX_CONTENT),
  };
  return {
    record: { ...withoutHash, contentHash: hashRecord(withoutHash) },
    secretsRemoved: title.removed + content.removed,
  };
}

function projectOf(row: { project: string | null; merged_into_project?: string | null }): string {
  return (row.merged_into_project || row.project || "unknown").trim() || "unknown";
}

function section(label: string, body: string | null | undefined): string {
  const text = (body ?? "").trim();
  return text ? `${label}: ${text}` : "";
}

function listSection(label: string, items: string[]): string {
  return items.length ? `${label}:\n${items.map((i) => `- ${i}`).join("\n")}` : "";
}

function join(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

export function mapObservation(row: ObservationRow) {
  const project = projectOf(row);
  const type = (row.type ?? "observation").trim() || "observation";
  const title = row.title?.trim() || row.subtitle?.trim() || oneLine(row.narrative ?? row.text ?? "").slice(0, 120);
  const content = join([
    `[${project} · ${type}] ${title}`,
    row.subtitle?.trim() && row.subtitle.trim() !== title ? row.subtitle.trim() : "",
    (row.narrative ?? "").trim() || (row.text ?? "").trim(),
    listSection("Facts", parseList(row.facts)),
    listSection("Concepts", parseList(row.concepts)),
    listSection("Files modified", parseList(row.files_modified)),
  ]);
  return finish(
    {
      sourceId: `${SOURCE}:observation:${row.id}`,
      source: SOURCE,
      kind: "observation",
      project,
      type,
      sessionId: row.memory_session_id ?? undefined,
      occurredAt: row.created_at_epoch,
    },
    title,
    content,
  );
}

export function mapSummary(row: SummaryRow) {
  const project = projectOf(row);
  const title = row.request?.trim() || row.completed?.trim() || "Session summary";
  const content = join([
    `[${project} · session summary] ${oneLine(title)}`,
    section("Investigated", row.investigated),
    section("Learned", row.learned),
    section("Completed", row.completed),
    section("Next steps", row.next_steps),
    section("Notes", row.notes),
    listSection("Files edited", parseList(row.files_edited)),
  ]);
  return finish(
    {
      sourceId: `${SOURCE}:summary:${row.id}`,
      source: SOURCE,
      kind: "summary",
      project,
      type: "session-summary",
      sessionId: row.memory_session_id ?? undefined,
      occurredAt: row.created_at_epoch,
    },
    title,
    content,
  );
}

export function mapPrompt(row: PromptRow) {
  const project = projectOf(row);
  const text = (row.prompt_text ?? "").trim();
  return finish(
    {
      sourceId: `${SOURCE}:prompt:${row.id}`,
      source: SOURCE,
      kind: "prompt",
      project,
      type: "user-prompt",
      sessionId: row.content_session_id ?? undefined,
      occurredAt: row.created_at_epoch,
    },
    oneLine(text).slice(0, 120) || "(empty prompt)",
    `[${project} · prompt${row.prompt_number ? ` #${row.prompt_number}` : ""}] ${text}`,
  );
}

/** True when a mapped record has nothing worth searching. */
export function isEmpty(record: ArchiveRecordInput): boolean {
  return record.content.replace(/^\[[^\]]*\]\s*/, "").trim().length === 0;
}
