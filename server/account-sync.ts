/**
 * Keeps every copy of Boop (the Mac, a server) on the same Claude account.
 * When the owner switches accounts anywhere, the account's email is saved in
 * Convex. Before each turn, a copy whose own account differs switches to its
 * local login for that email: a cswap account first, then a ~/.claude-<name>
 * config dir. Only the email is shared, never credentials; each machine signs
 * in to each account itself. If a copy has no login for that email it keeps
 * its current account and logs it once.
 */

export const SHARED_ACCOUNT_KEY = "claude_account_email";

export interface AccountSyncDeps {
  readShared: () => Promise<string | null>;
  currentEmail: () => Promise<string | null>;
  /** cswap accounts on this machine. */
  cswapAccounts: () => Promise<{ number: number; email: string; active: boolean; needsRelogin: boolean }[]>;
  switchCswap: (accountNumber: number) => Promise<void>;
  /** ~/.claude-<name> logins on this machine. */
  profiles: () => Promise<{ label: string; email: string | null }[]>;
  useProfile: (label: string) => Promise<void>;
  log?: Pick<Console, "log" | "warn">;
}

export type SyncResult =
  | { status: "none" }
  | { status: "same" }
  | { status: "switched"; email: string; via: "cswap" | "profile" }
  | { status: "unavailable"; email: string };

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export type SyncMode = "publish" | "follow" | "off";

/**
 * The Mac is the source of truth: it publishes whatever account it's on,
 * including switches made outside Boop (e.g. `cswap switch` in Terminal).
 * Other copies follow. BOOP_ACCOUNT_SYNC overrides.
 */
export function accountSyncMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SyncMode {
  const configured = env.BOOP_ACCOUNT_SYNC?.trim().toLowerCase();
  if (configured === "publish" || configured === "follow" || configured === "off") return configured;
  return platform === "darwin" ? "publish" : "follow";
}

/** On the source-of-truth copy: share the account it's using now. */
export async function publishCurrentAccount(deps: {
  readShared: () => Promise<string | null>;
  currentEmail: () => Promise<string | null>;
  record: (email: string) => Promise<void>;
}): Promise<boolean> {
  const current = await deps.currentEmail();
  if (!current || same(current, await deps.readShared())) return false;
  await deps.record(current);
  return true;
}

let lastUnavailable: string | null = null;

export async function followSharedAccount(deps: AccountSyncDeps): Promise<SyncResult> {
  const log = deps.log ?? console;
  const wanted = (await deps.readShared())?.trim();
  if (!wanted) return { status: "none" };
  if (same(await deps.currentEmail(), wanted)) return { status: "same" };

  const cswap = (await deps.cswapAccounts().catch(() => [])).find((a) => same(a.email, wanted));
  if (cswap && !cswap.needsRelogin) {
    await deps.switchCswap(cswap.number);
    log.log(`[account-sync] switched to ${wanted} (cswap) to match the other copy`);
    lastUnavailable = null;
    return { status: "switched", email: wanted, via: "cswap" };
  }
  const profile = (await deps.profiles().catch(() => [])).find((p) => same(p.email, wanted));
  if (profile) {
    await deps.useProfile(profile.label);
    log.log(`[account-sync] switched to ${wanted} (${profile.label}) to match the other copy`);
    lastUnavailable = null;
    return { status: "switched", email: wanted, via: "profile" };
  }
  if (lastUnavailable !== wanted) {
    log.warn(
      `[account-sync] the other copy uses ${wanted}, but this machine has no working login for it; keeping the current account. Sign in to it here and add it with \`cswap add\`.`,
    );
    lastUnavailable = wanted;
  }
  return { status: "unavailable", email: wanted };
}

/** Test hook. */
export function resetAccountSyncState(): void {
  lastUnavailable = null;
}
