import { useCallback, useEffect, useState } from "react";
import {
  formatBuildIds,
  wakeLockHolderPhrase,
  wakeLockSourceLabel,
  type WakeLockSource,
} from "../../../server/keep-awake-labels.js";

export interface KeepAwakeStatus {
  supported: boolean;
  enabled: boolean;
  activeCopy: boolean;
  active: boolean;
  /** The owner's toggle is asking for the wake lock. */
  userHold: boolean;
  /** A self-build in progress is asking for it. */
  buildHold: boolean;
  buildIds: string[];
  heldBy: WakeLockSource | null;
  state: "unsupported" | "disabled" | "standby" | "starting" | "active" | "stopped";
  since: number | null;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  command: string;
  caveat: string;
  /** Why this Mac is flagged for a bad network, from /network (added here). */
  network?: NetworkStatus | null;
}

export interface NetworkStatus {
  degraded: boolean;
  lastSource: string | null;
  probesPassed: number;
  lastProbeFailures: string[];
}

const POLL_MS = 10_000;

/** Polls the server's keep-awake status; `setEnabled` saves the setting and applies it now. */
export function useKeepAwake() {
  const [status, setStatus] = useState<KeepAwakeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [res, net] = await Promise.all([
        fetch("/api/keep-awake", { cache: "no-store" }),
        fetch("/api/network", { cache: "no-store" }).catch(() => null),
      ]);
      if (!res.ok) throw new Error(`Keep-awake status failed (${res.status})`);
      const network = net?.ok ? ((await net.json().catch(() => null)) as NetworkStatus | null) : null;
      setStatus({ ...((await res.json()) as KeepAwakeStatus), network });
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
      setStatus((prev) => ({ ...(body as KeepAwakeStatus), network: prev?.network ?? null }));
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
    case "active": {
      const since = formatSince(status.since);
      return `${wakeLockSourceLabel(status) ?? "Awake"}${since ? ` · since ${since}` : ""}`;
    }
    case "starting": {
      const who = wakeLockHolderPhrase(status);
      return status.lastError
        ? `Restarting caffeinate${who ? ` ${who}` : ""} (${status.lastError})`
        : `Starting caffeinate${who ? ` ${who}` : ""}…`;
    }
    case "standby": {
      const net = status.network;
      if (net?.degraded) {
        const failing = net.lastProbeFailures.length ? `${net.lastProbeFailures.join(", ")} failing` : `${net.probesPassed}/3 checks passed`;
        return `Standing by: network flagged, server is answering (${failing})`;
      }
      return "Standing by: another copy is active, so this Mac may sleep";
    }
    case "disabled":
      return "Off: the Mac may sleep";
    case "stopped":
      return "Released: Boop is shutting down";
    case "unsupported":
      return "Only available on macOS";
  }
}

/** Short label for the dashboard pill, naming who holds the lock. */
export function keepAwakePillLabel(status: KeepAwakeStatus): string {
  if (status.state !== "active") return keepAwakeLabel(status);
  const builds = formatBuildIds(status.buildIds ?? []);
  switch (status.heldBy) {
    case "both":
      return `Awake: you + self-build agent${builds ? ` ${builds}` : ""}`;
    case "build":
      return `Awake: self-build agent${builds ? ` ${builds}` : ""}`;
    case "user":
      return "Awake: you turned this on";
    default:
      return keepAwakeLabel(status);
  }
}

export function keepAwakeTone(status: KeepAwakeStatus): "emerald" | "amber" | "slate" {
  if (status.state === "active") return "emerald";
  if (status.state === "starting") return "amber";
  return "slate";
}
