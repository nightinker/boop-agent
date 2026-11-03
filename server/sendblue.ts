import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessageWithAttachments } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import { validateImageHeader, MAX_IMAGE_BYTES, type ImageMediaType } from "./images/mime.js";
import type { OutboundImage } from "./images/outbound.js";
import { redactContactHandle, redactPhoneNumbers } from "./privacy.js";
import { maybeHandleScriptedDemoReply } from "./scripted-demo-replies.js";
import { verifySendblueWebhookSecret } from "./sendblue-webhook-auth.js";
import {
  ackDelayMsFromEnv,
  createInboundQueue,
  debounceMsFromEnv,
  inboundFromSendblue,
  maxTypingHoldMsFromEnv,
  serviceFromSendblue,
  typingFromSendblue,
  type InboundItem,
  type RunContext,
} from "./inbound-queue.js";
import { convexInboundStore } from "./inbound-store.js";
import { createKeyedLock, replyHeading, withReplyHeading } from "./parallel-turns.js";
import { getMaxConcurrentRuns } from "./runtime-config.js";
import { isActiveInstance } from "./instance.js";
import { isNetworkError, noteNetworkFailure } from "./network-health.js";

const API_BASE = "https://api.sendblue.com/api";
const MAX_CHUNK = 2900;

export { extractSendblueMediaUrls } from "./inbound-queue.js";

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function headers(): Record<string, string> | null {
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": apiSecret,
  };
}

function normalizeE164(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const trimmed = n.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  // Bare US-length numbers get a +1. Longer/shorter just get a leading +.
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

export interface ImageSendFailure {
  filename: string;
  reason: string;
}

export interface SendImessageResult {
  /** Filenames of images delivered as iMessage attachments. */
  sentImages: string[];
  failedImages: ImageSendFailure[];
}

/** The plain-text fallback the user gets when attachments couldn't be sent. */
export function imageFailureNotice(failures: ImageSendFailure[]): string {
  if (failures.length === 0) return "";
  const names = failures.map((f) => f.filename).join(", ");
  const reasons = [...new Set(failures.map((f) => f.reason))].join("; ");
  const what = failures.length === 1 ? "the image" : `${failures.length} images`;
  return `(Couldn't send ${what} (${names}): ${reasons})`;
}

function explainSendFailure(body: string, from: string): void {
  if (body.includes("missing required parameter") && body.includes("from_number")) {
    console.error(
      `[sendblue] → Set SENDBLUE_FROM_NUMBER in .env.local to your Sendblue-provisioned number and restart the server.`,
    );
  } else if (body.includes("Cannot send messages to self")) {
    console.error(
      `[sendblue] → SENDBLUE_FROM_NUMBER is your personal cell. It must be the Sendblue-provisioned number (the one people text TO).`,
    );
  } else if (body.includes("This phone number is not defined")) {
    console.error(
      `[sendblue] → Sendblue doesn't recognize from_number=${redactContactHandle(from)}. Run \`npm run sendblue:sync\` to pull the correct one from \`sendblue lines\`, then restart the server.`,
    );
  }
}

/** Waits between send attempts; about 40s in all before giving up. */
export const SEND_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];
const SEND_ATTEMPT_TIMEOUT_MS = 20_000;

/**
 * POSTs to Sendblue, retrying when the network drops (flaky Wi-Fi, DNS
 * hiccups) or Sendblue answers 429/5xx. Without this a reply Boop already
 * wrote was lost to a single "fetch failed". A retry after a timeout can
 * rarely double-send a text; that beats never sending it.
 */
export async function postWithRetry(
  url: string,
  init: RequestInit,
  delaysMs: readonly number[] = SEND_RETRY_DELAYS_MS,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delaysMs.length;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SEND_ATTEMPT_TIMEOUT_MS) });
      if (last || (res.status !== 429 && res.status < 500)) return res;
      await res.body?.cancel().catch(() => undefined);
      console.warn(`[sendblue] send got HTTP ${res.status}; retrying in ${delaysMs[attempt]}ms`);
    } catch (err) {
      if (isNetworkError(err)) noteNetworkFailure("sendblue send");
      if (last) throw err;
      console.warn(`[sendblue] send failed (${String(err)}); retrying in ${delaysMs[attempt]}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
  }
}

async function sendTextParts(
  h: Record<string, string>,
  from: string,
  toNumber: string,
  text: string,
): Promise<void> {
  // Intentional privacy guard: Boop should not deliver phone numbers back over
  // iMessage, even if an agent includes one in its final reply.
  const plain = redactPhoneNumbers(stripMarkdown(text));
  if (!plain) return;
  for (const part of chunk(plain)) {
    const res = await postWithRetry(`${API_BASE}/send-message`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, content: part, from_number: from }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[sendblue] send failed ${res.status}: ${redactPhoneNumbers(body).slice(0, 500)}`,
      );
      explainSendFailure(body, from);
    } else {
      console.log(`[sendblue] → sent ${part.length} chars to ${redactContactHandle(toNumber)}`);
    }
  }
}

