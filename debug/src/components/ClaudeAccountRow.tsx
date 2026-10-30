import { useCallback, useEffect, useState } from "react";

export const CLAUDE_ACCOUNT_CHANGED_EVENT = "boop:claude-account-changed";

interface ClaudeAccount {
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
}

interface CswapAccount {
  number: number;
  email: string;
  organizationName: string | null;
  active: boolean;
  needsRelogin: boolean;
}

interface ClaudeAccountResponse {
  account: ClaudeAccount | null;
  accountError: string | null;
  cswap: { available: boolean; activeAccountNumber: number | null; accounts: CswapAccount[] };
  cswapError: string | null;
}

function accountSummary(account: ClaudeAccount | null): string {
  if (!account) return "Couldn't read the Claude Code login on this Mac.";
  if (!account.loggedIn) return "Claude Code is signed out on this Mac. Run `claude` to sign in.";
  return [account.email, account.orgName, account.subscriptionType]
    .filter(Boolean)
    .join(" · ");
}

export function ClaudeAccountRow({ isDark }: { isDark: boolean }) {
  const [data, setData] = useState<ClaudeAccountResponse | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/claude-account", { cache: "no-store" });
    if (!res.ok) throw new Error(`Claude account fetch failed (${res.status})`);
    const next = (await res.json()) as ClaudeAccountResponse;
    setData(next);
    setSelected(next.cswap.activeAccountNumber ?? next.cswap.accounts[0]?.number ?? null);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  async function switchAccount() {
    if (selected === null) return;
    setSwitching(true);
    setError(null);
    try {
      const res = await fetch("/api/claude-account/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountNumber: selected }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Switch failed (${res.status})`);
      await load();
      window.dispatchEvent(new Event(CLAUDE_ACCOUNT_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  }

  const cardBg = isDark
    ? "bg-[#202024] border-white/10 shadow-black/20"
    : "bg-white border-zinc-200 shadow-zinc-200/50";
  const inputBg = isDark
    ? "bg-[#17171a] border-white/10 text-zinc-100"
    : "bg-zinc-50 border-zinc-200 text-zinc-900";
  const muted = isDark ? "text-zinc-400" : "text-zinc-500";
  const cswap = data?.cswap;
  const selectedAccount = cswap?.accounts.find((account) => account.number === selected);

  return (
    <div className={`rounded-2xl border p-4 shadow-sm fade-in ${cardBg}`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-8">
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>
            Claude account
          </div>
          <div className={`mt-1 max-w-[34rem] text-xs leading-relaxed ${muted}`}>
            The Claude provider uses whichever account Claude Code is signed in to on this Mac.
            Switching applies from the next message.
          </div>
          <div
            className={`mt-2 text-xs font-medium mono ${isDark ? "text-zinc-200" : "text-zinc-800"}`}
          >
            {data ? accountSummary(data.account) : "Checking…"}
          </div>
        </div>

        <div className="flex w-full min-w-0 flex-col items-end gap-2 lg:w-[360px] lg:shrink-0">
          {cswap && !cswap.available && (
            <div className={`text-[11px] ${muted}`}>
              Install cswap (claude-swap) to switch accounts from here.
            </div>
          )}
          {cswap?.available && (
            <div className="flex w-full gap-2">
              <select
                value={selected ?? ""}
                disabled={switching || cswap.accounts.length === 0}
                onChange={(e) => setSelected(Number(e.target.value))}
                className={`w-0 min-w-0 flex-1 rounded-xl border px-3 py-2 text-xs outline-none transition-colors focus:border-zinc-400 ${inputBg}`}
              >
                {cswap.accounts.map((account) => (
                  <option key={account.number} value={account.number}>
                    {account.number}: {account.email}
                    {account.active ? " (active)" : ""}
                    {account.needsRelogin ? " · re-login needed" : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={switchAccount}
                disabled={switching || selected === null || selected === cswap.activeAccountNumber}
                className={`shrink-0 rounded-xl border px-3 py-2 text-xs font-medium disabled:opacity-50 ${
                  isDark
                    ? "border-white/10 bg-zinc-100 text-zinc-950"
                    : "border-zinc-200 bg-zinc-900 text-white"
                }`}
              >
                {switching ? "Switching…" : "Switch"}
              </button>
            </div>
          )}
          {selectedAccount?.needsRelogin && !selectedAccount.active && (
            <div className="text-[11px] text-amber-400">
              cswap's saved login for this account has expired. Sign in to it with Claude Code and
              run `cswap add` before switching, or Boop will be signed out.
            </div>
          )}
          {(error ?? data?.cswapError) && (
            <div className="text-[11px] text-rose-400">{error ?? data?.cswapError}</div>
          )}
        </div>
      </div>
    </div>
  );
}
