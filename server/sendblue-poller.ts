import { inboundFromSendblue, type InboundInput, type InboundQueue } from "./inbound-queue.js";

/**
 * Sendblue sometimes accepts a text and never calls the webhook. Every minute
 * this asks Sendblue for recent inbound texts and queues any Boop never got.
 * The queue dedupes on Sendblue's message handle, so texts the webhook
 * already delivered are skipped.
 */

const API_URL = "https://api.sendblue.com/api/v2/messages";
const DEFAULT_INTERVAL_MS = 60_000;
// Texts older than this are left alone, so a fresh install or a long outage
// doesn't answer a backlog of stale messages.
const DEFAULT_LOOKBACK_MS = 30 * 60_000;
// Give the webhook this long to deliver a text before the poll counts it.
const WEBHOOK_GRACE_MS = 20_000;
const PAGE_SIZE = 25;

export function pickMissedTexts(
  rows: unknown[],
  opts: { now: number; lookbackMs: number; graceMs?: number },
): InboundInput[] {
  const grace = opts.graceMs ?? WEBHOOK_GRACE_MS;
  const picked: InboundInput[] = [];
  for (const row of rows) {
    const input = inboundFromSendblue(row, "poll", opts.now);
    // Without Sendblue's handle there's no way to tell it was already answered.
    if (!input || input.handle.startsWith("local:")) continue;
    const age = opts.now - input.receivedAt;
    if (age < grace || age > opts.lookbackMs) continue;
    picked.push(input);
  }
  // Oldest first, so a conversation's texts queue in the order they were sent.
  return picked.sort((a, b) => a.receivedAt - b.receivedAt);
}

export async function pollSendblueOnce(deps: {
  queue: Pick<InboundQueue, "enqueue">;
  apiKey: string;
  apiSecret: string;
  lookbackMs?: number;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${API_URL}?limit=${PAGE_SIZE}&order_direction=desc&is_outbound=false`;
  const res = await fetchImpl(url, {
    headers: { "sb-api-key-id": deps.apiKey, "sb-api-secret-key": deps.apiSecret },
  });
  if (!res.ok) throw new Error(`Sendblue messages HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  const rows = Array.isArray(body.data) ? body.data : [];
  const missed = pickMissedTexts(rows, {
    now: deps.now ?? Date.now(),
    lookbackMs: deps.lookbackMs ?? DEFAULT_LOOKBACK_MS,
  });
  let caught = 0;
  for (const input of missed) {
    if (await deps.queue.enqueue(input)) caught++;
  }
  return caught;
}

export function startSendbluePoller(queue: InboundQueue): () => void {
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  const intervalMs = Number(process.env.SENDBLUE_POLL_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const lookbackMs = Number(process.env.SENDBLUE_POLL_LOOKBACK_MS ?? DEFAULT_LOOKBACK_MS);
  if (!apiKey || !apiSecret || !Number.isFinite(intervalMs) || intervalMs <= 0) return () => undefined;

  let running = false;
  let lastError = "";
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const caught = await pollSendblueOnce({ queue, apiKey, apiSecret, lookbackMs });
      if (caught) console.log(`[sendblue-poll] caught ${caught} text(s) the webhook never delivered`);
      lastError = "";
      // Also picks up anything left waiting, e.g. after a dropped status update.
      await queue.drainAll();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log once per distinct failure, not every minute.
      if (message !== lastError) console.warn(`[sendblue-poll] ${message}`);
      lastError = message;
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