/**
 * Upload an image to Sendblue's CDN, then send it as a media message.
 * Throws with a short, user-presentable reason on failure.
 */
async function sendImageAttachment(
  h: Record<string, string>,
  from: string,
  toNumber: string,
  image: OutboundImage,
): Promise<void> {
  const { "Content-Type": _json, ...authHeaders } = h;
  const form = new FormData();
  form.append(
    "file",
    new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.mediaType }),
    image.filename,
  );
  let upload: Response;
  try {
    upload = await fetch(`${API_BASE}/upload-file`, {
      method: "POST",
      headers: authHeaders,
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`upload failed (${String(err)})`);
  }
  if (!upload.ok) {
    const body = await upload.text().catch(() => "");
    console.error(
      `[sendblue] image upload failed ${upload.status}: ${redactPhoneNumbers(body).slice(0, 300)}`,
    );
    throw new Error(`upload failed (HTTP ${upload.status})`);
  }
  const uploaded = (await upload.json().catch(() => ({}))) as { media_url?: unknown };
  if (typeof uploaded.media_url !== "string" || !uploaded.media_url) {
    throw new Error("upload failed (no media_url returned)");
  }
  const res = await fetch(`${API_BASE}/send-message`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ number: toNumber, from_number: from, media_url: uploaded.media_url }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(
      `[sendblue] image send failed ${res.status}: ${redactPhoneNumbers(body).slice(0, 500)}`,
    );
    explainSendFailure(body, from);
    throw new Error(`send failed (HTTP ${res.status})`);
  }
  console.log(
    `[sendblue] → sent image ${image.filename} (${image.bytes.byteLength} bytes) to ${redactContactHandle(toNumber)}`,
  );
}

/**
 * Send a reply over iMessage. Text goes first, then each image as its own
 * attachment message. If any image fails, the user gets a short text notice
 * instead, so a failed attachment never silently disappears.
 */
// One send at a time per recipient: with answers running in parallel, a
// reply split into several texts (plus its images) never interleaves with
// another reply or a "queued" ack.
const sendLock = createKeyedLock();

export function sendImessage(
  toNumber: string,
  text: string,
  images: OutboundImage[] = [],
): Promise<SendImessageResult> {
  return sendLock(normalizeE164(toNumber) || toNumber, () => sendImessageNow(toNumber, text, images));
}

async function sendImessageNow(
  toNumber: string,
  text: string,
  images: OutboundImage[],
): Promise<SendImessageResult> {
  const result: SendImessageResult = { sentImages: [], failedImages: [] };
  const h = headers();
  if (!h) {
    console.warn("[sendblue] missing credentials — not sending");
    result.failedImages = images.map((i) => ({ filename: i.filename, reason: "iMessage not configured" }));
    return result;
  }
  const from = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!from) {
    console.error(
      `[sendblue] SENDBLUE_FROM_NUMBER is not set. Run \`npm run sendblue:sync\` (pulls it from \`sendblue lines\`) or paste your provisioned number into .env.local, then restart \`npm run dev\`.`,
    );
    result.failedImages = images.map((i) => ({ filename: i.filename, reason: "iMessage not configured" }));
    return result;
  }
  await sendTextParts(h, from, toNumber, text);
  for (const image of images) {
    try {
      await sendImageAttachment(h, from, toNumber, image);
      result.sentImages.push(image.filename);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.failedImages.push({ filename: image.filename, reason });
    }
  }
  if (result.failedImages.length > 0) {
    await sendTextParts(h, from, toNumber, imageFailureNotice(result.failedImages));
  }
  return result;
}

/**
 * Conversation history is text-only, so record which images went out (or
 * didn't) — otherwise next turn Boop has no idea it already sent a chart.
 */
export function withAttachmentNote(reply: string, sent: SendImessageResult): string {
  const lines = [reply];
  if (sent.sentImages.length > 0) lines.push(`[sent image: ${sent.sentImages.join(", ")}]`);
  const notice = imageFailureNotice(sent.failedImages);
  if (notice) lines.push(notice);
  return lines.join("\n");
}

export async function sendTypingIndicator(toNumber: string): Promise<void> {
  const h = headers();
  if (!h) return;
  const from = process.env.SENDBLUE_FROM_NUMBER;
  try {
    await fetch(`${API_BASE}/send-typing-indicator`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, from_number: from }),
    });
  } catch {
    /* non-fatal */
  }
}

