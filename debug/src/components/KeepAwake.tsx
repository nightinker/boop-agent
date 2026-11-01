import { useCallback, useEffect, useState } from "react";

export interface KeepAwakeStatus {
  supported: boolean;
  enabled: boolean;
  activeCopy: boolean;
  active: boolean;
  state: "unsupported" | "disabled" | "standby" | "starting" | "active" | "stopped";
  since: number | null;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  command: string;
  caveat: string;
}

const POLL_MS = 10_000;

/** Polls the server's keep-awake status; `setEnabled` saves the setting and applies it now. */
export function useKeepAwake() {
  const [status, setStatus] = useState<KeepAwakeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keep-awake", { cache: "no-store" });
      if (!res.ok) throw new Error(`Keep-awake status failed (${res.status})`);
      setStatus((await res.json()) as KeepAwakeStatus);
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

  const setEnabled = useCallback(async (enabled: boolean) => {
    try {
      const res = await fetch("/api/keep-awake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Keep-awake update failed (${res.status})`);
      setStatus(body as KeepAwakeStatus);
      setError(null);
      // caffeinate starts asynchronously; refresh shortly to show its pid.
      setTimeout(() => void load(), 1_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  return { status, error, setEnabled };
}

export function formatSince(since: number | null): string {
  if (!since) return "";
  const d = new Date(since);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** One-line description of the current state, for the settings row and the pill. */
export function keepAwakeLabel(status: KeepAwakeStatus): string {
  switch (status.state) {
    case "active":
      return `Keeping Mac awake since ${formatSince(status.since)}`;
    case "starting":
      return status.lastError ? `Restarting caffeinate (${status.lastError})` : "Starting caffeinate…";
    case "standby":
      return "Standing by: another copy is active, so this Mac may sleep";
    case "disabled":
      return "Off: the Mac may sleep";
    case "stopped":
      return "Released: Boop is shutting down";
    case "unsupported":
      return "Only available on macOS";
  }
}

export function keepAwakeTone(status: KeepAwakeStatus): "emerald" | "amber" | "slate" {
  if (status.state === "active") return "emerald";
  if (status.state === "starting") return "amber";
  return "slate";
}
