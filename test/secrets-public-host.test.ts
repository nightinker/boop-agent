import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { isPublicServerRequest, isTrustedLocalRequest } from "../server/local-access.js";
import {
  RateLimiter,
  SECRETS_PORTAL_PASSCODE_NAME,
  createSecretsPublicApp,
  describeRemoteSecretEntry,
  isSecretsHostRequest,
  safeEqual,
  secretsHostDispatcher,
  secretsHostWebSocketGuard,
  secretsPublicConfigFromEnv,
  type SecretsPublicConfig,
} from "../server/secrets/public-host.js";
import { SecretRequestRegistry, SECRET_REQUEST_TTL_MS } from "../server/secrets/requests.js";
import { createSecretsRouter } from "../server/secrets/routes.js";
import { SecretStore } from "../server/secrets/store.js";
import { createSecretDispatcherTools, secretEntryUrls } from "../server/secrets/tools.js";

// Fake values built at runtime; nothing key-shaped sits in the repo.
const FAKE = "fake" + "Secret" + "Value-1234567890";
const PASSCODE = "correct" + "-horse-battery";
const HOST = "secret.example.com";
const BASE = `https://${HOST}`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "boop-secrets-host-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fileStore() {
  return new SecretStore({ dir, prefer: "file", platform: "darwin", updateRedactor: false });
}

function config(): SecretsPublicConfig {
  const c = secretsPublicConfigFromEnv({ SECRETS_PUBLIC_BASE_URL: BASE });
  if (!c.ok) throw new Error("bad config");
  return c.config;
}

/**
 * The main app as index.ts builds it: secrets-host dispatch first, then the
 * local/Access check that 404s everything else, then the dashboard API and
 * the local /secrets router.
 */