export function startTypingLoop(toNumber: string): () => void {
  sendTypingIndicator(toNumber);
  const timer = setInterval(() => sendTypingIndicator(toNumber), 5000);
  return () => clearInterval(timer);
}

type IngestedImage = { storageId: string; mediaType: ImageMediaType };

export async function ingestSendblueImage(
  url: string,
): Promise<{ ok: true; image: IngestedImage } | { ok: false; reason: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `download failed: HTTP ${res.status}` };
  }
  const lenHeader = res.headers.get("content-length");
  const contentLength = lenHeader ? Number(lenHeader) : undefined;
  const check = validateImageHeader({
    contentType: res.headers.get("content-type") ?? undefined,
    contentLength,
  });
  if (!check.ok) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: check.reason };
  }
  // Stream the body so we can abort early when the running total exceeds
  // MAX_IMAGE_BYTES — content-length is often absent on CDN/redirect
  // responses, and `await res.arrayBuffer()` would otherwise buffer the
  // entire payload before any cap check fires.
  let buf: ArrayBuffer;
  try {
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: "download failed: no body" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          reason: `image too large: >${MAX_IMAGE_BYTES} bytes`,
        };
      }
      chunks.push(value);
    }
    buf = new ArrayBuffer(total);
    const view = new Uint8Array(buf);
    let offset = 0;
    for (const c of chunks) {
      view.set(c, offset);
      offset += c.byteLength;
    }
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }

  try {
    const uploadUrl = await convex.mutation(api.messages.generateUploadUrl, {});
    const upload = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": check.mediaType },
      body: buf,
      signal: AbortSignal.timeout(10_000),
    });
    if (!upload.ok) {
      return { ok: false, reason: `upload failed: HTTP ${upload.status}` };
    }
    const { storageId } = (await upload.json()) as { storageId: string };
    return { ok: true, image: { storageId, mediaType: check.mediaType } };
  } catch (err) {
    return { ok: false, reason: `upload failed: ${String(err)}` };
  }
}

