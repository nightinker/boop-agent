// Webhook-driven Slack watcher. Composio's Slack triggers deliver every
// channel message and DM; this keeps only the ones that mention the user or
// are DMs to them, waits a moment so a burst of follow-ups reads as one
// message, then either texts the user now (urgent) or saves it for the next
// digest. Messages the user writes themselves mark earlier mentions in the
// same conversation as answered, so the digest only lists what still waits.
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { boopUserId, ensureTrigger, getComposio, listConnectedToolkits } from "./composio.js";
import { ensureWebhookSubscription } from "./composio-webhook.js";
import { notifyConversation } from "./notify.js";
import { normalizeProactivePhone } from "./proactive-email.js";
import { getRuntimeConfig } from "./runtime-config.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { describeUserNow, getUserTimezone } from "./timezone-config.js";

export const CHANNEL_TRIGGER = "SLACK_CHANNEL_MESSAGE_RECEIVED";
export const DM_TRIGGER = "SLACK_DIRECT_MESSAGE_RECEIVED";
export const SETTING_SLACK_ENABLED = "slack_watch_enabled";
export const SETTING_DIGEST_TIMES = "slack_digest_times";
const SETTING_DIGEST_LAST = "slack_digest_last";
export const DEFAULT_DIGEST_TIMES = "11:00,15:00,18:00";
const CLASSIFIER_MODEL = process.env.BOOP_CLASSIFIER_MODEL ?? "claude-haiku-5-5";
const BURST_WINDOW_MS = Number(process.env.BOOP_SLACK_BURST_MS ?? 60_000);
const DIGEST_MAX_ITEMS = 12;

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

export interface SlackMessage {
  channel: string;
  ts: string;
  threadTs?: string;
  user?: string;
  botId?: string;
  subtype?: string;
  text: string;
  channelType?: string;
}

export interface SlackIdentity {
  userId: string;
  teamUrl: string;
}

export type SlackDecision =
  | { action: "ignore" }
  | { action: "mine" }
  | { action: "consider"; kind: "dm" | "mention" };

const IGNORED_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "bot_message",
  "group_join",
  "group_leave",
]);

export function normalizeSlackPayload(triggerSlug: string, payload: Record<string, unknown>): SlackMessage | null {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const channel = str(payload.channel);
  const ts = str(payload.ts);
  if (!channel || !ts) return null;
  return {
    channel,
    ts,
    threadTs: str(payload.thread_ts),
    user: str(payload.user),
    botId: str(payload.bot_id),
    subtype: str(payload.subtype),
    text: str(payload.text) ?? "",
    channelType: str(payload.channel_type) ?? (triggerSlug === DM_TRIGGER ? "im" : undefined),
  };
}

export function mentionsUser(text: string, userId: string): boolean {
  return new RegExp(`<@${userId}(\\|[^>]*)?>`).test(text);
}

export function decideSlackMessage(message: SlackMessage, me: string): SlackDecision {
  if (message.subtype && IGNORED_SUBTYPES.has(message.subtype)) return { action: "ignore" };
  if (message.user === me) return { action: "mine" };
  if (message.botId || !message.user) return { action: "ignore" };
  if (message.channelType === "im") return { action: "consider", kind: "dm" };
  if (mentionsUser(message.text, me)) return { action: "consider", kind: "mention" };
  return { action: "ignore" };
}

export function slackPermalink(teamUrl: string, message: Pick<SlackMessage, "channel" | "ts" | "threadTs">): string {
  const base = `${teamUrl.replace(/\/$/, "")}/archives/${message.channel}/p${message.ts.replace(".", "")}`;
  return message.threadTs && message.threadTs !== message.ts
    ? `${base}?thread_ts=${message.threadTs}&cid=${message.channel}`
    : base;
}

/** Slack markup to plain text, with user ids swapped for names. */
export function plainSlackText(text: string, names: Map<string, string>): string {
  return text
    .replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export function parseDigestTimes(raw: string | null | undefined): string[] {
  const times = (raw ?? DEFAULT_DIGEST_TIMES)
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t))
    .map((t) => t.padStart(5, "0"));
  return [...new Set(times)].sort();
}

