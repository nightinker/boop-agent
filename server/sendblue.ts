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

const API_BASE = "https://api.sendblue.com/api";
const MAX_CHUNK = 2900;

export function extractSendblueMediaUrls(
  mediaUrl: unknown,
  mediaUrls: unknown,
): string[] {
  const urls = new Set<string>();
  if (Array.isArray(mediaUrls)) {
    for (const value of mediaUrls) {
      if (typeof value === "string" && value.trim()) urls.add(value.trim());
    }
  }
  if (typeof mediaUrl === "string" && mediaUrl.trim()) urls.add(mediaUrl.trim());
  return [...urls];
}

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
    const res = await fetch(`${API_BASE}/send-message`, {
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
export async function sendImessage(
  toNumber: string,
  text: string,
  images: OutboundImage[] = [],
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

export function createSendblueRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    if (!verifySendblueWebhookSecret(req.get("sb-signing-secret"))) {
      res.status(401).json({ error: "invalid webhook signature" });
      return;
    }

    const { content, from_number, is_outbound, message_handle, media_url, media_urls } =
      req.body ?? {};
    const rawUrls = extractSendblueMediaUrls(media_url, media_urls);
    if (is_outbound || !from_number || (!content && rawUrls.length === 0)) {
      res.json({ ok: true, skipped: true });
      return;
    }

    if (message_handle) {
      const { claimed } = await convex.mutation(api.sendblueDedup.claim, {
        handle: message_handle,
      });
      if (!claimed) {
        res.json({ ok: true, deduped: true });
        return;
      }
    }

    const ingestResults = await Promise.all(rawUrls.map(ingestSendblueImage));
    const ingested: IngestedImage[] = [];
    const ingestErrors: string[] = [];
    for (const r of ingestResults) {
      if (r.ok) ingested.push(r.image);
      else ingestErrors.push(r.reason);
    }

    const conversationId = `sms:${from_number}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const textForLog = typeof content === "string" ? content : "";
    const safeTextForLog = redactPhoneNumbers(textForLog);
    const preview = safeTextForLog.length > 100 ? safeTextForLog.slice(0, 100) + "…" : safeTextForLog;
    console.log(`[turn ${turnTag}] ← ${redactContactHandle(from_number)}: ${JSON.stringify(preview)}`);
    const start = Date.now();

    broadcast("message_in", { conversationId, content, from_number, handle: message_handle });
    res.json({ ok: true });

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
      const { reply, attachments } = await handleUserMessageWithAttachments({
        conversationId,
        content: textForLog,
        turnTag,
        images: ingested,
        mediaError: ingestErrors.length > 0 ? ingestErrors.join("; ") : undefined,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const safeReplyPreview = redactPhoneNumbers(reply);
        const replyPreview = safeReplyPreview.length > 100 ? safeReplyPreview.slice(0, 100) + "…" : safeReplyPreview;
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        const sent = await sendImessage(from_number, reply, attachments);
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
    } finally {
      stopTyping();
    }
  });

  return router;
}