/** Answers one queued text: the same work the webhook used to do inline. */
export async function processInboundText(item: InboundItem, run?: RunContext): Promise<void> {
  const { conversationId, fromNumber: from_number, handle } = item;
  const ingestResults = await Promise.all(item.mediaUrls.map(ingestSendblueImage));
  const ingested: IngestedImage[] = [];
  const ingestErrors: string[] = [];
  for (const r of ingestResults) {
    if (r.ok) ingested.push(r.image);
    else ingestErrors.push(r.reason);
  }

  const turnTag = Math.random().toString(36).slice(2, 8);
  const textForLog = item.content;
  const safeTextForLog = redactPhoneNumbers(textForLog);
  const preview = safeTextForLog.length > 100 ? safeTextForLog.slice(0, 100) + "…" : safeTextForLog;
  const via = item.source === "poll" ? " (caught by poll)" : "";
  console.log(`[turn ${turnTag}] ← ${redactContactHandle(from_number)}${via}: ${JSON.stringify(preview)}`);
  const start = Date.now();

  broadcast("message_in", { conversationId, content: item.content, from_number, handle });

  if (
    await maybeHandleScriptedDemoReply(
      {
        conversationId,
        content: textForLog,
        fromNumber: from_number,
        turnTag,
      },
      {
        sendImessage: async (to, text) => {
          await sendImessage(to, text);
        },
        sendTypingIndicator,
      },
    )
  ) {
    return;
  }

  const stopTyping = startTypingLoop(from_number);
  try {
    const { reply: answer, attachments } = await handleUserMessageWithAttachments({
      conversationId,
      content: textForLog,
      turnTag,
      images: ingested,
      mediaError: ingestErrors.length > 0 ? ingestErrors.join("; ") : undefined,
      parallelMessages: run ? () => run.parallel().map((other) => other.content) : undefined,
      onThinking: (t) => broadcast("thinking", { conversationId, t }),
    });
    // Another answer ran alongside this one: say which message this replies to.
    const reply = answer && run?.overlapped() ? withReplyHeading(answer, replyHeading(run.batch)) : answer;
    if (reply) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const safeReplyPreview = redactPhoneNumbers(reply);
      const replyPreview = safeReplyPreview.length > 100 ? safeReplyPreview.slice(0, 100) + "…" : safeReplyPreview;
      console.log(
        `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
      );
      let sent: SendImessageResult;
      try {
        sent = await sendImessage(from_number, reply, attachments);
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        // The reply is written; only sending it failed. Save it to the history
        // and the outbox: the active copy (the server, if this Mac's network
        // is bad) resends it, with no model call and no agent re-run.
        await convex.mutation(api.replyOutbox.add, {
          conversationId,
          toNumber: from_number,
          content: reply,
          error: String(err),
        });
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: attachments.length > 0 ? `${reply}\n[images not sent: the network dropped]` : reply,
        });
        console.warn(`[turn ${turnTag}] → reply saved to the outbox; sending failed (${String(err)})`);
        return;
      }
      await convex.mutation(api.messages.send, {
        conversationId,
        role: "assistant",
        content: withAttachmentNote(reply, sent),
      });
    } else {
      console.log(`[turn ${turnTag}] → (no reply)`);
    }
  } catch (err) {
    console.error(`[turn ${turnTag}] handler error`, err);
    if (isNetworkError(err)) noteNetworkFailure("inbound turn");
    throw err;
  } finally {
    stopTyping();
  }
}

export const inboundQueue = createInboundQueue({
  store: convexInboundStore,
  process: processInboundText,
  isActive: isActiveInstance,
  // Wait for a quiet period so a burst of texts gets one answer.
  debounceMs: debounceMsFromEnv(process.env.BOOP_MESSAGE_DEBOUNCE_MS),
  // Hard cap on a wait while the sender is typing (texts alone stop at 15s),
  // counted from the first waiting text.
  maxTypingWaitMs: maxTypingHoldMsFromEnv(process.env.BOOP_MAX_TYPING_HOLD_MS),
  // Up to maxConcurrentRuns answers per conversation at once (default 2).
  maxConcurrentRuns: getMaxConcurrentRuns,
  // A text sent while every slot is busy (e.g. sub-agents are running)
  // gets a short "queued (position N)" so it doesn't look ignored.
  acknowledge: async ({ conversationId, fromNumber }, text) => {
    await sendImessage(fromNumber, text);
    broadcast("message_queued", { conversationId, text });
  },
  ackDelayMs: ackDelayMsFromEnv(process.env.BOOP_QUEUE_ACK_DELAY_MS),
});

/**
 * Applies a Sendblue typing_indicator webhook to the quiet period. Typing is
 * only a hint, so a bad payload or a failure is logged and swallowed: it must
 * never break the webhook or hold up a reply.
 */
function handleTypingWebhook(body: unknown): { ok: true; typing: boolean; outcome?: string } {
  try {
    const typing = typingFromSendblue(body);
    if (!typing) {
      // Field names only, never values, so a payload-shape change is visible without leaking numbers.
      const keys = body && typeof body === "object" ? Object.keys(body).sort().join(",") : typeof body;
      console.log(`[sendblue] typing webhook without a usable typing event (fields: ${keys || "none"})`);
      return { ok: true, typing: false };
    }
    const outcome = inboundQueue.noteTyping(typing.conversationId, typing.isTyping);
    console.log(
      `[sendblue] typing event from ${redactContactHandle(typing.conversationId.replace(/^sms:/, ""))}: is_typing=${typing.isTyping} → ${outcome}`,
    );
    return { ok: true, typing: true, outcome };
  } catch (err) {
    console.warn("[sendblue] ignored a typing indicator", err);
    return { ok: true, typing: false };
  }
}

export function createSendblueRouter(): express.Router {
  const router = express.Router();

  // Sendblue's typing_indicator webhook (iMessage only). Always answers 200 to
  // a signed request so Sendblue doesn't retry a hint that's already stale.
  router.post("/typing", (req, res) => {
    if (!verifySendblueWebhookSecret(req.get("sb-signing-secret"))) {
      res.status(401).json({ error: "invalid webhook signature" });
      return;
    }
    res.json(handleTypingWebhook(req.body));
  });

  router.post("/webhook", async (req, res) => {
    if (!verifySendblueWebhookSecret(req.get("sb-signing-secret"))) {
      res.status(401).json({ error: "invalid webhook signature" });
      return;
    }

    // A typing_indicator webhook pointed at this URL (older setups) works the
    // same as one pointed at /sendblue/typing.
    if (typingFromSendblue(req.body)) {
      res.json(handleTypingWebhook(req.body));
      return;
    }

    const input = inboundFromSendblue(req.body, "webhook");
    if (!input) {
      res.json({ ok: true, skipped: true });
      return;
    }

    // Saved before we answer 200, so a crash after this point can't lose the
    // text. If saving fails, a 500 makes Sendblue retry and the poller is the
    // backstop.
    try {
      const enqueued = await inboundQueue.enqueue(input, { service: serviceFromSendblue(req.body) });
      res.json(enqueued ? { ok: true } : { ok: true, deduped: true });
    } catch (err) {
      console.error("[sendblue] couldn't queue inbound text", err);
      res.status(500).json({ error: "couldn't queue message" });
    }
  });

  return router;
}
