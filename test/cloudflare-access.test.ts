import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accessConfigFromEnv,
  isAccessAuthenticatedRequest,
  resetAccessKeyCache,
  verifyAccessToken,
  type AccessConfig,
} from "../server/cloudflare-access.js";
import { mountDashboard } from "../server/dashboard.js";

const config: AccessConfig = {
  teamDomain: "team.cloudflareaccess.com",
  audience: "aud-123",
  origin: "https://agent.example.com",
};
const now = Date.parse("2026-11-01T10:00:00Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const fetcher = async () => new Map<string, KeyObject>([["kid-1", publicKey]]);

function token(payload: Record<string, unknown>, key = privateKey, kid = "kid-1"): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc(payload)}`;
  const signature = createSign("RSA-SHA256").update(body).sign(key).toString("base64url");
  return `${body}.${signature}`;
}

const valid = {
  aud: ["aud-123"],
  iss: "https://team.cloudflareaccess.com",
  email: "me@example.com",
  exp: now / 1000 + 600,
  iat: now / 1000,
};

beforeEach(() => resetAccessKeyCache());

describe("verifying a Cloudflare Access token", () => {
  it("accepts a token signed by the team for this app", async () => {
    expect(await verifyAccessToken(token(valid), config, { fetcher, now })).toBe("me@example.com");
  });

  it("rejects a token signed by someone else", async () => {
    expect(await verifyAccessToken(token(valid, other.privateKey), config, { fetcher, now })).toBeNull();
  });

  it("rejects an unknown key id, the wrong app, the wrong team, or an expired token", async () => {
    expect(await verifyAccessToken(token(valid, privateKey, "kid-x"), config, { fetcher, now })).toBeNull();
    expect(await verifyAccessToken(token({ ...valid, aud: ["other-app"] }), config, { fetcher, now })).toBeNull();
    expect(
      await verifyAccessToken(token({ ...valid, iss: "https://evil.cloudflareaccess.com" }), config, { fetcher, now }),
    ).toBeNull();
    expect(await verifyAccessToken(token({ ...valid, exp: now / 1000 - 1 }), config, { fetcher, now })).toBeNull();
  });

  it("rejects malformed tokens and a tampered payload", async () => {
    expect(await verifyAccessToken("not-a-jwt", config, { fetcher, now })).toBeNull();
    const [h, , s] = token(valid).split(".");
    const forged = Buffer.from(JSON.stringify({ ...valid, email: "attacker@example.com" })).toString("base64url");
    expect(await verifyAccessToken(`${h}.${forged}.${s}`, config, { fetcher, now })).toBeNull();
  });

  it("rejects the token if loading Cloudflare's keys fails", async () => {
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await verifyAccessToken(token(valid), config, { fetcher: failing, now })).toBeNull();
  });
});

describe("trusting a request through Cloudflare Access", () => {
  const headers = (extra: Record<string, string> = {}) => ({ "cf-access-jwt-assertion": token(valid), ...extra });

  it("trusts a request with a valid token from the site itself", async () => {
    expect(await isAccessAuthenticatedRequest({ headers: headers() }, config, { fetcher, now })).toBe(true);
    expect(
      await isAccessAuthenticatedRequest(
        { headers: headers({ origin: "https://agent.example.com" }) },
        config,
        { fetcher, now },
      ),
    ).toBe(true);
  });

  it("refuses the same token sent from another website", async () => {
    expect(
      await isAccessAuthenticatedRequest({ headers: headers({ origin: "https://evil.example" }) }, config, {
        fetcher,
        now,
      }),
    ).toBe(false);
  });

  it("does nothing unless Access is configured", async () => {
    expect(await isAccessAuthenticatedRequest({ headers: headers() }, null, { fetcher, now })).toBe(false);
    expect(await isAccessAuthenticatedRequest({ headers: {} }, config, { fetcher, now })).toBe(false);
  });

  it("reads its settings from the environment", () => {
    expect(accessConfigFromEnv({})).toBeNull();
    expect(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" })).toBeNull();
    expect(
      accessConfigFromEnv({
        CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com/",
        CF_ACCESS_AUD: " aud-123 ",
        PUBLIC_URL: "https://agent.example.com/",
      }),
    ).toEqual(config);
  });
});

describe("serving the built dashboard", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boop-dash-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Boop</title>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function serve() {
    const app = express();
    app.get("/runtime-config", (_req, res) => {
      res.json({ ok: true });
    });
    mountDashboard(app, dir);
    app.use((_req, res) => {
      res.status(404).json({ error: "not found" });
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => server.close() };
  }

  it("serves the app shell, its assets, and page routes", async () => {
    const { base, close } = await serve();
    try {
      expect(await (await fetch(`${base}/`)).text()).toContain("<title>Boop</title>");
      expect(await (await fetch(`${base}/assets/app.js`)).text()).toBe("console.log(1)");
      const page = await fetch(`${base}/memory`, { headers: { accept: "text/html" } });
      expect(await page.text()).toContain("<title>Boop</title>");
    } finally {
      close();
    }
  });

  it("leaves API routes and unknown API calls alone", async () => {
    const { base, close } = await serve();
    try {
      expect(await (await fetch(`${base}/runtime-config`)).json()).toEqual({ ok: true });
      const missing = await fetch(`${base}/no-such-endpoint`, { headers: { accept: "*/*" } });
      expect(missing.status).toBe(404);
    } finally {
      close();
    }
  });

  it("does nothing when no dashboard is built", () => {
    const app = express();
    mountDashboard(app, null);
    expect(app.router?.stack?.length ?? 0).toBe(0);
  });
});
