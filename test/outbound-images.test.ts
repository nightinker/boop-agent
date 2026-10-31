import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MAX_OUTBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_IMAGES,
  OutboundImageCollector,
  loadOutboundImage,
  sniffOutboundImageType,
  type OutboundImage,
} from "../server/images/outbound.js";
import { createImageAttachmentTools } from "../server/images/attach-tool.js";
import {
  imageFailureNotice,
  sendImessage,
  withAttachmentNote,
} from "../server/sendblue.js";
import { describeSpawnAttachments } from "../server/interaction-agent.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = new TextEncoder().encode("GIF89a\0\0");
const HEIC = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 0, 0]);

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "boop-outbound-"));
  await writeFile(join(dir, "chart.png"), PNG);
  await writeFile(join(dir, "photo.jpeg"), JPEG);
  await writeFile(join(dir, "fake.png"), JPEG);
  await writeFile(join(dir, "notes.txt"), "hello");
  await writeFile(join(dir, "secret.png"), "not an image");
  const big = new Uint8Array(MAX_OUTBOUND_IMAGE_BYTES + 1);
  big.set(PNG);
  await writeFile(join(dir, "big.png"), big);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function image(filename: string): OutboundImage {
  return { source: `/tmp/${filename}`, filename, mediaType: "image/png", bytes: PNG };
}

describe("sniffOutboundImageType", () => {
  it("recognizes png, jpg, gif and heic by magic bytes", () => {
    expect(sniffOutboundImageType(PNG)).toBe("image/png");
    expect(sniffOutboundImageType(JPEG)).toBe("image/jpeg");
    expect(sniffOutboundImageType(GIF)).toBe("image/gif");
    expect(sniffOutboundImageType(HEIC)).toBe("image/heic");
  });

  it("rejects anything else", () => {
    expect(sniffOutboundImageType(new TextEncoder().encode("<html>"))).toBeNull();
    expect(sniffOutboundImageType(new Uint8Array())).toBeNull();
  });
});

describe("loadOutboundImage (local files)", () => {
  it("loads a valid png", async () => {
    const res = await loadOutboundImage(join(dir, "chart.png"));
    expect(res).toMatchObject({ ok: true, image: { filename: "chart.png", mediaType: "image/png" } });
  });

  it("accepts .jpeg", async () => {
    const res = await loadOutboundImage(join(dir, "photo.jpeg"));
    expect(res).toMatchObject({ ok: true, image: { mediaType: "image/jpeg" } });
  });

  it("rejects relative paths, missing files and unsupported extensions", async () => {
    expect(await loadOutboundImage("chart.png")).toMatchObject({ ok: false, reason: /absolute/ });
    expect(await loadOutboundImage(join(dir, "nope.png"))).toMatchObject({
      ok: false,
      reason: "file not found",
    });
    expect(await loadOutboundImage(join(dir, "notes.txt"))).toMatchObject({
      ok: false,
      reason: /unsupported file type/,
    });
  });

  it("rejects files whose contents are not an image or don't match the extension", async () => {
    expect(await loadOutboundImage(join(dir, "secret.png"))).toMatchObject({
      ok: false,
      reason: /not a supported image/,
    });
    expect(await loadOutboundImage(join(dir, "fake.png"))).toMatchObject({
      ok: false,
      reason: /doesn't match/,
    });
  });

  it("rejects files over the size limit", async () => {
    expect(await loadOutboundImage(join(dir, "big.png"))).toMatchObject({
      ok: false,
      reason: /too large/,
    });
  });
});

describe("loadOutboundImage (URLs)", () => {
  it("downloads and validates a remote image, fixing the extension", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(GIF, { status: 200 })));
    const res = await loadOutboundImage("https://example.com/render?id=1");
    expect(res).toMatchObject({ ok: true, image: { filename: "render.gif", mediaType: "image/gif" } });
  });

  it("refuses private-network URLs without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadOutboundImage("http://127.0.0.1:3456/x.png")).toMatchObject({ ok: false });
    expect(await loadOutboundImage("http://localhost/x.png")).toMatchObject({ ok: false });
    expect(await loadOutboundImage("ftp://example.com/x.png")).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-image bodies, HTTP errors and oversized downloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    expect(await loadOutboundImage("https://example.com/a.png")).toMatchObject({ ok: false });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect(await loadOutboundImage("https://example.com/a.png")).toMatchObject({
      ok: false,
      reason: /HTTP 404/,
    });

    const big = new Uint8Array(MAX_OUTBOUND_IMAGE_BYTES + 10);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(big, { status: 200 })));
    expect(await loadOutboundImage("https://example.com/a.png")).toMatchObject({
      ok: false,
      reason: /too large/,
    });
  });
});