function mainApp(opts: { store: SecretStore; requests: SecretRequestRegistry; now?: () => number }) {
  const app = express();
  const secretsApp = createSecretsPublicApp({
    config: config(),
    store: () => opts.store,
    requests: opts.requests,
    platform: "darwin",
    now: opts.now,
  });
  app.use(secretsHostDispatcher(config(), secretsApp));
  app.use((req, res, next) => {
    if (isPublicServerRequest(req) || isTrustedLocalRequest(req)) next();
    else res.status(404).json({ error: "not found" });
  });
  app.get("/runtime-config", (_req, res) => void res.json({ dashboard: true }));
  app.use("/secrets", createSecretsRouter({ store: () => opts.store, requests: opts.requests, platform: "darwin" }));
  return app;
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP so the Host header can be set (fetch won't allow it). */
async function serve(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const call = (
    method: string,
    urlPath: string,
    o: { host?: string; headers?: Record<string, string>; form?: Record<string, string> } = {},
  ) =>
    new Promise<Res>((resolve, reject) => {
      const body = o.form ? new URLSearchParams(o.form).toString() : undefined;
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method,
          path: urlPath,
          headers: {
            host: o.host ?? HOST,
            "x-forwarded-proto": "https",
            ...(body ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) } : {}),
            ...o.headers,
          },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

function cookieFrom(res: Res): string {
  const set = res.headers["set-cookie"];
  const first = (Array.isArray(set) ? set[0] : set) ?? "";
  return first.split(";")[0];
}

function csrfFrom(html: string): string {
  return html.match(/name="csrf" value="([^"]+)"/)![1];
}

/** Opens the link, logs in, and returns the cookie + CSRF for the entry form. */
async function logIn(call: Awaited<ReturnType<typeof serve>>["call"], token: string) {
  const login = await call("GET", `/secrets/enter/${token}`);
  expect(login.status).toBe(200);
  expect(login.body).toContain('name="passcode"');
  const pre = cookieFrom(login);
  const posted = await call("POST", `/secrets/enter/${token}/login`, {
    headers: { cookie: pre, origin: BASE },
    form: { csrf: csrfFrom(login.body), passcode: PASSCODE },
  });
  expect(posted.status).toBe(303);
  const cookie = cookieFrom(posted);
  expect(cookie).not.toBe(pre);
  const form = await call("GET", `/secrets/enter/${token}`, { headers: { cookie } });
  expect(form.status).toBe(200);
  expect(form.body).toContain('name="value"');
  return { cookie, csrf: csrfFrom(form.body) };
}

describe("SECRETS_PUBLIC_BASE_URL", () => {
  it("is off when unset and refuses http, paths and localhost", () => {
    expect(secretsPublicConfigFromEnv({})).toEqual({ ok: false, reason: null });
    for (const bad of ["http://secret.example.com", "https://secret.example.com/x", "https://localhost", "nope"]) {
      expect(secretsPublicConfigFromEnv({ SECRETS_PUBLIC_BASE_URL: bad }).ok, bad).toBe(false);
    }
    expect(secretsPublicConfigFromEnv({ SECRETS_PUBLIC_BASE_URL: "https://Secret.Example.com/", SECRETS_PUBLIC_PORT: "3457" })).toEqual({
      ok: true,
      config: { baseUrl: BASE, host: HOST, origin: BASE, port: 3457 },
    });
  });

  it("makes request_secret hand out links on that host", async () => {
    expect(secretEntryUrls("t", { SECRETS_PUBLIC_BASE_URL: BASE }).remote).toBe(`${BASE}/secrets/enter/t`);
    const store = fileStore();
    const requests = new SecretRequestRegistry();
    const tools = createSecretDispatcherTools("sms:test", {
      store: () => store,
      requests,
      platform: "darwin",
      env: { PORT: "3456", SECRETS_PUBLIC_BASE_URL: BASE },
    });
    const req = tools.find((t) => t.name === "request_secret")!;
    const locked = await req.handle({ name: "R2_SECRET", description: "x" });
    expect(locked.text).toContain(`${BASE}/secrets/enter/`);
    expect(locked.text).toContain(`won't open until ${SECRETS_PORTAL_PASSCODE_NAME} is set`);
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const ready = await req.handle({ name: "R2_SECRET", description: "x" });
    expect(ready.text).toMatch(/asks for the secrets passcode first/);
    // The passcode itself only gets a local link.
    const own = await req.handle({ name: SECRETS_PORTAL_PASSCODE_NAME, description: "x" });
    expect(own.text).not.toContain(BASE);
  });

  it("shows a get_config status line", async () => {
    const store = fileStore();
    const off = await describeRemoteSecretEntry({ env: {}, store: () => store, platform: "darwin" });
    expect(off.enabled).toBe(false);
    expect(off.status).toMatch(/^Remote secret entry: off/);
    const env = { SECRETS_PUBLIC_BASE_URL: BASE };
    const locked = await describeRemoteSecretEntry({ env, store: () => store, platform: "darwin" });
    expect(locked).toMatchObject({ enabled: false, baseUrl: BASE, passcodeSet: false });
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const on = await describeRemoteSecretEntry({ env, store: () => store, platform: "darwin" });
    expect(on).toMatchObject({ enabled: true, baseUrl: BASE });
    expect(on.status).toBe(`Remote secret entry: enabled at ${BASE}`);
    expect(JSON.stringify(on)).not.toContain(PASSCODE);
  });
});

describe("host matching and helpers", () => {
  it("matches Host, X-Forwarded-Host and Forwarded host=", () => {
    const c = config();
    expect(isSecretsHostRequest({ host: `${HOST}:443` }, c)).toBe(true);
    expect(isSecretsHostRequest({ host: "localhost:3456", "x-forwarded-host": HOST }, c)).toBe(true);
    expect(isSecretsHostRequest({ host: "localhost", forwarded: `for=1.2.3.4;host=${HOST};proto=https` }, c)).toBe(true);
    expect(isSecretsHostRequest({ host: "agent.example.com" }, c)).toBe(false);
    expect(isSecretsHostRequest({ host: `${HOST}.evil.com` }, c)).toBe(false);
  });

  it("compares in constant time and rate limits", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    let now = 0;
    const rl = new RateLimiter(2, 1000, () => now);
    expect(rl.hit("a")).toBe(true);
    expect(rl.hit("a")).toBe(true);
    expect(rl.hit("a")).toBe(false);
    expect(rl.blocked("a")).toBe(true);
    expect(rl.hit("b")).toBe(true);
    now = 1000;
    expect(rl.hit("a")).toBe(true);
  });
});

describe("the secrets host on the main port", () => {
  it("serves the entry route for a non-localhost Host (the tunnelled 'not found' bug)", async () => {
    const store = fileStore();
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const requests = new SecretRequestRegistry();
    const { token } = requests.create({ name: "MY_KEY", description: "desc" });
    const { call, close } = await serve(mainApp({ store, requests }));
    try {
      // Before: any non-local Host was {"error":"not found"}. Still true for other hosts.
      const other = await call("GET", `/secrets/enter/${token}`, { host: "abc.ngrok-free.app" });
      expect(other.status).toBe(404);
      expect(other.body).toBe('{"error":"not found"}');

      const res = await call("GET", `/secrets/enter/${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain("passcode");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["strict-transport-security"]).toContain("max-age=");
      expect(String(res.headers["set-cookie"])).toMatch(/Secure; HttpOnly; SameSite=Strict/);
    } finally {
      await close();
    }
  });

  it("exposes nothing else on that host: dashboard, API, local secrets routes", async () => {
    const store = fileStore();
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const { call, close } = await serve(mainApp({ store, requests: new SecretRequestRegistry() }));
    try {
      for (const [method, p] of [
        ["GET", "/"],
        ["GET", "/runtime-config"],
        ["GET", "/api/runtime-config"],
        ["GET", "/secrets/status"],
        ["POST", "/secrets/MY_KEY/delete"],
        ["GET", "/health"],
        ["POST", "/sendblue/webhook"],
      ] as const) {
        const res = await call(method, p);
        expect(res.status, `${method} ${p}`).toBe(404);
        expect(res.body).toBe("Not found");
      }
      expect(await store.has(SECRETS_PORTAL_PASSCODE_NAME)).toBe(true);
      // The dashboard itself still answers locally.
      const local = await call("GET", "/runtime-config", { host: "localhost:3456" });
      expect(JSON.parse(local.body)).toEqual({ dashboard: true });
    } finally {
      await close();
    }
  });

  it("logs in with the Keychain passcode, saves once, and never echoes value or passcode", async () => {
    const store = fileStore();
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const requests = new SecretRequestRegistry();
    const { token } = requests.create({ name: "MY_KEY", description: "desc" });
    const { call, close } = await serve(mainApp({ store, requests }));
    try {
      const { cookie, csrf } = await logIn(call, token);
      const saved = await call("POST", `/secrets/enter/${token}`, { headers: { cookie, origin: BASE }, form: { csrf, value: FAKE } });
      expect(saved.status).toBe(200);
      expect(saved.body).toContain("Saved MY_KEY");
      expect(saved.body).not.toContain(FAKE);
      expect(saved.body).not.toContain(PASSCODE);
      expect(await store.get("MY_KEY")).toBe(FAKE);

      const again = await call("POST", `/secrets/enter/${token}`, { headers: { cookie, origin: BASE }, form: { csrf, value: FAKE } });
      expect(again.status).toBe(410);
    } finally {
      await close();
    }
  });

  it("shows no form without login and rejects a wrong passcode", async () => {
    const store = fileStore();
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const requests = new SecretRequestRegistry();
    const { token } = requests.create({ name: "MY_KEY", description: "" });
    const { call, close } = await serve(mainApp({ store, requests }));
    try {
      const page = await call("GET", `/secrets/enter/${token}`);
      expect(page.body).not.toContain('name="value"');
      const cookie = cookieFrom(page);
      const wrong = await call("POST", `/secrets/enter/${token}/login`, {
        headers: { cookie },
        form: { csrf: csrfFrom(page.body), passcode: "wrong-passcode" },
      });
      expect(wrong.status).toBe(401);
      // Posting a value straight away, unauthenticated, saves nothing.
      const direct = await call("POST", `/secrets/enter/${token}`, { headers: { cookie }, form: { csrf: csrfFrom(page.body), value: FAKE } });
      expect(direct.status).toBe(401);
      expect(await store.has("MY_KEY")).toBe(false);
      expect(requests.peek(token).ok).toBe(true);
    } finally {
      await close();
    }
  });

  it("requires CSRF tokens and same origin on submit", async () => {
    const store = fileStore();
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const requests = new SecretRequestRegistry();
    const { token } = requests.create({ name: "MY_KEY", description: "" });
    const { call, close } = await serve(mainApp({ store, requests }));
    try {
      const page = await call("GET", `/secrets/enter/${token}`);
      const noCsrf = await call("POST", `/secrets/enter/${token}/login`, { headers: { cookie: cookieFrom(page) }, form: { passcode: PASSCODE } });
      expect(noCsrf.status).toBe(403);
      const { cookie, csrf } = await logIn(call, token);
      const badToken = await call("POST", `/secrets/enter/${token}`, { headers: { cookie }, form: { csrf: "x" + csrf, value: FAKE } });
      expect(badToken.status).toBe(403);
      const crossSite = await call("POST", `/secrets/enter/${token}`, {
        headers: { cookie, origin: "https://evil.example.net" },
        form: { csrf, value: FAKE },
      });
      expect(crossSite.status).toBe(403);
      expect(await store.has("MY_KEY")).toBe(false);
    } finally {
      await close();
    }
  });

  it("refuses plain HTTP, stays locked without a passcode, and expires links", async () => {
    const store = fileStore();
    let now = Date.now();
    const requests = new SecretRequestRegistry(() => now);
    const { token } = requests.create({ name: "MY_KEY", description: "" });
    const { call, close } = await serve(mainApp({ store, requests, now: () => now }));
    try {
      const http = await call("GET", `/secrets/enter/${token}`, { headers: { "x-forwarded-proto": "http" } });
      expect(http.status).toBe(403);
      // A client-sent "https" ahead of the tunnel's own "http" doesn't count.
      const spoofed = await call("GET", `/secrets/enter/${token}`, { headers: { "x-forwarded-proto": "https, http" } });
      expect(spoofed.status).toBe(403);
      const forwarded = await call("GET", `/secrets/enter/${token}`, {
        headers: { "x-forwarded-proto": "https", forwarded: "for=1.2.3.4;proto=http" },
      });
      expect(forwarded.status).toBe(403);
      const locked = await call("GET", `/secrets/enter/${token}`);
      expect(locked.status).toBe(503);
      expect(locked.body).not.toContain('name="value"');
      now += SECRET_REQUEST_TTL_MS;
      const expired = await call("GET", `/secrets/enter/${token}`);
      expect(expired.status).toBe(410);
    } finally {
      await close();
    }
  });

  it("rate limits guessing", async () => {
    const store = fileStore();
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const requests = new SecretRequestRegistry();
    const { token } = requests.create({ name: "MY_KEY", description: "" });
    const { call, close } = await serve(mainApp({ store, requests }));
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await call("GET", `/secrets/enter/guess${i}`)).status);
      expect(statuses.slice(0, 10).every((s) => s === 410)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      // Even the right link is held off for that client.
      expect((await call("GET", `/secrets/enter/${token}`)).status).toBe(429);
    } finally {
      await close();
    }
  });

  it("won't let the remote host change its own passcode", async () => {
    const store = fileStore();
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const requests = new SecretRequestRegistry();
    const { token } = requests.create({ name: SECRETS_PORTAL_PASSCODE_NAME, description: "" });
    const { call, close } = await serve(mainApp({ store, requests }));
    try {
      expect((await call("GET", `/secrets/enter/${token}`)).status).toBe(403);
    } finally {
      await close();
    }
  });
});

describe("websockets on the secrets host", () => {
  it("refuses /ws upgrades addressed to the secrets host, and only those", async () => {
    const app = express();
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const wss = new WebSocketServer({ server, path: "/ws", verifyClient: secretsHostWebSocketGuard(config()) });
    const port = (server.address() as AddressInfo).port;
    const connect = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
        ws.on("open", () => (ws.close(), resolve(101)));
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => resolve(-1));
      });
    try {
      expect(await connect({ host: HOST })).toBe(404);
      expect(await connect({ host: "localhost:3456", "x-forwarded-host": HOST })).toBe(404);
      expect(await connect({ host: "localhost:3456" })).toBe(101);
    } finally {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise((r) => server.close(r));
    }
  });
});
