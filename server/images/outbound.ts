import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";

/**
 * Outbound images: files or URLs a sub-agent wants delivered to the user as
 * real iMessage attachments. Everything is loaded and validated up front (at
 * attach time) so the sub-agent gets immediate feedback, and the bytes we
 * later upload are exactly the bytes we checked.
 */

// Sendblue documents a 5 MB cap for media sent via media_url.
export const MAX_OUTBOUND_IMAGE_BYTES = 5 * 1024 * 1024;
// Per reply. Keeps a runaway agent from spamming the thread.
export const MAX_OUTBOUND_IMAGES = 5;

export type OutboundImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/heic";

const EXTENSION_FOR: Record<OutboundImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/heic": "heic",
};

const MEDIA_TYPE_FOR_EXT: Record<string, OutboundImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heic",
};

export const SUPPORTED_OUTBOUND_FORMATS = "png, jpg/jpeg, gif, heic";

export interface OutboundImage {
  /** The path or URL the agent asked for (for logs and failure messages). */
  source: string;
  /** Filename sent to Sendblue; always ends in the right extension. */
  filename: string;
  mediaType: OutboundImageMediaType;
  bytes: Uint8Array;
}

export type OutboundImageLoad =
  | { ok: true; image: OutboundImage }
  | { ok: false; reason: string };

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

/** Identify the image format from its magic bytes. */
export function sniffOutboundImageType(bytes: Uint8Array): OutboundImageMediaType | null {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return "image/gif";
  }
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(8, 12))) {
    return "image/heic";
  }
  return null;
}

function withExtension(name: string, mediaType: OutboundImageMediaType): string {
  const ext = extname(name).toLowerCase();
  if (MEDIA_TYPE_FOR_EXT[ext] === mediaType) return name;
  const stem = (ext ? name.slice(0, -ext.length) : name) || "image";
  return `${stem}.${EXTENSION_FOR[mediaType]}`;
}

function finish(source: string, name: string, bytes: Uint8Array): OutboundImageLoad {
  if (bytes.byteLength === 0) return { ok: false, reason: "file is empty" };
  const mediaType = sniffOutboundImageType(bytes);
  if (!mediaType) {
    return {
      ok: false,
      reason: `not a supported image (supported: ${SUPPORTED_OUTBOUND_FORMATS})`,
    };
  }
  const safeName = basename(name).replace(/[^\w.\-]+/g, "_") || "image";
  return {
    ok: true,
    image: { source, filename: withExtension(safeName, mediaType), mediaType, bytes },
  };
}

function tooLarge(size: number): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return `image too large (${mb(size)} MB, max ${mb(MAX_OUTBOUND_IMAGE_BYTES)} MB)`;
}

async function loadLocalImage(source: string): Promise<OutboundImageLoad> {
  const path = source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
  if (!isAbsolute(path)) {
    return { ok: false, reason: "local image paths must be absolute" };
  }
  const ext = extname(path).toLowerCase();
  if (!MEDIA_TYPE_FOR_EXT[ext]) {
    return {
      ok: false,
      reason: `unsupported file type "${ext || "(none)"}" (supported: ${SUPPORTED_OUTBOUND_FORMATS})`,
    };
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    return { ok: false, reason: "file not found" };
  }
  if (!info.isFile()) return { ok: false, reason: "not a regular file" };
  if (info.size > MAX_OUTBOUND_IMAGE_BYTES) return { ok: false, reason: tooLarge(info.size) };

  let bytes: Uint8Array;
  try {
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(MAX_OUTBOUND_IMAGE_BYTES + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_OUTBOUND_IMAGE_BYTES) {
        return { ok: false, reason: tooLarge(bytesRead) };
      }
      bytes = new Uint8Array(buf.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch (err) {
    return { ok: false, reason: `couldn't read file: ${String(err)}` };
  }
  const result = finish(source, path, bytes);
  if (result.ok && MEDIA_TYPE_FOR_EXT[ext] !== result.image.mediaType) {
    return {
      ok: false,
      reason: `file extension ${ext} doesn't match its contents (${result.image.mediaType})`,
    };
  }
  return result;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host)
  );
}

async function loadRemoteImage(source: string): Promise<OutboundImageLoad> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "only http(s) URLs are supported" };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, reason: "local/private network URLs aren't allowed; use a file path" };
  }
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `download failed: HTTP ${res.status}` };
  }
  const len = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(len) && len > MAX_OUTBOUND_IMAGE_BYTES) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: tooLarge(len) };
  }
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, reason: "download failed: no body" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OUTBOUND_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: tooLarge(total) };
      }
      chunks.push(value);
    }
  } catch (err) {
    return { ok: false, reason: `download failed: ${String(err)}` };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const name = decodeURIComponent(url.pathname.split("/").pop() ?? "") || "image";
  return finish(source, name, bytes);
}

/**
 * Load and validate an image a sub-agent wants to send. `source` is an
 * absolute local path (or ~/…) or an http(s) URL.
 */
export async function loadOutboundImage(source: string): Promise<OutboundImageLoad> {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, reason: "empty path" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return loadRemoteImage(trimmed);
  return loadLocalImage(trimmed);
}

/**
 * Collects the images attached during one turn, de-duplicated by source and
 * capped at MAX_OUTBOUND_IMAGES.
 */
export class OutboundImageCollector {
  private readonly images: OutboundImage[] = [];

  get list(): OutboundImage[] {
    return [...this.images];
  }

  has(source: string): boolean {
    return this.images.some((i) => i.source === source);
  }

  /** Returns false when the per-reply cap is already reached. */
  add(image: OutboundImage): boolean {
    if (this.has(image.source)) return true;
    if (this.images.length >= MAX_OUTBOUND_IMAGES) return false;
    this.images.push(image);
    return true;
  }

  addAll(images: OutboundImage[]): OutboundImage[] {
    const dropped: OutboundImage[] = [];
    for (const image of images) if (!this.add(image)) dropped.push(image);
    return dropped;
  }
}