/**
 * The digest slot that is due now, if any: the latest of today's times that
 * has passed and has not been sent. `today` is YYYY-MM-DD and `nowHm` HH:MM,
 * both in the user's timezone; `lastSent` is "YYYY-MM-DD HH:MM".
 */
export function dueDigestSlot(times: string[], today: string, nowHm: string, lastSent: string | null): string | null {
  const passed = times.filter((t) => t <= nowHm);
  if (passed.length === 0) return null;
  const slot = `${today} ${passed[passed.length - 1]}`;
  return lastSent !== null && lastSent >= slot ? null : slot;
}

export interface DigestItem {
  summary: string;
  permalink: string;
  urgent: boolean;
  notifiedAt?: number;
}

export function formatDigest(items: DigestItem[]): string | null {
  if (items.length === 0) return null;
  const waiting = items.filter((i) => i.notifiedAt);
  const fresh = items.filter((i) => !i.notifiedAt);
  const line = (i: DigestItem) => `• ${i.summary}\n${i.permalink}`;
  const shown = [...fresh, ...waiting].slice(0, DIGEST_MAX_ITEMS);
  const parts = [`Slack catch-up: ${items.length} unanswered`];
  const freshShown = shown.filter((i) => !i.notifiedAt);
  const waitingShown = shown.filter((i) => i.notifiedAt);
  if (freshShown.length) parts.push(freshShown.map(line).join("\n"));
  if (waitingShown.length) parts.push(`Still waiting on you:\n${waitingShown.map(line).join("\n")}`);
  if (items.length > shown.length) parts.push(`+${items.length - shown.length} more in Slack`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Settings, identity and name lookups
// ---------------------------------------------------------------------------

async function setting(key: string): Promise<string | null> {
  return await convex.query(api.settings.get, { key }).catch(() => null);
}

export async function isSlackWatchEnabled(): Promise<boolean> {
  return (await setting(SETTING_SLACK_ENABLED)) !== "false";
}

async function executeSlack(slug: string, args: Record<string, unknown>, connectedAccountId?: string): Promise<any> {
  const composio = getComposio();
  if (!composio) return null;
  const result: any = await composio.tools
    .execute(slug, {
      userId: boopUserId(),
      arguments: args,
      dangerouslySkipVersionCheck: true,
      ...(connectedAccountId ? { connectedAccountId } : {}),
    } as any)
    .catch((err: unknown) => {
      console.warn(`[slack-watch] ${slug} failed`, err);
      return null;
    });
  return result?.successful ? result.data : null;
}

const identities = new Map<string, SlackIdentity>();

async function identityFor(connectionId: string): Promise<SlackIdentity | null> {
  const cached = identities.get(connectionId);
  if (cached) return cached;
  const data = await executeSlack("SLACK_TEST_AUTH", {}, connectionId === "(unknown)" ? undefined : connectionId);
  if (!data?.user_id || !data?.url) return null;
  const identity = { userId: String(data.user_id), teamUrl: String(data.url) };
  identities.set(connectionId, identity);
  return identity;
}

const userNames = new Map<string, string>();
const channelNames = new Map<string, string>();

async function userName(id: string, connectionId?: string): Promise<string> {
  const cached = userNames.get(id);
  if (cached) return cached;
  const data = await executeSlack("SLACK_RETRIEVE_DETAILED_USER_INFORMATION", { user: id }, connectionId);
  const profile = data?.user?.profile ?? {};
  const name = profile.display_name || profile.real_name || data?.user?.real_name || data?.user?.name || id;
  userNames.set(id, name);
  return name;
}

async function channelName(id: string, connectionId?: string): Promise<string | undefined> {
  if (channelNames.has(id)) return channelNames.get(id);
  const data = await executeSlack("SLACK_RETRIEVE_CONVERSATION_INFORMATION", { channel: id }, connectionId);
  const name = data?.channel?.name ? `#${data.channel.name}` : undefined;
  if (name) channelNames.set(id, name);
  return name;
}

async function readableText(text: string, connectionId?: string): Promise<string> {
  const ids = [...text.matchAll(/<@([A-Z0-9]+)/g)].map((m) => m[1]!);
  for (const id of new Set(ids)) await userName(id, connectionId);
  return plainSlackText(text, userNames);
}

/** Where Slack notices go: BOOP_USER_PHONE, else the first owner number. */
export function ownerConversationId(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.BOOP_USER_PHONE?.trim() || (env.BOOP_OWNER_NUMBERS ?? "").split(",")[0]?.trim() || "";
  const phone = normalizeProactivePhone(raw);
  return phone ? `sms:${phone}` : null;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export const SLACK_RUBRIC = `You decide whether a Slack message to the user needs an iMessage interrupt now, or can wait for their next Slack digest.

urgent=true when the sender needs something from the user soon:
- A direct question or request that needs their reply, decision, review or approval (e.g. "can you merge…", "are you free to…", "which one should we use?").
- Something is broken, blocking someone, or affects production or customers.
- A deadline today or a meeting starting soon.
- Anything the user's preferences say to always surface.

urgent=false for everything else: FYI, thanks, acknowledgements, "cc @user", announcements, banter, status updates that need no reply, and anything the preferences say to ignore. When unsure, urgent=false; it will still reach the digest.

Always write a summary: one short plain-text line, under 160 characters, that starts with who and where ("Alex in #dev: …" or "Alex (DM): …") and says what they want from the user. Address the user as "you". No markdown.

Respond with ONLY JSON: {"urgent": boolean, "summary": "..."}`;

async function recallPreferenceLines(): Promise<string[]> {
  const rows = await convex
    .query(api.memoryRecords.list, { segment: "preference", lifecycle: "active", limit: 20 })
    .catch(() => []);
  return rows.map((r: { content: string }) => r.content);
}

export function parseClassification(text: string, fallback: string): { urgent: boolean; summary: string } {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { urgent?: boolean; summary?: string };
      const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : fallback;
      return { urgent: parsed.urgent === true, summary };
    } catch {
      // fall through
    }
  }
  return { urgent: false, summary: fallback };
}

async function classify(input: {
  sender: string;
  where: string;
  kind: "dm" | "mention";
  text: string;
}): Promise<{ urgent: boolean; summary: string }> {
  const fallback = `${input.sender} ${input.where}: ${input.text.slice(0, 120)}`;
  const base = await getRuntimeConfig();
  const runtimeConfig = base.runtime === "claude" ? { ...base, model: CLASSIFIER_MODEL } : base;
  const tz = await describeUserNow();
  const prefs = await recallPreferenceLines();
  const started = Date.now();
  try {
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: [
        `From: ${input.sender}`,
        `Where: ${input.where} (${input.kind === "dm" ? "direct message to the user" : "mentions the user"})`,
        `Message:\n${input.text.slice(0, 2000)}`,
      ].join("\n"),
      systemPrompt: `${SLACK_RUBRIC}\n\nUser preferences:\n${prefs.length ? prefs.map((p) => `- ${p}`).join("\n") : "(none)"}\n\nCurrent local time: ${tz.now} (${tz.timezone}).`,
      tools: [],
      mode: "background",
    });
    const usage = result.usage;
    if (usage.costUsd > 0 || usage.inputTokens > 0) {
      await convex
        .mutation(api.usageRecords.record, {
          source: "slack-watch",
          runtime: runtimeConfig.runtime,
          billingMode: runtimeConfig.billingMode,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          costUsd: usage.costUsd,
          durationMs: Date.now() - started,
        })
        .catch(() => undefined);
    }
    return parseClassification(result.text, fallback);
  } catch (err) {
    console.warn("[slack-watch] classifier failed; saving for the digest", err);
    return { urgent: false, summary: fallback };
  }
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

