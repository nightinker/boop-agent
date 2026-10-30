/**
 * Compact uptime formatting for the `uptime` self-inspection tool.
 * Shows days/hours/minutes, drops zero leading units, omits seconds.
 *   30s → "Up <1m", 45m → "Up 45m", 3h12m → "Up 3h 12m", 2d4h5m → "Up 2d 4h 5m"
 */
export function formatUptime(totalSeconds: number): string {
  const secs = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const totalMinutes = Math.floor(secs / 60);
  if (totalMinutes < 1) return "Up <1m";

  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return `Up ${parts.join(" ")}`;
}

/** Seconds the Boop server process has been running. */
export function serverUptimeSeconds(): number {
  return process.uptime();
}