describe("OutboundImageCollector", () => {
  it("dedupes by source and caps images per reply", () => {
    const c = new OutboundImageCollector();
    const many = Array.from({ length: MAX_OUTBOUND_IMAGES + 2 }, (_, i) => image(`${i}.png`));
    expect(c.add(many[0])).toBe(true);
    expect(c.add(many[0])).toBe(true);
    const dropped = c.addAll(many);
    expect(c.list).toHaveLength(MAX_OUTBOUND_IMAGES);
    expect(dropped).toHaveLength(2);
  });
});

describe("attach_image tool", () => {
  it("collects valid images and reports errors back to the agent", async () => {
    const collector = new OutboundImageCollector();
    const [tool] = createImageAttachmentTools(collector);
    const ok = await tool.handle({ source: join(dir, "chart.png") });
    expect(ok.success).toBe(true);
    const bad = await tool.handle({ source: join(dir, "notes.txt") });
    expect(bad.success).toBe(false);
    expect(bad.text).toMatch(/Couldn't attach/);
    expect(collector.list.map((i) => i.filename)).toEqual(["chart.png"]);
  });
});

describe("sendImessage with images", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function setCreds() {
    process.env.SENDBLUE_API_KEY = "test-key";
    process.env.SENDBLUE_API_SECRET = "test-secret";
    process.env.SENDBLUE_FROM_NUMBER = ["+", "1", "555", "000", "0100"].join("");
  }
  const recipient = ["+", "1", "555", "000", "0101"].join("");

  it("sends the text, then uploads and sends each image as media", async () => {
    setCreds();
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/upload-file")
        ? new Response(JSON.stringify({ media_url: "https://cdn.example.com/chart.png" }), {
            status: 201,
          })
        : new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendImessage(recipient, "Here's your chart", [image("chart.png")]);

    expect(result).toEqual({ sentImages: ["chart.png"], failedImages: [] });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toMatch(/send-message$/);
    expect(urls[1]).toMatch(/upload-file$/);
    expect(urls[2]).toMatch(/send-message$/);
    const uploadInit = fetchMock.mock.calls[1][1]!;
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect((uploadInit.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]!.body))).toMatchObject({
      number: recipient,
      media_url: "https://cdn.example.com/chart.png",
    });
  });

  it("falls back to a text notice when an image can't be sent", async () => {
    setCreds();
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/upload-file")
        ? new Response("boom", { status: 500 })
        : new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendImessage(recipient, "Here's your chart", [image("chart.png")]);

    expect(result.sentImages).toEqual([]);
    expect(result.failedImages).toEqual([
      { filename: "chart.png", reason: "upload failed (HTTP 500)" },
    ]);
    const last = fetchMock.mock.calls.at(-1)!;
    expect(String(last[0])).toMatch(/send-message$/);
    expect(JSON.parse(String(last[1]!.body)).content).toMatch(/Couldn't send the image \(chart\.png\)/);
  });

  it("text-only sends are unchanged", async () => {
    setCreds();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendImessage(recipient, "hi");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ sentImages: [], failedImages: [] });
  });
});

describe("attachment notes", () => {
  it("summarizes failures for the user", () => {
    expect(imageFailureNotice([])).toBe("");
    expect(
      imageFailureNotice([
        { filename: "a.png", reason: "upload failed (HTTP 500)" },
        { filename: "b.png", reason: "upload failed (HTTP 500)" },
      ]),
    ).toBe("(Couldn't send 2 images (a.png, b.png): upload failed (HTTP 500))");
  });

  it("records sent and failed images in conversation history", () => {
    expect(
      withAttachmentNote("Here you go", {
        sentImages: ["a.png"],
        failedImages: [{ filename: "b.png", reason: "send failed (HTTP 400)" }],
      }),
    ).toBe(
      "Here you go\n[sent image: a.png]\n(Couldn't send the image (b.png): send failed (HTTP 400))",
    );
    expect(withAttachmentNote("Hi", { sentImages: [], failedImages: [] })).toBe("Hi");
  });

  it("tells the dispatcher what will be delivered and what was dropped", () => {
    expect(describeSpawnAttachments([], [])).toBe("");
    const text = describeSpawnAttachments([image("a.png")], [image("b.png")]);
    expect(text).toMatch(/1 image\(s\) attached by the agent \(a\.png\)/);
    expect(text).toMatch(/\(b\.png\) were dropped/);
  });
});