interface Burst {
  kind: "dm" | "mention";
  messages: SlackMessage[];
  connectionId: string;
  identity: SlackIdentity;
  timer: ReturnType<typeof setTimeout>;
}

const bursts = new Map<string, Burst>();
let receivingLogged = false;
const seen = new Set<string>();

function burstKey(message: SlackMessage): string {
  return `${message.channel}:${message.threadTs ?? (message.channelType === "im" ? "" : message.ts)}`;
}

function rememberSeen(key: string): boolean {
  if (seen.has(key)) return false;
  if (seen.size > 2000) seen.delete(seen.values().next().value!);
  seen.add(key);
  return true;
}

interface SlackTriggerEvent {
  triggerSlug?: string;
  payload?: Record<string, unknown>;
  metadata?: { connectedAccount?: { id?: string } };
}

export async function handleSlackEvent(event: SlackTriggerEvent): Promise<void> {
  if (event.triggerSlug !== CHANNEL_TRIGGER && event.triggerSlug !== DM_TRIGGER) return;
  const message = normalizeSlackPayload(event.triggerSlug, event.payload ?? {});
  if (!message) return;
  if (!rememberSeen(`${message.channel}:${message.ts}`)) return;
  if (!receivingLogged) {
    receivingLogged = true;
    console.log(`[slack-watch] receiving Slack events (first: ${event.triggerSlug})`);
  }
  if (!(await isSlackWatchEnabled())) return;

  const connectionId = event.metadata?.connectedAccount?.id ?? "(unknown)";
  const identity = await identityFor(connectionId);
  if (!identity) {
    console.warn(`[slack-watch] could not resolve the Slack user for ${connectionId}`);
    return;
  }

  const decision = decideSlackMessage(message, identity.userId);
  if (decision.action === "ignore") return;

  if (decision.action === "mine") {
    const root = message.threadTs ?? message.ts;
    const topLevel = !message.threadTs;
    // Replying cancels a pending burst in the same conversation.
    for (const [key, burst] of bursts) {
      const sameConversation = key.startsWith(`${message.channel}:`);
      const sameThread = key === `${message.channel}:${root}`;
      if (sameThread || (sameConversation && (burst.kind === "dm" || topLevel))) {
        clearTimeout(burst.timer);
        bursts.delete(key);
        console.log(`[slack-watch] you replied in ${message.channel}; dropped a pending notice`);
      }
    }
    const answered = await convex
      .mutation(api.slackMentions.markAnswered, { channel: message.channel, root, topLevel, ts: message.ts })
      .catch(() => 0);
    if (answered) console.log(`[slack-watch] marked ${answered} mention(s) answered in ${message.channel}`);
    return;
  }

  const key = burstKey(message);
  const existing = bursts.get(key);
  if (existing) {
    existing.messages.push(message);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => void flushBurst(key), BURST_WINDOW_MS);
    return;
  }
  bursts.set(key, {
    kind: decision.kind,
    messages: [message],
    connectionId,
    identity,
    timer: setTimeout(() => void flushBurst(key), BURST_WINDOW_MS),
  });
  console.log(`[slack-watch] ${decision.kind} in ${message.channel}; waiting ${BURST_WINDOW_MS / 1000}s for follow-ups`);
}

