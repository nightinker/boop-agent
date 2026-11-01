import { hostname } from "node:os";
import { INSTANCE_OFFLINE_AFTER_MS } from "../convex/instanceRules.js";

/**
 * Boop can run in more than one place at once: the owner's Mac (primary) and a
 * Linux server (standby). Every copy checks in through Convex; the online copy
 * with the highest priority is active. Only the active copy answers texts and
 * runs automations, so the owner isn't answered twice and tokens aren't spent
 * twice. When the Mac goes offline the server takes over; when the Mac comes
 * back, the server steps down.
 */

export interface InstanceIdentity {
  instanceId: string;
  label: string;
  platform: string;
  priority: number;
  startedAt: number;
}

export interface InstanceSummary {
  activeInstanceId: string | null;
  instances: {
    instanceId: string;
    label: string;
    platform: string;
    priority: number;
    publicUrl: string | null;
    lastSeenAt: number;
    online: boolean;
  }[];
}

export const CHECK_IN_INTERVAL_MS = 15_000;
// A copy that becomes active while another was online waits this long, so the
// one stepping down (which notices within one check-in) has stopped first.
export const HANDOVER_GRACE_MS = 20_000;

export function instanceIdentity(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  host: string = hostname(),
  now = Date.now(),
): InstanceIdentity {
  const mac = platform === "darwin";
  const shortHost = host.replace(/\.local$/, "");
  const rawPriority = env.BOOP_INSTANCE_PRIORITY?.trim();
  const priority = rawPriority ? Number(rawPriority) : NaN;
  return {
    instanceId: env.BOOP_INSTANCE_ID?.trim() || `${platform}:${shortHost}`,
    label: env.BOOP_INSTANCE_LABEL?.trim() || (mac ? `the owner's Mac (${shortHost})` : `the ${platform} server (${shortHost})`),
    platform,
    // The Mac outranks a server unless told otherwise.
    priority: Number.isFinite(priority) ? priority : mac ? 100 : 10,
    startedAt: now,
  };
}

let current: { identity: InstanceIdentity; active: boolean; summary: InstanceSummary | null } | null = null;

/**
 * Whether this copy should do work that costs tokens or must happen once:
 * answering texts, automations, consolidation, proactive watchers. True before
 * coordination starts (tests, scripts) so nothing silently stops.
 */
export function isActiveInstance(): boolean {
  return current ? current.active : true;
}

export function currentInstance(): { identity: InstanceIdentity; active: boolean; summary: InstanceSummary | null } | null {
  return current;
}

/**
 * Decides, from one check-in result, whether this copy is active now.
 * `activeSeenAt` is when this copy was first reported active in its current
 * stretch; `othersWereOnline` is whether another copy was online then.
 */
export function decideActive(input: {
  summary: InstanceSummary;
  instanceId: string;
  activeSeenAt: number | null;
  othersWereOnline: boolean;
  now: number;
  graceMs?: number;
}): { active: boolean; activeSeenAt: number | null; othersWereOnline: boolean; waitMs: number } {
  const graceMs = input.graceMs ?? HANDOVER_GRACE_MS;
  if (input.summary.activeInstanceId !== input.instanceId) {
    return { active: false, activeSeenAt: null, othersWereOnline: false, waitMs: 0 };
  }
  const othersOnline = input.summary.instances.some((i) => i.online && i.instanceId !== input.instanceId);
  const seenAt = input.activeSeenAt ?? input.now;
  const others = input.activeSeenAt === null ? othersOnline : input.othersWereOnline;
  // Alone: start at once. Taking over from a copy that's still online: wait.
  if (!others) return { active: true, activeSeenAt: seenAt, othersWereOnline: false, waitMs: 0 };
  const waited = input.now - seenAt;
  if (waited >= graceMs) return { active: true, activeSeenAt: seenAt, othersWereOnline: true, waitMs: 0 };
  return { active: false, activeSeenAt: seenAt, othersWereOnline: true, waitMs: graceMs - waited };
}

export interface CoordinatorDeps {
  identity: InstanceIdentity;
  checkIn: (identity: InstanceIdentity & { publicUrl?: string }) => Promise<InstanceSummary>;
  leave: (instanceId: string) => Promise<void>;
  publicUrl?: () => Promise<string | undefined>;
  /** Called when this copy becomes active. `othersOnline`: was another copy still up? */
  onActivate: (info: { othersOnline: boolean; summary: InstanceSummary }) => void | Promise<void>;
  onDeactivate: (info: { summary: InstanceSummary }) => void | Promise<void>;
  intervalMs?: number;
  graceMs?: number;
  /** How long check-ins may fail before this copy stops acting as active. */
  offlineAfterMs?: number;
  now?: () => number;
  log?: Pick<Console, "log" | "warn">;
}

