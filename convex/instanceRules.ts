// Which running copy of Boop is active. Pure, so convex/instances.ts and the
// tests share one rule.

/** A copy that hasn't checked in for this long is treated as offline. */
export const INSTANCE_OFFLINE_AFTER_MS = 45_000;

export interface InstanceRow {
  instanceId: string;
  label: string;
  platform: string;
  priority: number;
  publicUrl?: string;
  commit?: string;
  startedAt: number;
  lastSeenAt: number;
}

export function isOnline(row: Pick<InstanceRow, "lastSeenAt">, now: number): boolean {
  return now - row.lastSeenAt < INSTANCE_OFFLINE_AFTER_MS;
}

/**
 * The active copy: the online one with the highest priority (the owner's Mac
 * outranks a server). Ties go to the copy that started first, so a restart
 * doesn't steal the role from a peer that's already working.
 */
export function pickActive(rows: InstanceRow[], now: number): InstanceRow | null {
  const online = rows.filter((row) => isOnline(row, now));
  online.sort(
    (a, b) =>
      b.priority - a.priority || a.startedAt - b.startedAt || a.instanceId.localeCompare(b.instanceId),
  );
  return online[0] ?? null;
}
