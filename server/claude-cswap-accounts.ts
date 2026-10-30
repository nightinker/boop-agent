import {
  CSWAP_NOT_FOUND_MESSAGE,
  type CswapAccount,
  type CswapState,
  type LoginCheck,
} from "./claude-account.js";

/**
 * Chat-facing helpers for the Claude accounts cswap (claude-swap) manages.
 *
 * cswap keeps each saved login itself (in ~/.claude-swap-backup and the
 * Keychain). `cswap switch <num>` swaps which one is this Mac's main Claude
 * login, the same thing the owner does for the Claude desktop app. Boop then
 * runs on that main login (no CLAUDE_CONFIG_DIR override), and because every
 * Claude run starts a fresh Claude Code process, the switch applies from the
 * next turn without a restart. Boop only ever sees numbers, emails and org
 * names here: never tokens.
 */

/** What Boop learned from `cswap list`: the accounts, or why there are none. */
export type CswapLookup =
  | { ok: true; state: CswapState }
  | { ok: false; error: string };

export type CswapMatch =
  | { kind: "match"; account: CswapAccount }
  | { kind: "ambiguous"; accounts: CswapAccount[] }
  | { kind: "none" };

const NUMBER_INPUT = /^(?:cswap|account|slot|acct)?\s*#?\s*(\d+)$/;

/**
 * Match what the owner typed ("8", "cswap 8", "globex", an email) against
 * cswap's accounts: slot number, exact email, exact org name, email name,
 * then a unique partial match on the email or org name.
 */
export function resolveCswapInput(input: string, accounts: CswapAccount[]): CswapMatch {
  const wanted = input.trim().toLowerCase();
  if (!wanted) return { kind: "none" };
  const asNumber = NUMBER_INPUT.exec(wanted);
  if (asNumber) {
    const account = accounts.find((a) => a.number === Number(asNumber[1]));
    return account ? { kind: "match", account } : { kind: "none" };
  }
  const email = (a: CswapAccount) => a.email.toLowerCase();
  const org = (a: CswapAccount) => a.organizationName?.toLowerCase() ?? "";
  const matchers: Array<(a: CswapAccount) => boolean> = [
    (a) => email(a) === wanted,
    (a) => org(a) === wanted,
    (a) => email(a).split("@")[0] === wanted,
  ];
  if (wanted.length >= 3) matchers.push((a) => email(a).includes(wanted) || org(a).includes(wanted));
  for (const matches of matchers) {
    const candidates = accounts.filter(matches);
    if (candidates.length === 1) return { kind: "match", account: candidates[0] };
    if (candidates.length > 1) return { kind: "ambiguous", accounts: candidates };
  }
  return { kind: "none" };
}

export function describeCswapAccount(account: CswapAccount): string {
  const who = account.organizationName ? `${account.email} (${account.organizationName})` : account.email;
  return `cswap ${account.number} — ${who}`;
}

/** What the owner runs in Terminal to give cswap a fresh login for this account. */
export function cswapReloginInstructions(account: CswapAccount): string {
  return (
    `To fix it, on the Mac run \`claude\` in Terminal, type \`/login\` and sign in as ${account.email} in the browser, ` +
    "then run `cswap add` to save that login to cswap. Then ask me to switch again. " +
    "Never send a password, token or login code here."
  );
}

function statusNote(account: CswapAccount): string {
  if (account.status === "relogin_required") return " — needs a fresh login";
  const usage = account.usage;
  if (!usage) return "";
  const parts = [
    usage.fiveHour ? `5h ${usage.fiveHour.percent}%` : null,
    usage.weekly ? `week ${usage.weekly.percent}%` : null,
  ].filter(Boolean);
  return parts.length ? ` — used ${parts.join(", ")}` : "";
}

/**
 * The cswap part of list_claude_accounts. `boopOnMainLogin` is false when a
 * config-dir account is chosen, since then cswap's active login isn't the
 * one Boop uses.
 */
export function formatCswapSection(lookup: CswapLookup, boopOnMainLogin: boolean): string {
  if (!lookup.ok) return `cswap accounts: ${lookup.error}`;
  const { state } = lookup;
  if (!state.available) return `cswap accounts: ${CSWAP_NOT_FOUND_MESSAGE}`;
  if (state.accounts.length === 0) {
    return "cswap accounts: cswap is installed but manages no accounts yet. Sign in with `claude` in Terminal, then run `cswap add`.";
  }
  const lines = state.accounts.map((a) => {
    const marker = a.active ? (boopOnMainLogin ? "• (active) " : "• (main login) ") : "• ";
    return `${marker}${describeCswapAccount(a)}${statusNote(a)}`;
  });
  return [
    "cswap accounts (switching one changes this Mac's main Claude login, like `cswap switch`):",
    ...lines,
  ].join("\n");
}

/** Whether a login check means switching is safe. A usage limit still means the login works. */
export function loginCheckAllowsSwitch(check: LoginCheck): boolean {
  return check.result === "works" || check.result === "limited";
}

export interface CswapSwitchDeps {
  /** Send one tiny request as that account in an isolated `cswap run`. */
  checkLogin: (accountNumber: number) => Promise<LoginCheck>;
  /** `cswap switch <num>`. */
  switchAccount: (accountNumber: number) => Promise<unknown>;
  /** Drop any config-dir choice so Boop runs on the main login. */
  useMainLogin: () => Promise<void>;
  /** `claude auth status` on the main login, after the switch. */
  readMainLogin: () => Promise<{ loggedIn: boolean; email: string | null } | null>;
}

/**
 * Swap Boop (and this Mac's main Claude login) to a cswap account. A login
 * cswap flags as dead is tested first, since that flag can be stale; if it
 * really is dead, nothing changes and the owner gets the Terminal steps.
 */
export async function switchToCswapAccount(
  target: CswapAccount,
  boopOnMainLogin: boolean,
  deps: CswapSwitchDeps,
): Promise<{ ok: boolean; text: string }> {
  if (target.active && boopOnMainLogin) {
    return { ok: true, text: `Boop is already using the ${describeCswapAccount(target)} account.` };
  }
  const lines: string[] = [];
  if (target.needsRelogin && !target.active) {
    const check = await deps.checkLogin(target.number);
    if (!loginCheckAllowsSwitch(check)) {
      const why = check.result === "expired" ? "its saved login has expired" : "its saved login didn't work";
      return {
        ok: false,
        text: `Didn't switch to ${describeCswapAccount(target)}: ${why}${check.detail ? ` (${check.detail.slice(0, 160)})` : ""}. ${cswapReloginInstructions(target)}`,
      };
    }
    lines.push("cswap had flagged this login as needing a fresh sign-in, but a test request worked, so I went ahead.");
  }
  if (!target.active) {
    try {
      await deps.switchAccount(target.number);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        text: `cswap couldn't switch to ${describeCswapAccount(target)}: ${message.split("\n")[0].slice(0, 200)}. Nothing was changed.`,
      };
    }
  }
  await deps.useMainLogin();
  lines.unshift(
    `Claude account set to ${describeCswapAccount(target)} via cswap. Boop uses it from the next turn on; no restart needed. ` +
      "This also changed this Mac's main Claude login (same as running `cswap switch` yourself).",
  );
  const login = await deps.readMainLogin().catch(() => null);
  if (login && (!login.loggedIn || (login.email && login.email.toLowerCase() !== target.email.toLowerCase()))) {
    lines.push(`Heads up: Claude Code doesn't report ${target.email} as signed in. ${cswapReloginInstructions(target)}`);
  }
  return { ok: true, text: lines.join("\n") };
}
