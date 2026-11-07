/**
 * The Mac app pushes Convex functions every time it starts; a server copy
 * doesn't unless told to. So a copy can run code a step ahead of the deployed
 * functions, and Convex rejects any argument it doesn't know yet. This sends
 * the call with the new arguments and, if Convex says they're unknown, once
 * more without them, so the feature degrades instead of the call failing.
 *
 * A rejection is remembered per function for a few minutes, so calls in that
 * window go out once, without the new arguments, instead of twice. After that
 * the full call is tried again: the Mac may have pushed newer functions since.
 */

/** How long a rejected argument is remembered before the full call is tried again. */
export const DOWNGRADE_TTL_MS = 10 * 60_000;

const downgraded = new Map<string, { keys: Set<string>; until: number }>();

export interface OptionalArgsOptions {
  /**
   * false: don't send the call without the new arguments; throw an unknown-
   * argument error instead, so the caller can do something safer (e.g. a
   * server leaving a build to the Mac rather than starting one it can't mark
   * as its own).
   */
  fallback?: boolean;
  /** Clock, for tests. */
  now?: () => number;
}

export async function withOptionalArgs<T, A extends object>(
  name: string,
  call: (args: A) => Promise<T>,
  args: A,
  optionalKeys: (keyof A & string)[],
  opts: OptionalArgsOptions = {},
): Promise<T> {
  const fallback = opts.fallback ?? true;
  const now = opts.now ?? Date.now;
  const used = optionalKeys.filter((key) => (args as Record<string, unknown>)[key] !== undefined);
  const entry = downgraded.get(name);
  const known = entry && now() < entry.until ? entry.keys : undefined;
  if (entry && !known) downgraded.delete(name);
  if (known && used.some((key) => known.has(key))) {
    if (!fallback) throw new UnknownArgError(name, used);
    return call(strip(args, optionalKeys));
  }
  try {
    return await call(args);
  } catch (err) {
    // Only an error about one of the optional arguments: anything else (a
    // missing field, a wrong type) is a real bug and must surface as is.
    const rejected = rejectedKeys(err, used);
    if (rejected.length === 0) throw err;
    downgraded.set(name, { keys: new Set([...(known ?? []), ...rejected]), until: now() + DOWNGRADE_TTL_MS });
    if (!fallback) throw new UnknownArgError(name, rejected);
    return await call(strip(args, optionalKeys));
  }
}

function strip<A extends object>(args: A, keys: (keyof A)[]): A {
  const older = { ...args };
  for (const key of keys) delete older[key];
  return older;
}

export class UnknownArgError extends Error {
  constructor(name: string, keys: string[]) {
    super(`The deployed ${name} doesn't accept ${keys.join(", ")} yet`);
    this.name = "UnknownArgError";
  }
}

// Convex: "Object contains extra field `runner` that is not in the validator."
const EXTRA_FIELD = /extra field|not in the validator/i;

/** True when Convex rejected an argument it doesn't know (not any validation error). */
export function isUnknownArgError(err: unknown): boolean {
  if (err instanceof UnknownArgError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return EXTRA_FIELD.test(message);
}

/** Which of `keys` an unknown-argument error names. */
function rejectedKeys(err: unknown, keys: string[]): string[] {
  if (!isUnknownArgError(err)) return [];
  const message = err instanceof Error ? err.message : String(err);
  return keys.filter((key) => message.includes(`\`${key}\``) || message.includes(`"${key}"`));
}

/** Test hook. */
export function resetCompatState(): void {
  downgraded.clear();
}
