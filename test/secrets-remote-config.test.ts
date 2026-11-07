import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSecretsPublicApp,
  describeRemoteSecretEntry,
  SECRETS_PORTAL_PASSCODE_NAME,
} from "../server/secrets/public-host.js";
import {
  DEFAULT_SECRETS_REMOTE_PORT,
  PROBE_HEADER,
  probeSecretsTunnel,
  resolveSecretsRemoteConfig,
  secretsRemoteConfigPath,
  startSecretsRemoteListener,
  type RemoteEntryRuntime,
} from "../server/secrets/remote-config.js";
import { SecretRequestRegistry } from "../server/secrets/requests.js";
import { SecretStore } from "../server/secrets/store.js";
import { createSecretDispatcherTools } from "../server/secrets/tools.js";
import { cloudflaredLaunchAgentPlist, cloudflaredSecretsConfig } from "../server/secrets/tunnel-launchd.js";

const PASSCODE = "correct" + "-horse-battery";
const BASE = "https://secret.example.com";

let home: string;
let configFile: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "boop-secrets-remote-test-"));
  configFile = path.join(home, ".config", "boop", "secrets-remote.json");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeConfig(content: unknown) {
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, typeof content === "string" ? content : JSON.stringify(content));
}

function fileStore() {
  return new SecretStore({ dir: path.join(home, "store"), prefer: "file", platform: "darwin", updateRedactor: false });
}

function runtime(over: Partial<RemoteEntryRuntime> = {}): RemoteEntryRuntime {
  return {
    started: true,
    activeBaseUrl: BASE,
    listener: { state: "listening", port: DEFAULT_SECRETS_REMOTE_PORT, error: null },
    probeToken: "probe-token-for-tests",
    ...over,
  };
}

describe("resolveSecretsRemoteConfig", () => {
  it("finds the file under HOME, or BOOP_SECRETS_REMOTE_CONFIG", () => {
    expect(secretsRemoteConfigPath({ HOME: home })).toBe(configFile);
    expect(secretsRemoteConfigPath({ HOME: home, BOOP_SECRETS_REMOTE_CONFIG: "~/x.json" })).toBe(path.join(home, "x.json"));
    expect(secretsRemoteConfigPath({})).toBeNull();
  });

  it("says exactly what's missing when nothing is configured", () => {
    const r = resolveSecretsRemoteConfig({ HOME: home });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.source).toBe("none");
    expect(r.missing.join()).toContain(configFile);
    expect(r.missing.join()).toContain("publicBaseUrl");
  });

  it("reads the file and defaults the port to 3457", async () => {
    await writeConfig({ publicBaseUrl: `${BASE}/` });
    const r = resolveSecretsRemoteConfig({ HOME: home });
    expect(r).toMatchObject({ ok: true, source: "file", configPath: configFile });
    if (r.ok) expect(r.config).toMatchObject({ baseUrl: BASE, host: "secret.example.com", port: 3457 });
  });

  it("the file wins over env vars, with a warning", async () => {
    await writeConfig({ publicBaseUrl: BASE, port: 4000 });
    const r = resolveSecretsRemoteConfig({ HOME: home, SECRETS_PUBLIC_BASE_URL: "https://other.example.com" });
    expect(r.ok && r.config.port).toBe(4000);
    expect(r.ok && r.config.baseUrl).toBe(BASE);
    expect(r.warnings.join()).toMatch(/SECRETS_PUBLIC_BASE_URL .* ignored/);
  });

  it("falls back to env vars with a move-it warning", () => {
    const r = resolveSecretsRemoteConfig({ HOME: home, SECRETS_PUBLIC_BASE_URL: BASE, SECRETS_PUBLIC_PORT: "3457" });
    expect(r).toMatchObject({ ok: true, source: "env" });
    expect(r.warnings.join()).toContain(configFile);
  });

  it("reports a broken or incomplete file instead of falling back", async () => {
    await writeConfig("{not json");
    const broken = resolveSecretsRemoteConfig({ HOME: home, SECRETS_PUBLIC_BASE_URL: BASE });
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.missing.join()).toMatch(/isn't valid JSON/);
    await writeConfig({ port: 3457 });
    const incomplete = resolveSecretsRemoteConfig({ HOME: home });
    expect(!incomplete.ok && incomplete.missing.join()).toMatch(/"publicBaseUrl"/);
    await writeConfig({ publicBaseUrl: "http://secret.example.com" });
    const http = resolveSecretsRemoteConfig({ HOME: home });
    expect(!http.ok && http.missing.join()).toMatch(/must start with https/);
  });

  it("flags a passcode in the environment without echoing it", () => {
    const r = resolveSecretsRemoteConfig({ HOME: home, SECRETS_PORTAL_PASSCODE: PASSCODE });
    expect(r.warnings.join()).toMatch(/SECRETS_PORTAL_PASSCODE .* ignored/);
    expect(JSON.stringify(r)).not.toContain(PASSCODE);
  });
});

