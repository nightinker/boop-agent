import { describe, expect, it, vi } from "vitest";
import { syncTypingWebhook, syncWebhooks, typingWebhookUrl } from "../scripts/sendblue-webhook.mjs";

describe("Sendblue webhook synchronization", () => {
  it("keeps duplicate active hooks while removing stale tunnel URLs", async () => {
    const active = "https://active.ngrok-free.app/sendblue/webhook";
    const stale = "https://stale.ngrok-free.app/sendblue/webhook";
    const removeWebhook = vi.fn(async () => undefined);
    const addWebhook = vi.fn(async () => undefined);

    await syncWebhooks(
      active,
      [
        { type: "receive", url: active },
        { type: "receive", url: active },
        { type: "receive", url: stale },
      ],
      removeWebhook,
      addWebhook,
    );

    expect(removeWebhook).toHaveBeenCalledOnce();
    expect(removeWebhook).toHaveBeenCalledWith(stale);
    expect(addWebhook).not.toHaveBeenCalled();
  });

  it("registers the active hook when it is missing", async () => {
    const active = "https://active.ngrok-free.app/sendblue/webhook";
    const addWebhook = vi.fn(async () => undefined);

    await syncWebhooks(active, [], vi.fn(async () => undefined), addWebhook);

    expect(addWebhook).toHaveBeenCalledOnce();
    expect(addWebhook).toHaveBeenCalledWith(active);
  });

  it("registers the typing_indicator hook next to the inbound one", async () => {
    const active = "https://active.ngrok-free.app/sendblue/webhook";
    const typing = "https://active.ngrok-free.app/sendblue/typing";
    const stale = "https://stale.ngrok-free.app/sendblue/typing";
    expect(typingWebhookUrl(active)).toBe(typing);
    expect(typingWebhookUrl("https://boop.example.com/")).toBe("https://boop.example.com/sendblue/typing");

    const removeWebhook = vi.fn(async () => undefined);
    const addWebhook = vi.fn(async () => undefined);
    const result = await syncTypingWebhook(
      {},
      active,
      [
        { type: "receive", url: active },
        { type: "typing_indicator", url: stale },
      ],
      removeWebhook,
      addWebhook,
    );
    expect(result).toBe("synchronized");
    expect(removeWebhook).toHaveBeenCalledWith(stale);
    expect(addWebhook).toHaveBeenCalledWith(typing);
  });

  it("leaves an existing typing hook alone, honours the opt-out, and never throws", async () => {
    const active = "https://active.ngrok-free.app/sendblue/webhook";
    const addWebhook = vi.fn(async () => undefined);
    await syncTypingWebhook(
      {},
      active,
      [{ type: "typing_indicator", url: typingWebhookUrl(active) }],
      vi.fn(async () => undefined),
      addWebhook,
    );
    expect(addWebhook).not.toHaveBeenCalled();

    expect(await syncTypingWebhook({ SENDBLUE_TYPING_WEBHOOK: "false" }, active, [], vi.fn(), addWebhook)).toBe(
      "disabled",
    );
    expect(addWebhook).not.toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = vi.fn(async () => {
      throw new Error("Sendblue down");
    });
    await expect(syncTypingWebhook({}, active, [], vi.fn(), failing)).resolves.toBe("synchronized");
    error.mockRestore();
  });
});
