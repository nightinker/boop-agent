/**
 * Pure helpers for Boop's skills: naming, targeted patches, the advisory lint
 * and the index the agents see. No I/O here so it can be tested directly.
 */

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 300;
const OVERSIZED_BODY_CHARS = 24_000;
const INDEX_LIMIT = 60;

export interface SkillSummary {
  name: string;
  description: string;
}

export function validateSkillName(name: string): string | null {
  if (!name) return "A skill needs a name.";
  if (name.length > MAX_NAME_LENGTH) return `Skill names are at most ${MAX_NAME_LENGTH} characters.`;
  if (!SKILL_NAME_PATTERN.test(name)) {
    return "Skill names are lowercase words joined by hyphens, like send-weekly-invoices.";
  }
  return null;
}

export function validateDescription(description: string): string | null {
  const trimmed = description.trim();
  if (!trimmed) return "A skill needs a one-line description of when to use it.";
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return `Keep the description under ${MAX_DESCRIPTION_LENGTH} characters; detail goes in the body.`;
  }
  return null;
}

/** Replace exactly one occurrence, so a patch can never land somewhere unintended. */
export function applyPatch(
  body: string,
  oldString: string,
  newString: string,
): { body: string } | { error: string } {
  if (!oldString) return { error: "old_string is empty; use action=rewrite to replace the whole body." };
  const first = body.indexOf(oldString);
  if (first === -1) {
    return { error: "old_string was not found in the skill. Call skill_view again and copy the text exactly." };
  }
  if (body.indexOf(oldString, first + oldString.length) !== -1) {
    return { error: "old_string appears more than once. Include more surrounding text so it matches one place." };
  }
  return { body: body.slice(0, first) + newString + body.slice(first + oldString.length) };
}

/**
 * Advisory only: these warn in the tool result and never block a write. They
 * keep skills shaped as lessons rather than logs, as Hermes's linter does.
 */
export function lintSkill(body: string): string[] {
  const warnings: string[] = [];
  if (body.length > OVERSIZED_BODY_CHARS) {
    warnings.push(
      `The body is ${body.length} characters; skill_view loads all of it, so trim it to the rules that matter.`,
    );
  }
  const references = body.match(/(?:#\d{2,}|PR\s*\d+|issue\s*\d+)/gi) ?? [];
  if (references.length >= 4) {
    warnings.push(
      "It reads like an incident log (many PR/issue numbers). State the rule and why, not the story.",
    );
  }
  if (!/^##\s/m.test(body)) {
    warnings.push("Add sections such as ## When to use, ## Steps, ## Pitfalls, ## Check it worked.");
  }
  return warnings;
}

export function formatSkillIndex(skills: SkillSummary[]): string {
  if (skills.length === 0) {
    return "No skills saved yet. When you work out a repeatable way to do a class of task, save it with skill_manage.";
  }
  const shown = skills.slice(0, INDEX_LIMIT);
  const lines = shown.map((skill) => `- ${skill.name}: ${skill.description}`);
  if (skills.length > shown.length) {
    lines.push(`- …and ${skills.length - shown.length} more (call skill_list).`);
  }
  return lines.join("\n");
}

export const NO_DESCRIPTION = "(no description)";

/** First non-blank line of a description, or a placeholder when there is none. */
export function firstLineDescription(description: unknown): string {
  if (typeof description !== "string") return NO_DESCRIPTION;
  const line = description
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? NO_DESCRIPTION;
}

/**
 * The {name, description} list the dispatcher's list_skills tool returns.
 * Tolerates malformed rows: a missing/non-array result is "no skills", rows
 * without a usable string name are skipped, and a missing or non-string
 * description becomes the placeholder.
 */
export function summarizeSkillsForListing(skills: unknown): SkillSummary[] {
  if (!Array.isArray(skills)) return [];
  const out: SkillSummary[] = [];
  for (const skill of skills) {
    if (!skill || typeof skill !== "object") continue;
    const { name, description } = skill as { name?: unknown; description?: unknown };
    if (typeof name !== "string" || !name.trim()) continue;
    out.push({ name: name.trim(), description: firstLineDescription(description) });
  }
  return out;
}