export function startInstanceCoordinator(deps: CoordinatorDeps): { stop: () => Promise<void>; tick: () => Promise<void> } {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  const intervalMs = deps.intervalMs ?? CHECK_IN_INTERVAL_MS;
  current = { identity: deps.identity, active: false, summary: null };
  let activeSeenAt: number | null = null;
  let othersWereOnline = false;
  let lastActiveId: string | null | undefined;
  let inflight: Promise<void> | null = null;
  let stopped = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  // The other copies count this one offline once its check-ins stop for this
  // long, and one of them takes over. So after the same time without a
  // check-in (no network, a laptop dozing with its lid shut), this copy stands
  // by too. Otherwise it would come back still "active" without ever running
  // onActivate, and skip the catching up that does (queued self-builds, texts).
  const offlineAfterMs = deps.offlineAfterMs ?? INSTANCE_OFFLINE_AFTER_MS;
  let lastCheckInAt = now();

  // A check-in already under way is shared, so callers see its result.
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    inflight ??= checkInOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const checkInOnce = async () => {
    try {
      const publicUrl = await deps.publicUrl?.().catch(() => undefined);
      const summary = await deps.checkIn({ ...deps.identity, ...(publicUrl ? { publicUrl } : {}) });
      lastCheckInAt = now();
      if (summary.activeInstanceId !== lastActiveId) {
        const who = summary.instances.find((i) => i.instanceId === summary.activeInstanceId);
        log.log(`[instance] active copy: ${who ? who.label : "none"}`);
        lastActiveId = summary.activeInstanceId;
      }
      const decision = decideActive({
        summary,
        instanceId: deps.identity.instanceId,
        activeSeenAt,
        othersWereOnline,
        now: now(),
        graceMs: deps.graceMs,
      });
      activeSeenAt = decision.activeSeenAt;
      othersWereOnline = decision.othersWereOnline;
      const was = current!.active;
      current = { identity: deps.identity, active: decision.active, summary };
      if (decision.active && !was) {
        log.log(`[instance] this copy (${deps.identity.label}) is now active`);
        await deps.onActivate({ othersOnline: decision.othersWereOnline, summary });
      } else if (!decision.active && was) {
        log.log(`[instance] this copy (${deps.identity.label}) is standing by`);
        await deps.onDeactivate({ summary });
      }
      if (decision.waitMs > 0 && !graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = null;
          void tick();
        }, decision.waitMs + 50);
        graceTimer.unref?.();
      }
    } catch (err) {
      log.warn("[instance] check-in failed", err instanceof Error ? err.message : err);
      if (current?.active && now() - lastCheckInAt > offlineAfterMs) {
        log.log(`[instance] this copy (${deps.identity.label}) lost contact; standing by until it can check in again`);
        const summary = current.summary ?? { activeInstanceId: null, instances: [] };
        current = { identity: deps.identity, active: false, summary };
        activeSeenAt = null;
        await Promise.resolve(deps.onDeactivate({ summary })).catch((e) =>
          log.warn("[instance] stepping down failed", e instanceof Error ? e.message : e),
        );
      }
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (graceTimer) clearTimeout(graceTimer);
      await deps.leave(deps.identity.instanceId).catch(() => undefined);
    },
  };
}

/** Test hook. */
export function resetInstanceState(): void {
  current = null;
}

/**
 * This copy's public address, for Composio's webhook: PUBLIC_URL when it's a
 * real domain, else the URL of a local ngrok tunnel (the Mac's dev setup).
 */
export async function resolvePublicUrl(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const configured = env.PUBLIC_URL?.trim();
  if (configured && !/localhost|127\.0\.0\.1/.test(configured)) return configured.replace(/\/+$/, "");
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { tunnels?: { public_url?: string; proto?: string }[] };
    const tunnel = body.tunnels?.find((t) => t.proto === "https") ?? body.tunnels?.[0];
    return tunnel?.public_url?.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/**
 * The system prompt's note on where Boop runs and how it shares the work, so
 * it doesn't guess (e.g. claim to be on the Mac when it's the server).
 */
export function instancePromptNote(state = current): string {
  if (!state) return "";
  const { identity, active, summary } = state;
  const others = (summary?.instances ?? []).filter((i) => i.instanceId !== identity.instanceId);
  const lines = [
    `Where you run: you are Boop's copy on ${identity.label} (${identity.platform === "darwin" ? "macOS" : identity.platform}). This is a fact; never guess or claim otherwise.`,
  ];
  if (others.length > 0) {
    const describe = others
      .map((o) => `${o.label}: ${o.online ? "online" : `offline (last seen ${new Date(o.lastSeenAt).toISOString()})`}`)
      .join("; ");
    lines.push(
      `Other copies sharing your memory and conversations: ${describe}. The owner's Mac is the primary copy; a server copy only takes over while the Mac is offline, and steps down when it returns. Only one copy is active at a time.`,
    );
    lines.push(
      active
        ? "You are the active copy right now."
        : "You are standing by right now; the active copy handles texts and automations.",
    );
  }
  if (identity.platform !== "darwin") {
    lines.push(
      "Self-builds code and ship on the Mac. If asked for a new build here, start_self_build queues it and the Mac starts it when it's back online; shipping waits for the Mac. Don't suggest editing .env on this server to fix that.",
    );
  }
  return `\n\n${lines.join("\n")}`;
}
