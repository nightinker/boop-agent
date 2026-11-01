/**
 * Commands Boop understands without its AI model. When the model is out of
 * credit, rate-limited or broken, every normal reply fails, including "switch
 * to sonnet", because understanding that sentence needs the same broken
 * model. These short commands are matched with plain rules instead, so the
 * owner can always switch model, runtime or Claude account, or ask what's
 * running, from iMessage. They also save a model call when they're used
 * while everything works.
 *
 * A command only runs when its target is a real model, runtime or account;
 * anything else ("switch to dark mode in my calendar") goes to the model as
 * usual.
 */

export type SwitchResult = { ok: boolean; text: string };

export interface RescueDeps {
  resolveModel: (input: string) => Promise<string | null>;
  isRuntime: (input: string) => boolean;
  /** Names the owner might use for accounts: emails and the name part of each email. */
  accountNames: () => Promise<string[]>;
  switchModel: (input: string) => Promise<SwitchResult>;
  switchRuntime: (input: string) => Promise<SwitchResult>;
  switchAccount: (input: string) => Promise<SwitchResult>;
  status: () => Promise<string>;
}

export type RescueIntent =
  | { kind: "switch"; target: string; accountOnly: boolean }
  | { kind: "status" };

const FILLER = /\b(please|pls|plz|now|thanks|thank you|again|instead)\b/g;

/** Lowercase, drop punctuation and polite filler, squeeze spaces. */
export function normalizeCommand(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”"!?,]/g, " ")
    // Sentence-ending dots only, so emails keep theirs.
    .replace(/\.(?=\s|$)/g, " ")
    .replace(/[’']s\b/g, "")
    .replace(FILLER, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Recognizes the shape of a command; deciding what it targets comes later. */
export function parseRescueIntent(text: string): RescueIntent | null {
  if (text.length > 80) return null;
  const t = normalizeCommand(text);
  if (/^(boop )?status$|^what (model|account) are you (on|using)$|^which (model|account)( are you (on|using))?$/.test(t)) {
    return { kind: "status" };
  }
  const account =
    t.match(/^(?:switch|change|swap|move)(?: the)? (?:claude )?account (?:to|over to) (.+)$/) ??
    t.match(/^(?:switch|change|swap|move|go)(?: over| back)? to (.+?)(?: claude)? account$/) ??
    t.match(/^use (.+?)(?: claude)? account$/) ??
    t.match(/^use(?: the)? account (.+)$/);
  if (account) return { kind: "switch", target: account[1]!.trim(), accountOnly: true };
  const general =
    t.match(/^(?:switch|change|swap|move|go)(?: over| back)? to (.+)$/) ??
    t.match(/^use (.+)$/) ??
    t.match(/^(?:switch|change)(?: the)? model to (.+)$/);
  if (general) {
    const target = general[1]!.replace(/^(the )/, "").replace(/ (model|runtime)$/, "").trim();
    return target ? { kind: "switch", target, accountOnly: false } : null;
  }
  return null;
}

function matchesAccount(target: string, names: string[]): boolean {
  const t = target.toLowerCase();
  return names.some((name) => {
    const n = name.toLowerCase();
    return n === t || n.split("@")[0] === t;
  });
}

/**
 * Runs a model-free command if the message is one, and returns the reply.
 * Null means "not a command here": hand the message to the model.
 */
export async function tryRescueCommand(text: string, deps: RescueDeps): Promise<string | null> {
  const intent = parseRescueIntent(text);
  if (!intent) return null;
  if (intent.kind === "status") return deps.status();

  const { target } = intent;
  if (!intent.accountOnly) {
    if (await deps.resolveModel(target)) return (await deps.switchModel(target)).text;
    if (deps.isRuntime(target)) return (await deps.switchRuntime(target)).text;
  }
  const names = await deps.accountNames().catch(() => [] as string[]);
  if (intent.accountOnly || matchesAccount(target, names)) {
    return (await deps.switchAccount(target)).text;
  }
  return null;
}

/**
 * What to tell the owner when the model couldn't answer: the commands that
 * still work, naming the other accounts so they can just copy one.
 */
export function recoveryHint(input: { reason: "limit" | "error"; otherAccounts: string[]; model?: string }): string {
  const what =
    input.reason === "limit"
      ? `I've hit the usage/spend limit${input.model ? ` on ${input.model}` : ""}, so I can't handle that right now.`
      : `Sorry, I hit an error${input.model ? ` with ${input.model}` : ""} processing that.`;
  const options: string[] = [];
  for (const name of input.otherAccounts.slice(0, 3)) options.push(`"switch to ${name}"`);
  options.push(`"switch to sonnet"`);
  return `${what} These work even now: ${options.join(", ")}, or "status". Then send your message again.`;
}
