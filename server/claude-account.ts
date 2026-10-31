import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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
  const account = await readAuthStatus(envWithClaudeConfigDir(await activeClaudeConfigDir()));
  accountCache = { at: Date.now(), account };
  return account;
}

/**
 * `claude auth status` exits non-zero when signed out, but still prints the
 * status as JSON. Read it instead of surfacing a bare "Command failed".
 */
async function readAuthStatus(env: Record<string, string> | undefined): Promise<ClaudeAccount> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"], {
      timeout: COMMAND_TIMEOUT_MS,
      ...(env ? { env } : {}),
    });
    return parseClaudeAuthStatus(stdout);
  } catch (err) {
    const stdout = (err as { stdout?: unknown } | null)?.stdout;
    if (typeof stdout === "string" && stdout.trim()) {
      try {
        return parseClaudeAuthStatus(stdout);
      } catch {
        // not JSON: fall through to the original error
      }
    }
    throw err;
  }
}

/** Whether a Claude config dir (~/.claude-work, …) has a working login right now. */
export async function getClaudeAccountForConfigDir(configDir: string): Promise<ClaudeAccount> {
  return readAuthStatus(envWithClaudeConfigDir(configDir));
}

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Where to look for cswap. Boop often runs from the desktop app or launchd,
 * whose PATH lacks ~/.local/bin (where `uv tool install claude-swap` puts
 * it), so the usual install spots are checked after PATH. BOOP_CSWAP_PATH
 * wins when set.
 */
export function cswapCandidates(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string[] {
  const candidates: string[] = [];
  if (env.BOOP_CSWAP_PATH?.trim()) candidates.push(env.BOOP_CSWAP_PATH.trim());
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push(join(dir, "cswap"));
  }
  candidates.push(
    join(home, ".local", "bin", "cswap"),
    "/opt/homebrew/bin/cswap",
    "/usr/local/bin/cswap",
    join(home, ".cargo", "bin", "cswap"),
  );
  return [...new Set(candidates)];
}

/** The cswap executable on this Mac, or null when it isn't installed. */
export async function findCswap(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Promise<string | null> {
  for (const candidate of cswapCandidates(env, home)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here: try the next spot
    }
  }
  return null;
}

export const CSWAP_NOT_FOUND_MESSAGE =
  "cswap isn't installed on this Mac, or Boop can't find it (looked on PATH, ~/.local/bin, /opt/homebrew/bin and /usr/local/bin). Install it with `uv tool install claude-swap`, or set BOOP_CSWAP_PATH to its full path.";

async function runCswap(args: string[], timeout = COMMAND_TIMEOUT_MS) {
  const bin = await findCswap();
  if (!bin) {
    const err = new Error(CSWAP_NOT_FOUND_MESSAGE) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  return execFileAsync(bin, args, { timeout });
}

export async function listCswapAccounts(): Promise<CswapState> {
  try {
    const { stdout } = await runCswap(["list", "--json"]);
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
  if (!state.available) throw new Error(CSWAP_NOT_FOUND_MESSAGE);
  if (!state.accounts.some((account) => account.number === accountNumber)) {
    throw new Error(`cswap has no account ${accountNumber}`);
  }
  await runCswap(["switch", String(accountNumber)]);
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
    const { stdout, stderr } = await runCswap(
      ["run", String(accountNumber), "--", "-p", "Reply with OK", "--model", LOGIN_CHECK_MODEL],
      90_000,
    );
    return { accountNumber, checkedAt, ...classifyLoginCheck(`${stdout}\n${stderr}`, true) };
  } catch (err) {
    const failure = err as { stdout?: string; stderr?: string; message?: string };
    const output = [failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n");
    return { accountNumber, checkedAt, ...classifyLoginCheck(output, false) };
  }
}
