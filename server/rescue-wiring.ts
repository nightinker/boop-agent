import { accountSyncMode, followSharedAccount, publishCurrentAccount, type AccountSyncDeps } from "./account-sync.js";
import { getClaudeAccount, listCswapAccounts, switchCswapAccount } from "./claude-account.js";
import {
  clearClaudeProfile,
  clearClaudeProfileCache,
  listClaudeProfiles,
  readSharedAccount,
  recordSharedAccount,
  setClaudeProfile,
} from "./claude-profiles.js";
import { getRuntimeConfig, resolveModelInput, resolveRuntimeInput } from "./runtime-config.js";
import type { RescueDeps } from "./rescue-commands.js";
import { switchClaudeAccount, switchModel, switchRuntime } from "./self-tools.js";

/** The real switches behind the model-free commands. */

interface KnownAccount {
  email: string;
  active: boolean;
}

async function knownAccounts(): Promise<KnownAccount[]> {
  const accounts: KnownAccount[] = [];
  const cswap = await listCswapAccounts().catch(() => null);
  for (const a of cswap?.accounts ?? []) accounts.push({ email: a.email, active: a.active });
  const profiles = await listClaudeProfiles().catch(() => null);
  for (const p of profiles?.profiles ?? []) {
    if (p.email && !accounts.some((a) => a.email === p.email)) {
      accounts.push({ email: p.email, active: profiles?.active?.label === p.label });
    }
  }
  return accounts;
}

const nameOf = (email: string) => email.split("@")[0]!;

/** Short names ("bob") of the Claude accounts Boop could switch to. */
export async function otherAccountNames(): Promise<string[]> {
  const accounts = await knownAccounts().catch(() => []);
  return accounts.filter((a) => !a.active).map((a) => nameOf(a.email));
}

export function rescueDeps(conversationId: string): RescueDeps {
  return {
    resolveModel: async (input) => resolveModelInput(input, (await getRuntimeConfig()).runtime),
    isRuntime: (input) => resolveRuntimeInput(input) !== null,
    accountNames: async () => (await knownAccounts()).flatMap((a) => [a.email, nameOf(a.email)]),
    switchModel,
    switchRuntime,
    switchAccount: (input) => switchClaudeAccount(input, conversationId),
    status: async () => {
      const config = await getRuntimeConfig();
      const account = config.runtime === "claude" ? await getClaudeAccount().catch(() => null) : null;
      const others = await otherAccountNames();
      return [
        `Running ${config.runtime} with ${config.model}${account?.email ? ` on ${account.email}` : ""}.`,
        others.length ? `Other accounts: ${others.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
    },
  };
}

/** The account this copy uses now: a chosen config dir, else the main login. */
async function currentAccountEmail(): Promise<string | null> {
  const { savedLabel, active } = await listClaudeProfiles();
  if (savedLabel && active && !active.isDefault) return active.email;
  return (await getClaudeAccount()).email;
}

const accountSyncDeps: AccountSyncDeps = {
  readShared: readSharedAccount,
  currentEmail: currentAccountEmail,
  cswapAccounts: async () => (await listCswapAccounts()).accounts,
  // cswap switches the main login, so drop any config-dir choice first.
  switchCswap: async (accountNumber) => {
    await clearClaudeProfile();
    clearClaudeProfileCache();
    await switchCswapAccount(accountNumber);
  },
  profiles: async () => (await listClaudeProfiles()).profiles,
  useProfile: async (label) => {
    const profile = (await listClaudeProfiles()).profiles.find((p) => p.label === label);
    if (profile) await setClaudeProfile(profile);
  },
};

/**
 * Before a turn: the Mac shares the account it's on; a server switches to the
 * same one. Errors never block the turn.
 */
export async function syncClaudeAccount(): Promise<void> {
  const mode = accountSyncMode();
  try {
    if (mode === "publish") {
      await publishCurrentAccount({ ...accountSyncDeps, record: recordSharedAccount });
    } else if (mode === "follow") {
      await followSharedAccount(accountSyncDeps);
    }
  } catch (err) {
    console.warn("[account-sync] couldn't sync the Claude account", err instanceof Error ? err.message : err);
  }
}
