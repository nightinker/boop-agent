import { describe, expect, it, vi } from "vitest";
import { collectAllPages } from "../server/composio.js";

describe("Composio connected accounts pagination", () => {
  it("collects connections past the first page", async () => {
    const fetchPage = vi.fn(async (cursor?: string) => {
      if (!cursor) return { items: ["gmail", "slack"], nextCursor: "page-2" };
      if (cursor === "page-2") return { items: ["github"], nextCursor: "page-3" };
      return { items: ["asana"], nextCursor: null };
    });

    const items = await collectAllPages(fetchPage);

    expect(items).toEqual(["gmail", "slack", "github", "asana"]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, "page-2");
    expect(fetchPage).toHaveBeenNthCalledWith(3, "page-3");
  });

  it("returns a single page when there is no next cursor", async () => {
    const fetchPage = vi.fn(async () => ({ items: ["gmail"] }));

    expect(await collectAllPages(fetchPage)).toEqual(["gmail"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("returns nothing for an empty account", async () => {
    expect(await collectAllPages(async () => ({ items: [], nextCursor: null }))).toEqual([]);
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    const fetchPage = vi.fn(async () => ({ items: ["x"], nextCursor: "same-page" }));

    await expect(collectAllPages(fetchPage)).rejects.toThrow("repeated pagination cursor");
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
