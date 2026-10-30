import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { McpServerIcon } from "@hugeicons/core-free-icons";

export interface AccountConnection {
  slug: string;
  name: string;
  active: number;
  total: number;
  custom: boolean;
  logoUrl: string | null;
}

interface AccountConnectionsResponse {
  available: boolean;
  connections: AccountConnection[];
}

export type PersonalFilter = "all" | "custom" | "apps" | "attention";

const COLLAPSED_COUNT = 12;

/** Composio's own screen for adding connections, including custom MCP servers. */
export const COMPOSIO_CONNECT_URL = "https://connect.composio.dev";

export function usePersonalComposio() {
  const [data, setData] = useState<AccountConnectionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/composio/account-connections${fresh ? "?fresh=1" : ""}`, {
        cache: "no-store",
      });
      const body = (await res.json()) as AccountConnectionsResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, error, loading, refresh };
}

export function matchesPersonalFilter(connection: AccountConnection, filter: PersonalFilter) {
  if (filter === "custom") return connection.custom;
  if (filter === "apps") return !connection.custom;
  if (filter === "attention") return connection.active === 0;
  return true;
}

/**
 * Connections in the user's personal Composio account (the composio CLI login).
 * Boop reaches them through the composio-account integration; they are added
 * and removed in Composio, and show up here on the next refresh.
 */
export function PersonalComposioSection({
  isDark,
  connections,
  error,
  filter,
  query,
}: {
  isDark: boolean;
  connections: AccountConnection[];
  error: string | null;
  filter: PersonalFilter;
  query: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (error) {
    return <div className="text-xs text-rose-400">Couldn't read your Composio account: {error}</div>;
  }

  const needle = query.trim().toLowerCase();
  const filtered = connections.filter(
    (c) =>
      matchesPersonalFilter(c, filter) &&
      (!needle || c.name.toLowerCase().includes(needle) || c.slug.includes(needle)),
  );
  if (filtered.length === 0) return null;

  const showAll = expanded || needle.length > 0 || filter !== "all";
  const visible = showAll ? filtered : filtered.slice(0, COLLAPSED_COUNT);
  const hidden = filtered.length - visible.length;
  const activeCount = filtered.filter((c) => c.active > 0).length;

  const label = isDark ? "text-zinc-400" : "text-zinc-500";
  const hint = isDark ? "text-zinc-600" : "text-zinc-400";
  const card = isDark ? "bg-[#202024] border-white/10" : "bg-white border-zinc-200";
  const title = isDark ? "text-zinc-100" : "text-zinc-900";
  const iconTile = isDark ? "bg-white/5 text-zinc-300" : "bg-zinc-100 text-zinc-600";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${label}`}>
          Your Composio account
        </h3>
        <span className={`text-[10px] ${hint}`}>
          {activeCount} of {filtered.length} active · via the composio CLI login
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((connection) => {
          const ready = connection.active > 0;
          return (
            <div
              key={connection.slug}
              className={`flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 ${card}`}
              title={connection.slug}
            >
              {connection.logoUrl && !connection.custom ? (
                <img
                  src={connection.logoUrl}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-lg object-contain"
                />
              ) : connection.custom ? (
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconTile}`}
                  aria-hidden="true"
                >
                  <HugeiconsIcon icon={McpServerIcon} size={18} />
                </div>
              ) : (
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${iconTile}`}
                  aria-hidden="true"
                >
                  {connection.name[0]}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className={`truncate text-[13px] font-medium ${title}`}>{connection.name}</div>
                <div className={`text-[11px] ${hint}`}>
                  {connection.custom ? "Custom MCP" : "Composio app"}
                </div>
              </div>
              {ready ? (
                <span
                  className={`shrink-0 text-[11px] font-medium ${
                    isDark ? "text-emerald-400" : "text-emerald-600"
                  }`}
                >
                  {connection.active > 1 ? `${connection.active} active` : "Active"}
                </span>
              ) : (
                <a
                  href={COMPOSIO_CONNECT_URL}
                  target="_blank"
                  rel="noreferrer"
                  className={`shrink-0 text-[11px] font-medium underline-offset-2 hover:underline ${
                    isDark ? "text-amber-300" : "text-amber-700"
                  }`}
                >
                  Reconnect
                </a>
              )}
            </div>
          );
        })}
      </div>
      {(hidden > 0 || (expanded && !needle && filter === "all")) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={`mt-2 rounded-lg px-2 py-1 text-xs ${label} ${
            isDark ? "hover:bg-white/5" : "hover:bg-zinc-100"
          }`}
        >
          {expanded ? "Show fewer" : `Show all ${filtered.length}`}
        </button>
      )}
    </div>
  );
}
