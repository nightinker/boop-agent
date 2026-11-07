import { resolve } from "node:path";

/**
 * `git fetch origin main` for the self-build, one at a time per repository and
 * retried when git loses a ref-lock race.
 *
 * Several parts of the self-build fetch the same checkout: setting up a build,
 * shipping one, and the catch-up check. Git updates `refs/remotes/origin/main`
 * with a compare-and-swap, so when two fetches overlap the second fails with
 * "cannot lock ref 'refs/remotes/origin/main': is at X but expected Y" and the
 * build is marked failed (seen 7 Nov 2026). Fetches inside this process wait
 * for each other; a fetch from outside it (a terminal, another agent working in
 * the same checkout) can still collide, so a lock failure is retried after a
 * short pause: by then the other fetch has moved the ref and the retry agrees.
 */

export type Shell = { ok: boolean; output: string };
export type Runner = (
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
) => Promise<Shell>;

/** Git's wording when another process held or moved a ref or lock file mid-fetch. */
const LOCK_RACE = [
  /cannot lock ref/i,
  /unable to update local ref/i,
  /Unable to create '[^']*\.lock': File exists/i,
];

export function isRefLockRace(output: string): boolean {
  return LOCK_RACE.some((pattern) => pattern.test(output));
}

const queues = new Map<string, Promise<unknown>>();

/**
 * Fetch `branch` from `origin` in `cwd`, after any fetch of the same repository
 * this process already started, retrying up to `retries` times on a lock race.
 * Resolves with the last attempt's result; the caller decides whether to throw.
 */
export function fetchOriginSerialized(
  run: Runner,
  cwd: string,
  {
    branch = "main",
    retries = 3,
    delayMs = 750,
    sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
  }: { branch?: string; retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Shell> {
  const key = resolve(cwd);
  const attempt = async (): Promise<Shell> => {
    let result = await run("git", ["fetch", "origin", branch], { cwd });
    for (let tries = 0; !result.ok && tries < retries && isRefLockRace(result.output); tries++) {
      await sleep(delayMs * (tries + 1));
      result = await run("git", ["fetch", "origin", branch], { cwd });
    }
    return result;
  };
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(attempt, attempt);
  queues.set(key, next);
  // Forget the queue once it drains, so the map does not grow with old repositories.
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}