describe("startSecretsRemoteListener", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const { port } = s.address() as AddressInfo;
    await new Promise((r) => s.close(r));
    return port;
  }

  it("retries while an old process still holds the port, then comes up", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    const state = { state: "off" as const, port: null, error: null } as RemoteEntryRuntime["listener"];
    const started = startSecretsRemoteListener({
      port,
      handler: (_req, res) => res.end("hi"),
      retries: 20,
      retryDelayMs: 20,
      state,
      log: () => {},
    });
    setTimeout(() => blocker.close(), 60);
    const server = await started;
    expect(server).not.toBeNull();
    servers.push(server!);
    expect(state).toEqual({ state: "listening", port, error: null });
  });

  it("reports failure when the port stays taken", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    servers.push(blocker);
    const state = { state: "off" as const, port: null, error: null } as RemoteEntryRuntime["listener"];
    const server = await startSecretsRemoteListener({
      port,
      handler: () => {},
      retries: 1,
      retryDelayMs: 5,
      state,
      log: () => {},
    });
    expect(server).toBeNull();
    expect(state.state).toBe("failed");
    expect(state.error).toContain(String(port));
  });
});

describe("tunnel probe", () => {
  it("the secrets app answers the probe only for the right token", async () => {
    const app = createSecretsPublicApp({
      config: { baseUrl: BASE, host: "secret.example.com", origin: BASE, port: null },
      store: () => fileStore(),
      requests: new SecretRequestRegistry(),
      platform: "darwin",
      probeToken: "right-token",
    });
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const get = (p: string) =>
      new Promise<{ status: number; probe: string | undefined }>((resolve, reject) => {
        httpRequest({ host: "127.0.0.1", port, path: p, headers: { "x-forwarded-proto": "https" } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, probe: res.headers[PROBE_HEADER] as string | undefined });
        })
          .on("error", reject)
          .end();
      });
    try {
      expect(await get("/secrets/probe/right-token")).toEqual({ status: 204, probe: "ok" });
      expect((await get("/secrets/probe/wrong-token")).status).toBe(404);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("classifies reachable, misrouted and down tunnels", async () => {
    const ok = await probeSecretsTunnel(BASE, "t", {
      fetch: (async () => new Response(null, { status: 204, headers: { [PROBE_HEADER]: "ok" } })) as typeof fetch,
    });
    expect(ok).toMatchObject({ checked: true, reachable: true });
    const misrouted = await probeSecretsTunnel(BASE, "t", {
      fetch: (async () => new Response("Not found", { status: 404 })) as typeof fetch,
    });
    expect(misrouted.reachable).toBe(false);
    expect(misrouted.detail).toMatch(/404/);
    const down = await probeSecretsTunnel(BASE, "t", {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(down).toMatchObject({ reachable: false });
    expect(down.detail).toMatch(/tunnel running/);
  });
});

describe("get_config status", () => {
  it("shows base URL, listener and tunnel state, and what's missing", async () => {
    await writeConfig({ publicBaseUrl: BASE });
    const store = fileStore();
    const env = { HOME: home };
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const locked = await describeRemoteSecretEntry({ env, store: () => store, platform: "darwin", runtime: runtime(), probeTunnel: true, fetch: down });
    expect(locked).toMatchObject({ enabled: false, baseUrl: BASE, port: 3457, source: "file", passcodeSet: false });
    expect(locked.missing[0]).toContain(SECRETS_PORTAL_PASSCODE_NAME);
    expect(locked.missing.join()).toMatch(/working tunnel/);

    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const up = (async () => new Response(null, { status: 204, headers: { [PROBE_HEADER]: "ok" } })) as typeof fetch;
    const on = await describeRemoteSecretEntry({ env, store: () => store, platform: "darwin", runtime: runtime(), probeTunnel: true, fetch: up });
    expect(on).toMatchObject({ enabled: true, missing: [], listener: { state: "listening", port: 3457 } });
    expect(on.tunnel.reachable).toBe(true);
    expect(on.status).toBe(`Remote secret entry: enabled at ${BASE} (also on 127.0.0.1:3457); tunnel reachable`);
    expect(JSON.stringify(on)).not.toContain(PASSCODE);

    const failed = await describeRemoteSecretEntry({
      env,
      store: () => store,
      platform: "darwin",
      runtime: runtime({ listener: { state: "failed", port: 3457, error: "port 3457 is in use by another process" } }),
    });
    expect(failed.status).toMatch(/needs the listener on 127\.0\.0\.1:3457 \(failed: port 3457 is in use/);

    const stale = await describeRemoteSecretEntry({ env, store: () => store, platform: "darwin", runtime: runtime({ activeBaseUrl: null }) });
    expect(stale.missing.join()).toMatch(/restart/);
  });

  it("is off with an exact missing list when unconfigured", async () => {
    const s = await describeRemoteSecretEntry({ env: { HOME: home }, store: () => fileStore(), platform: "darwin", runtime: runtime() });
    expect(s.enabled).toBe(false);
    expect(s.source).toBe("none");
    expect(s.status).toMatch(/^Remote secret entry: off .*Missing: public base URL/);
  });
});

describe("request_secret", () => {
  it("returns the remote link from the config file", async () => {
    await writeConfig({ publicBaseUrl: BASE });
    const store = fileStore();
    await store.set(SECRETS_PORTAL_PASSCODE_NAME, PASSCODE);
    const tools = createSecretDispatcherTools("c", {
      store: () => store,
      requests: new SecretRequestRegistry(),
      platform: "darwin",
      env: { HOME: home, PORT: "3456" },
      runtime: runtime(),
    });
    const res = await tools.find((t) => t.name === "request_secret")!.handle({ name: "R2_SECRET", description: "x" });
    expect(res.text).toContain(`${BASE}/secrets/enter/`);
    expect(res.text).toContain("asks for the secrets passcode first");
    expect(res.text).not.toContain("Warning");
    expect(res.text).not.toContain(PASSCODE);
  });

  it("says exactly what's missing when there's no config", async () => {
    const tools = createSecretDispatcherTools("c", {
      store: () => fileStore(),
      requests: new SecretRequestRegistry(),
      platform: "darwin",
      env: { HOME: home, PORT: "3456" },
      runtime: runtime(),
    });
    const res = await tools.find((t) => t.name === "request_secret")!.handle({ name: "R2_SECRET", description: "x" });
    expect(res.text).toContain("http://localhost:3456/secrets/enter/");
    expect(res.text).toMatch(/No remote link: remote secret entry isn't configured\. Missing: public base URL/);
    expect(res.text).toContain(configFile);
  });

  it("warns when the listener is down or the config changed since startup", async () => {
    await writeConfig({ publicBaseUrl: BASE });
    const make = (rt: RemoteEntryRuntime) =>
      createSecretDispatcherTools("c", {
        store: () => fileStore(),
        requests: new SecretRequestRegistry(),
        platform: "darwin",
        env: { HOME: home },
        runtime: rt,
      }).find((t) => t.name === "request_secret")!;
    const down = await make(runtime({ listener: { state: "failed", port: 3457, error: "boom" } })).handle({ name: "A_KEY", description: "x" });
    expect(down.text).toMatch(/listener on 127\.0\.0\.1:3457 isn't up \(boom\)/);
    const stale = await make(runtime({ activeBaseUrl: null })).handle({ name: "A_KEY", description: "x" });
    expect(stale.text).toMatch(/restart Boop/);
  });
});

describe("tunnel launchd files", () => {
  it("routes only the secrets hostname and keeps the tunnel alive", () => {
    const yml = cloudflaredSecretsConfig({
      tunnel: "00000000-0000-0000-0000-000000000000",
      credentialsFile: "/Users/you/.cloudflared/00000000-0000-0000-0000-000000000000.json",
      hostname: "secret.example.com",
      port: 3457,
    });
    expect(yml).toContain('hostname: "secret.example.com"');
    expect(yml).toContain("service: http://127.0.0.1:3457");
    expect(yml.trim().endsWith("service: http_status:404")).toBe(true);
    const plist = cloudflaredLaunchAgentPlist({
      cloudflaredPath: "/opt/homebrew/bin/cloudflared",
      configPath: "/Users/you/.cloudflared/boop-secrets.yml",
      logPath: "/Users/you/Library/Logs/boop-secrets-tunnel.log",
    });
    expect(plist).toContain("<string>dev.boop.secrets-tunnel</string>");
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toContain("<string>/Users/you/.cloudflared/boop-secrets.yml</string>");
  });
});