async function flushBurst(key: string): Promise<void> {
  const burst = bursts.get(key);
  if (!burst) return;
  bursts.delete(key);
  try {
    const first = burst.messages[0]!;
    const last = burst.messages[burst.messages.length - 1]!;
    const connection = burst.connectionId === "(unknown)" ? undefined : burst.connectionId;
    const sender = await userName(first.user!, connection);
    const name = burst.kind === "dm" ? undefined : await channelName(first.channel, connection);
    const where = burst.kind === "dm" ? "(DM)" : `in ${name ?? "a channel"}${first.threadTs ? " thread" : ""}`;
    const texts = [];
    for (const m of burst.messages) texts.push(await readableText(m.text, connection));
    const text = texts.join("\n");
    const { urgent, summary } = await classify({ sender, where, kind: burst.kind, text });
    const permalink = slackPermalink(burst.identity.teamUrl, first);

    const conversationId = ownerConversationId();
    const notify = urgent && conversationId !== null;
    if (notify) await notifyConversation(conversationId!, `${summary}\n${permalink}`, "slack_mention");
    if (urgent && !conversationId) console.warn("[slack-watch] no BOOP_USER_PHONE or BOOP_OWNER_NUMBERS; urgent mention saved for the digest");

    await convex.mutation(api.slackMentions.record, {
      key: `${first.channel}:${last.ts}`,
      channel: first.channel,
      ts: last.ts,
      threadTs: first.threadTs,
      kind: burst.kind,
      sender,
      channelName: name,
      text: text.slice(0, 4000),
      summary,
      permalink,
      urgent,
      notified: notify,
    });
    console.log(`[slack-watch] ${notify ? "texted" : "saved for digest"}: ${summary}`);
  } catch (err) {
    console.error("[slack-watch] failed to handle a mention", err);
  }
}

