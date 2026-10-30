import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activeClaudeConfigDir, envWithClaudeConfigDir } from "./claude-profiles.js";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 15_000;
const ACCOUNT_CACHE_MS = 30_000;

/**
 * The Claude runtime has no login of its own: the Agent SDK runs Claude Code,
 * which uses whichever account is signed in on this Mac. These helpers read
 * that account, and switch it through cswap (claude-swap) when installed.
 */
export interface ClaudeAccount {
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  authMethod: string | null;
}

export interface UsageWindow {
  percent: number;
  resetsIn: string | null;
}

export interface CswapAccount {
  number: number;
  email: string;
  organizationName: string | null;
  active: boolean;
  needsRelogin: boolean;
  status: "ok" | "relogin_required" | "unavailable" | "unknown";
  usage: { fiveHour: UsageWindow | null; weekly: UsageWindow | null } | null;
}

export interface CswapState {
  available: boolean;
  activeAccountNumber: number | null;
  accounts: CswapAccount[];
}

export function parseClaudeAuthStatus(stdout: string): ClaudeAccount {
  const data = JSON.parse(stdout) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    loggedIn: data.loggedIn === true,
    email: text(data.email),
    orgName: text(data.orgName),
    subscriptionType: text(data.subscriptionType),
    authMethod: text(data.authMethod),
  };
}

function parseUsageWindow(value: unknown): UsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const window = value as { pct?: unknown; countdown?: unknown };
  if (typeof window.pct !== "number") return null;
  return {
    percent: Math.round(window.pct),
    resetsIn: typeof window.countdown === "string" ? window.countdown : null,
  };
}

function parseStatus(value: unknown): CswapAccount["status"] {
  return value === "ok" || value === "relogin_required" || value === "unavailable"
    ? value
    : "unknown";
}

export function parseCswapList(stdout: string): CswapState {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) throw new Error("cswap list returned no JSON");
  const data = JSON.parse(stdout.slice(jsonStart)) as {
    activeAccountNumber?: unknown;
    accounts?: Array<Record<string, unknown>>;
  };
  const accounts = (data.accounts ?? []).map((account) => ({
    number: Number(account.number),
    email: String(account.email ?? ""),
    organizationName:
      typeof account.organizationName === "string" ? account.organizationName : null,
    active: account.active === true,
    needsRelogin: account.usageStatus === "relogin_required",
    status: parseStatus(account.usageStatus),
    usage:
      account.usage && typeof account.usage === "object"
        ? {
            fiveHour: parseUsageWindow((account.usage as Record<string, unknown>).fiveHour),
            weekly: parseUsageWindow((account.usage as Record<string, unknown>).sevenDay),
          }
        : null,
  }));
  return {
    available: true,
    activeAccountNumber:
      typeof data.activeAccountNumber === "number" ? data.activeAccountNumber : null,
    accounts: accounts.filter((account) => Number.isInteger(account.number) && account.email),
  };
}

let accountCache: { at: number; account: ClaudeAccount } | null = null;

export async function getClaudeAccount(options: { fresh?: boolean } = {}): Promise<ClaudeAccount> {
  if (!options.fresh && accountCache && Date.now() - accountCache.at < ACCOUNT_CACHE_MS) {
    return accountCache.account;
  }
  const env = envWithClaudeConfigDir(await activeClaudeConfigDir());
  const { stdout } = await execFileAsync("claude", ["auth", "status"], {
    timeout: COMMAND_TIMEOUT_MS,
    ...(env ? { env } : {}),
  });
  const account = parseClaudeAuthStatus(stdout);
  accountCache = { at: Date.now(), account };
  return account;
}

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function listCswapAccounts(): Promise<CswapState> {
  try {
    const { stdout } = await execFileAsync("cswap", ["list", "--json"], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    return parseCswapList(stdout);
  } catch (err) {
    if (isMissingBinary(err)) {
      return { available: false, activeAccountNumber: null, accounts: [] };
    }
    throw err;
  }
}

export async function switchCswapAccount(accountNumber: number): Promise<ClaudeAccount> {
  const state = await listCswapAccounts();
  if (!state.available) throw new Error("cswap is not installed on this Mac");
  if (!state.accounts.some((account) => account.number === accountNumber)) {
    throw new Error(`cswap has no account ${accountNumber}`);
  }
  await execFileAsync("cswap", ["switch", String(accountNumber)], {
    timeout: COMMAND_TIMEOUT_MS,
  });
  return getClaudeAccount({ fresh: true });
}

export interface LoginCheck {
  accountNumber: number;
  result: "works" | "expired" | "limited" | "error";
  detail: string | null;
  checkedAt: string;
}

const LOGIN_CHECK_MODEL = "claude-haiku-5-5";

export function classifyLoginCheck(output: string, exitedCleanly: boolean): {
  result: LoginCheck["result"];
  detail: string | null;
} {
  const firstLine = output.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
  if (/failed to authenticate|oauth|log ?in again|not logged in|invalid_grant/i.test(output)) {
    return { result: "expired", detail: firstLine };
  }
  if (/hit your (weekly|5-hour|usage) limit|usage limit|rate limit/i.test(output)) {
    return { result: "limited", detail: firstLine };
  }
  return exitedCleanly ? { result: "works", detail: null } : { result: "error", detail: firstLine };
}

/**
 * cswap marks a saved login dead after one failed refresh and never retries,
 * so its "re-login needed" can be months stale. `claude auth status` doesn't
 * help: it reads the saved token without testing it. The only real proof is a
 * request, so this sends one short message on the cheapest model as that
 * account, in an isolated `cswap run` that leaves Boop's login alone.
 */
export async function checkCswapLogin(accountNumber: number): Promise<LoginCheck> {
  const checkedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await execFileAsync(
      "cswap",
      ["run", String(accountNumber), "--", "-p", "Reply with OK", "--model", LOGIN_CHECK_MODEL],
      { timeout: 90_000 },
    );
    return { accountNumber, checkedAt, ...classifyLoginCheck(`${stdout}\n${stderr}`, true) };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    const output = [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n");
    return { accountNumber, checkedAt, ...classifyLoginCheck(output, false) };
  }
}
