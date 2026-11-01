import { useCallback, useEffect, useState } from "react";
import { panelCardClass, subtlePanelClass } from "./PanelPrimitives.js";

export interface SecretsStatus {
  supported: boolean;
  message?: string;
  secrets: { name: string; updatedAt: number; backend: "keychain" | "file" }[];
  pending: { name: string; expiresAt: number }[];
}

const POLL_MS = 15_000;

function formatUpdated(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Secret names and status from the Mac's secret store. Values never reach the
 * dashboard; the server only sends names. Delete asks first.
 */
export function SecretsSection({ isDark, initialStatus = null }: { isDark: boolean; initialStatus?: SecretsStatus | null }) {
  const [status, setStatus] = useState<SecretsStatus | null>(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/secrets/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`Secrets status failed (${res.status})`);
      setStatus((await res.json()) as SecretsStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function remove(name: string) {
    if (!window.confirm(`Delete the secret ${name}? Anything that uses it will stop working until it's set again.`)) return;
    setBusy(name);
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(name)}/delete`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Delete failed (${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const muted = isDark ? "text-zinc-400" : "text-zinc-500";
  const label = isDark ? "text-zinc-100" : "text-zinc-900";
  const rowBorder = isDark ? "border-white/10" : "border-zinc-200";

  return (
    <section className={panelCardClass(isDark, "fade-in overflow-hidden")} data-testid="secrets-section">
      <div className="px-4 py-4">
        <div className={`text-sm font-medium ${label}`}>Secrets</div>
        <div className={`text-xs mt-1 leading-relaxed max-w-3xl ${muted}`}>
          API keys and env variables Boop can use, kept in this Mac's Keychain. Only names are shown here; values never
          leave the Mac or pass through chat. To add or change one, ask Boop and open the one-time link it sends.
        </div>
      </div>
      <div className={`border-t px-4 py-3 ${rowBorder}`}>
        {status && !status.supported ? (
          <div className={subtlePanelClass(isDark, `px-3 py-3 text-xs leading-relaxed ${muted}`)}>
            {status.message ?? "Secrets live only on the owner's Mac."}
          </div>
        ) : status && status.secrets.length === 0 && status.pending.length === 0 ? (
          <div className={subtlePanelClass(isDark, `px-3 py-3 text-xs ${muted}`)}>No secrets stored yet.</div>
        ) : (
          <ul className="divide-y divide-zinc-500/10">
            {(status?.secrets ?? []).map((s) => (
              <li key={s.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className={`mono text-[13px] break-all ${label}`}>{s.name}</div>
                  <div className={`text-[11px] ${muted}`}>
                    Set · updated {formatUpdated(s.updatedAt)} · {s.backend === "keychain" ? "Keychain" : "private file"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(s.name)}
                  disabled={busy !== null}
                  className={`shrink-0 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    isDark
                      ? "border-rose-500/30 text-rose-300 hover:bg-rose-500/10"
                      : "border-rose-200 text-rose-700 hover:bg-rose-50"
                  }`}
                >
                  {busy === s.name ? "Deleting…" : "Delete"}
                </button>
              </li>
            ))}
            {(status?.pending ?? []).map((p) => (
              <li key={`pending-${p.name}`} className="py-2">
                <div className={`mono text-[13px] break-all ${label}`}>{p.name}</div>
                <div className={`text-[11px] ${muted}`}>Not set · entry link open until {formatUpdated(p.expiresAt)}</div>
              </li>
            ))}
          </ul>
        )}
        {error && <div className={`mt-2 text-xs ${isDark ? "text-rose-300" : "text-rose-600"}`}>{error}</div>}
      </div>
    </section>
  );
}
