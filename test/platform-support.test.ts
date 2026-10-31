import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every Convex setting reads as "true", as if the owner had switched Apple data
// and the local browser on from their Mac (settings are shared via Convex).
vi.mock("../server/convex-client.js", () => ({
  convex: {
    query: vi.fn(async () => "true"),
    mutation: vi.fn(async () => null),
  },
}));

import {
  getPlatformSupport,
  hostPlatformPromptNote,
  isAppleDataSupported,
  isLocalBrowserSupported,
} from "../server/platform-support.js";
import { registerAppleIntegration } from "../server/integrations/apple-loader.js";
import { registerBrowserIntegration } from "../server/integrations/browser-loader.js";
import { getIntegration, listIntegrations } from "../server/integrations/registry.js";
import {
  clearAppleSettingsCache,
  clearBrowserSettingsCache,
  getAppleSettings,
  getBrowserSettings,
} from "../server/runtime-config.js";
import { createAppleRouter } from "../server/apple-routes.js";
import { createBrowserRouter } from "../server/browser-routes.js";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

async function withServer<T>(
  router: express.Router,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  clearAppleSettingsCache();
  clearBrowserSettingsCache();
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe("platform support", () => {
  it("offers Apple data and the local browser only on macOS", () => {
    expect(getPlatformSupport("darwin")).toEqual({
      platform: "darwin",
      appleData: true,
      localBrowser: true,
    });
    for (const platform of ["linux", "win32", "freebsd"] as NodeJS.Platform[]) {
      expect(isAppleDataSupported(platform)).toBe(false);
      expect(isLocalBrowserSupported(platform)).toBe(false);
    }
  });

  it("adds a host note to the agent prompt only off macOS", () => {
    expect(hostPlatformPromptNote("darwin")).toBe("");
    const note = hostPlatformPromptNote("linux");
    expect(note).toContain("linux server");
    expect(note).toContain('"apple"');
    expect(note).toContain('"browser"');
    expect(note).toMatch(/do not tell them to enable it in Settings/);
  });
});

describe("integration registration", () => {
  it("skips the Apple and browser integrations on Linux", () => {
    const before = listIntegrations().map((i) => i.name);
    expect(registerAppleIntegration("linux")).toBe(false);
    expect(registerBrowserIntegration("linux")).toBe(false);
    expect(listIntegrations().map((i) => i.name)).toEqual(before);
    expect(getIntegration("apple")).toBeUndefined();
    expect(getIntegration("browser")).toBeUndefined();
  });

  it("still registers them on macOS", () => {
    expect(registerAppleIntegration("darwin")).toBe(true);
    expect(registerBrowserIntegration("darwin")).toBe(true);
    expect(getIntegration("apple")).toBeDefined();
    expect(getIntegration("browser")).toBeDefined();
  });
});

describe("settings on Linux", () => {
  it("forces Apple data off even when Convex settings say on", async () => {
    setPlatform("linux");
    expect(await getAppleSettings()).toEqual({
      enabled: false,
      messagesEnabled: false,
      notesEnabled: false,
      remindersEnabled: false,
    });
  });

  it("forces local browser use off even when Convex settings say on", async () => {
    setPlatform("linux");
    expect((await getBrowserSettings()).enabled).toBe(false);
  });

  it("keeps honouring the settings on macOS", async () => {
    setPlatform("darwin");
    expect((await getAppleSettings()).enabled).toBe(true);
    expect((await getBrowserSettings()).enabled).toBe(true);
  });
});

describe("routes on Linux", () => {
  it("reports Apple data as unsupported and refuses to enable it", async () => {
    setPlatform("linux");
    await withServer(createAppleRouter(), async (base) => {
      const status = await fetch(`${base}/status`);
      expect(status.status).toBe(200);
      const body = await status.json();
      expect(body.supported).toBe(false);
      expect(body.enabled).toBe(false);
      expect(body.bridge.source).toBe("unavailable");

      for (const path of ["/enable", "/messages/enable", "/request-notes-access"]) {
        const res = await fetch(`${base}${path}`, { method: "POST" });
        expect(res.status).toBe(409);
        expect((await res.json()).supported).toBe(false);
      }
    });
  });

  it("reports the local browser as unsupported and refuses to launch it", async () => {
    setPlatform("linux");
    await withServer(createBrowserRouter(), async (base) => {
      const status = await fetch(`${base}/status`);
      expect(status.status).toBe(200);
      const body = await status.json();
      expect(body.supported).toBe(false);
      expect(body.settings.enabled).toBe(false);

      for (const path of ["/launch", "/login", "/install"]) {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        expect(res.status).toBe(409);
      }
    });
  });
});
