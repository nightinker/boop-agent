/**
 * The Mac app pushes Convex functions every time it starts; a server copy
 * doesn't unless told to. So a copy can run code a step ahead of the deployed
 * functions, and Convex rejects any argument it doesn't know yet. This sends
 * the call with the new arguments and, if Convex says they're unknown, once
 * more without them, so the feature degrades instead of the call failing.
 *
 * A rejection is remembered per function until this process restarts (an
 * update restarts it), so later calls go out once, without the new arguments,
 * instead of twice.
 */

const downgraded = new Map<string, Set<string>>();

export interface OptionalArgsOptions {
  /**
   * false: don't send the call without the new arguments; throw an unknown-
   * argument error instead, so the caller can do something safer (e.g. a
   * server leaving a build to the Mac rather than starting one it can't mark
   * as its own).
   */
  fallback?: boolean;
}

export async function withOptionalArgs<T, A extends object>(
  name: string,
  call: (args: A) => Promise<T>,
  args: A,
  optionalKeys: (keyof A & string)[],
  opts: OptionalArgsOptions = {},
): Promise<T> {
  const fallback = opts.fallback ?? true;
  const used = optionalKeys.filter((key) => (args as Record<string, unknown>)[key] !== undefined);
  const known = downgraded.get(name);
  if (known && used.some((key) => known.has(key))) {
    if (!fallback) throw new UnknownArgError(name, used);
    return call(strip(args, optionalKeys));
  }
  try {
    return await call(args);
  } catch (err) {
    if (!isUnknownArgError(err) || used.length === 0) throw err;
    downgraded.set(name, new Set([...(known ?? []), ...used]));
    if (!fallback) throw err;
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
    super(`ArgumentValidationError: the deployed ${name} doesn't accept ${keys.join(", ")} yet`);
  }
}

export function isUnknownArgError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ArgumentValidationError|extra field|not in the validator/i.test(message);
}

/** Test hook. */
export function resetCompatState(): void {
  downgraded.clear();
}
