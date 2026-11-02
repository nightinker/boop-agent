import { afterEach, describe, expect, it, vi } from "vitest";
import { postWithRetry, SEND_RETRY_DELAYS_MS, sendImessage } from "../server/sendblue.js";

const originalApiKey = process.env.SENDBLUE_API_KEY;
const originalApiSecret = process.env.SENDBLUE_API_SECRET;
const originalFromNumber = process.env.SENDBLUE_FROM_NUMBER;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalApiKey === undefined) {
    delete process.env.SENDBLUE_API_KEY;
  } else {
    process.env.SENDBLUE_API_KEY = originalApiKey;
  }
  if (originalApiSecret === undefined) {
    delete process.env.SENDBLUE_API_SECRET;
  } else {
    process.env.SENDBLUE_API_SECRET = originalApiSecret;
  }
  if (originalFromNumber === undefined) {
    delete process.env.SENDBLUE_FROM_NUMBER;
  } else {
    process.env.SENDBLUE_FROM_NUMBER = originalFromNumber;
  }
});

describe("sendImessage", () => {
  it("redacts phone numbers from the delivered message body", async () => {
    process.env.SENDBLUE_API_KEY = "test-key";
    process.env.SENDBLUE_API_SECRET = "test-secret";
    process.env.SENDBLUE_FROM_NUMBER = ["+", "1", "555", "000", "0100"].join("");
    const recipient = ["+", "1", "555", "000", "0101"].join("");
    const leakedPhone = ["+", "1", "555", "555", "0102"].join("");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendImessage(recipient, `Call ${leakedPhone}`);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      number: recipient,
      content: "Call [phone number hidden]",
    });
  });
});

describe("postWithRetry", () => {
  it("retries a dropped connection, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await postWithRetry("https://example.test/send", { method: "POST" }, [0, 0, 0]);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("doesn't retry a request Sendblue rejected", async () => {
    const fetchMock = vi.fn(async () => new Response("bad number", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await postWithRetry("https://example.test/send", { method: "POST" }, [0, 0]);

    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("gives up with the network error after the last try", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(postWithRetry("https://example.test/send", { method: "POST" }, [0, 0])).rejects.toThrow(
      "fetch failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sendImessage delivers a reply after a brief outage", async () => {
    vi.useFakeTimers();
    try {
      process.env.SENDBLUE_API_KEY = "test-key";
      process.env.SENDBLUE_API_SECRET = "test-secret";
      process.env.SENDBLUE_FROM_NUMBER = ["+", "1", "555", "000", "0100"].join("");
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const sending = sendImessage("user@example.com", "Done: #64 is locked while live.");
      await vi.advanceTimersByTimeAsync(SEND_RETRY_DELAYS_MS[0]);
      await sending;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