// ---------------------------------------------------------------------------
// Setup and digest
// ---------------------------------------------------------------------------

export async function ensureSlackWatcher(publicUrl: string): Promise<void> {
  if (!getComposio()) return;
  const connections = (await listConnectedToolkits()).filter((c) => c.slug === "slack" && c.status === "ACTIVE");
  if (connections.length === 0) {
    console.log("[slack-watch] no active Slack connection; nothing to watch");
    return;
  }
  try {
    await ensureWebhookSubscription(publicUrl);
  } catch (err) {
    console.error("[slack-watch] webhook subscription setup failed", err);
    return;
  }
  for (const conn of connections) {
    const channelTrigger = await ensureTrigger(CHANNEL_TRIGGER, conn.connectionId, { is_bot_message: false });
    const dmTrigger = await ensureTrigger(DM_TRIGGER, conn.connectionId, {});
    console.log(
      `[slack-watch] triggers ensured for ${conn.alias ?? conn.connectionId}: channels=${channelTrigger ?? "(none)"} dms=${dmTrigger ?? "(none)"}`,
    );
  }
}

let digestRunning = false;

export async function sendSlackDigest(options: { force?: boolean } = {}): Promise<{ sent: boolean; count: number; reason?: string }> {
  if (digestRunning) return { sent: false, count: 0, reason: "already running" };
  digestRunning = true;
  try {
    if (!options.force && !(await isSlackWatchEnabled())) return { sent: false, count: 0, reason: "turned off" };
    const timezone = await getUserTimezone();
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const nowHm = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    let slot: string | null = `${today} ${nowHm}`;
    if (!options.force) {
      slot = dueDigestSlot(parseDigestTimes(await setting(SETTING_DIGEST_TIMES)), today, nowHm, await setting(SETTING_DIGEST_LAST));
      if (!slot) return { sent: false, count: 0, reason: "not due" };
    }
    const pending = await convex.query(api.slackMentions.pendingDigest, {});
    const message = formatDigest(pending);
    const conversationId = ownerConversationId();
    if (message && conversationId) {
      await notifyConversation(conversationId, message, "slack_digest");
      await convex.mutation(api.slackMentions.markDigested, { ids: pending.map((p) => p._id) });
    }
    if (!options.force) await convex.mutation(api.settings.set, { key: SETTING_DIGEST_LAST, value: slot });
    console.log(`[slack-watch] digest ${slot}: ${message && conversationId ? `sent ${pending.length}` : "nothing to send"}`);
    return { sent: Boolean(message && conversationId), count: pending.length };
  } finally {
    digestRunning = false;
  }
}

export function startSlackDigestLoop(intervalMs = 60_000): () => void {
  const timer = setInterval(
    () => void sendSlackDigest().catch((err) => console.error("[slack-watch] digest failed", err)),
    intervalMs,
  );
  return () => clearInterval(timer);
}
