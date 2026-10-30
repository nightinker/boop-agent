import { useCallback, useEffect, useState } from "react";

export const CLAUDE_ACCOUNT_CHANGED_EVENT = "boop:claude-account-changed";

interface ClaudeAccount {
  loggedIn: boolean;
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
}

interface UsageWindow {
  percent: number;
  resetsIn: string | null;
}

interface CswapAccount {
  number: number;
  email: string;
  organizationName: string | null;
  active: boolean;
  needsRelogin: boolean;
  status: "ok" | "relogin_required" | "unavailable" | "unknown";
  usage: { fiveHour: UsageWindow | null; weekly: UsageWindow | null } | null;
}

interface ClaudeAccountResponse {
  account: ClaudeAccount | null;
  accountError: string | null;
  cswap: { available: boolean; activeAccountNumber: number | null; accounts: CswapAccount[] };
  cswapError: string | null;
}

function planLabel(subscriptionType: string | null): string | null {
  if (!subscriptionType) return null;
  return subscriptionType[0]!.toUpperCase() + subscriptionType.slice(1);
}

function orgLabel(email: string, organizationName: string | null): string | null {
  if (!organizationName) return null;
  if (organizationName === `${email}'s Organization`) return "Personal";
  return organizationName;
}

function UsageBar({
  label,
  window,
  isDark,
}: {
  label: string;
  window: UsageWindow;
  isDark: boolean;
}) {
  const percent = Math.min(100, Math.max(0, window.percent));
  const fill = percent >= 90 ? "bg-rose-400" : percent >= 70 ? "bg-amber-400" : "bg-sky-400";
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className={isDark ? "text-zinc-400" : "text-zinc-500"}>{label}</span>
        <span className={isDark ? "text-zinc-400" : "text-zinc-500"}>
          {percent}%{window.resetsIn ? ` · resets in ${window.resetsIn}` : ""}
        </span>
      </div>
      <div className={`mt-1 h-1.5 rounded-full ${isDark ? "bg-white/10" : "bg-zinc-200"}`}>
        <div className={`h-1.5 rounded-full ${fill}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function ClaudeAccountRow({ isDark }: { isDark: boolean }) {
  const [data, setData] = useState<ClaudeAccountResponse | null>(null);
  const [switchingTo, setSwitchingTo] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/claude-account", { cache: "no-store" });
    if (!res.ok) throw new Error(`Claude account fetch failed (${res.status})`);
    setData((await res.json()) as ClaudeAccountResponse);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [load]);

  async function switchTo(account: CswapAccount) {
    setError(null);
    setNotice(null);
    if (account.status !== "ok") {
      setNotice(
        account.status === "relogin_required"
          ? `${account.email}'s saved login has expired. Sign in to it with Claude Code, then run \`cswap add\`.`
          : `cswap can't reach ${account.email} right now. Check it with \`cswap list\`.`,
      );
      return;
    }
    setSwitchingTo(account.number);
    try {
      const res = await fetch("/api/claude-account/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountNumber: account.number }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Switch failed (${res.status})`);
      await load();
      window.dispatchEvent(new Event(CLAUDE_ACCOUNT_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitchingTo(null);
    }
  }

  const account = data?.account ?? null;
  const cswap = data?.cswap;
  const activeEntry = cswap?.accounts.find((entry) => entry.active) ?? null;
  const others = cswap?.accounts.filter((entry) => !entry.active) ?? [];
  const meta = [
    planLabel(account?.subscriptionType ?? null),
    account?.email ? orgLabel(account.email, account.orgName) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const cardBg = isDark
    ? "bg-[#202024] border-white/10 shadow-black/20"
    : "bg-white border-zinc-200 shadow-zinc-200/50";
  const divider = isDark ? "border-white/10" : "border-zinc-200";
  const heading = isDark ? "text-zinc-100" : "text-zinc-900";
  const muted = isDark ? "text-zinc-400" : "text-zinc-500";
  const faint = isDark ? "text-zinc-500" : "text-zinc-400";
  const rowHover = isDark ? "hover:bg-white/5" : "hover:bg-zinc-50";

  return (
    <div className={`overflow-hidden rounded-2xl border shadow-sm fade-in ${cardBg}`}>
      <div className="grid grid-cols-1 md:grid-cols-2">
        <div className={`p-4 md:border-r ${divider}`}>
          <div className={`text-sm font-semibold ${heading}`}>Claude account</div>
          <div className={`mt-3 text-[10px] font-medium uppercase tracking-[0.08em] ${faint}`}>
            In use
          </div>
          {!data ? (
            <div className={`mt-2 text-xs ${muted}`}>Checking…</div>
          ) : !account?.loggedIn ? (
            <div className={`mt-2 text-xs ${muted}`}>
              Claude Code is signed out on this Mac. Run <code>claude</code> to sign in.
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-3">
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  isDark ? "bg-sky-500/15 text-sky-300" : "bg-sky-100 text-sky-700"
                }`}
              >
                {(account.email ?? "?")[0]!.toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className={`truncate text-sm font-semibold ${heading}`}>{account.email}</div>
                {meta && <div className={`truncate text-xs ${muted}`}>{meta}</div>}
              </div>
            </div>
          )}

          {activeEntry?.usage && (activeEntry.usage.fiveHour || activeEntry.usage.weekly) && (
            <div className="mt-4 space-y-2.5">
              {activeEntry.usage.fiveHour && (
                <UsageBar label="5-hour window" window={activeEntry.usage.fiveHour} isDark={isDark} />
              )}
              {activeEntry.usage.weekly && (
                <UsageBar label="Weekly" window={activeEntry.usage.weekly} isDark={isDark} />
              )}
            </div>
          )}

          <div className={`mt-4 text-[11px] leading-relaxed ${faint}`}>
            Boop uses the Claude Code login on this Mac. A switch applies from the next message.
          </div>
        </div>

        <div className="p-4">
          <div className={`text-[10px] font-medium uppercase tracking-[0.08em] ${faint}`}>
            Switch to
          </div>
          {cswap && !cswap.available && (
            <div className={`mt-2 text-xs ${muted}`}>
              Install cswap (claude-swap) to switch accounts from here.
            </div>
          )}
          {cswap?.available && others.length === 0 && (
            <div className={`mt-2 text-xs ${muted}`}>
              No other accounts yet. Sign in to one with Claude Code and run <code>cswap add</code>.
            </div>
          )}
          {others.length > 0 && (
            <div className="mt-1">
              {others.map((entry, index) => {
                const ready = entry.status === "ok";
                const org = orgLabel(entry.email, entry.organizationName);
                return (
                  <button
                    key={entry.number}
                    type="button"
                    onClick={() => switchTo(entry)}
                    disabled={switchingTo !== null}
                    title={ready ? `Switch to ${entry.email}` : "Needs attention before switching"}
                    className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left disabled:opacity-60 ${rowHover} ${
                      index > 0 ? `border-t ${divider}` : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-[13px] ${ready ? heading : faint}`}>
                        {entry.email}
                      </div>
                      {org && <div className={`truncate text-[11px] ${faint}`}>{org}</div>}
                    </div>
                    {entry.status === "relogin_required" && (
                      <span
                        className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] ${
                          isDark ? "bg-amber-500/15 text-amber-300" : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        Login expired
                      </span>
                    )}
                    {(entry.status === "unavailable" || entry.status === "unknown") && (
                      <span
                        className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] ${
                          isDark ? "bg-white/10 text-zinc-400" : "bg-zinc-100 text-zinc-500"
                        }`}
                      >
                        Unavailable
                      </span>
                    )}
                    <span className={`shrink-0 text-xs ${ready ? muted : faint}`} aria-hidden="true">
                      {switchingTo === entry.number ? "…" : "→"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {notice && <div className="mt-2 text-[11px] text-amber-400">{notice}</div>}
          {(error ?? data?.cswapError) && (
            <div className="mt-2 text-[11px] text-rose-400">{error ?? data?.cswapError}</div>
          )}
        </div>
      </div>
    </div>
  );
}
