/**
 * The Mac app pushes Convex functions every time it starts; a server copy
 * doesn't. So a server that updated itself while the Mac was off can run
 * code a step ahead of the deployed functions, and Convex rejects any
 * argument it doesn't know yet. This sends the call with the new arguments
 * and, if Convex says they're unknown, once more without them, so the
 * feature degrades instead of the call failing.
 */
export async function withOptionalArgs<T, A extends Record<string, unknown>>(
  call: (args: A) => Promise<T>,
  args: A,
  optionalKeys: (keyof A)[],
): Promise<T> {
  try {
    return await call(args);
  } catch (err) {
    if (!isUnknownArgError(err) || !optionalKeys.some((key) => args[key] !== undefined)) throw err;
    const older = { ...args };
    for (const key of optionalKeys) delete older[key];
    return await call(older);
  }
}

export function isUnknownArgError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ArgumentValidationError|extra field|not in the validator/i.test(message);
}
