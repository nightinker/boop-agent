import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PASTED_SECRET_REPLY,
  SECRET_PLACEHOLDER,
  hadSecretRemoved,
  isRandomLookingToken,
  redactSecrets,
  redactSecretsDeep,
  redactValues,
  scanForSecrets,
  setKnownSecrets,
} from "../server/secrets/redact.js";
import { SecretRequestRegistry, SECRET_REQUEST_TTL_MS } from "../server/secrets/requests.js";
import { formatRunResult, runCommandWithSecrets } from "../server/secrets/run.js";
import {
  SecretStore,
  keychainBackend,
  parseEnvFile,
  secretsSupported,
  validateSecretName,
  type SecretBackend,
} from "../server/secrets/store.js";
import { createSecretDispatcherTools, createSecretExecutionTools, secretEntryUrls } from "../server/secrets/tools.js";
import { createSecretsRouter } from "../server/secrets/routes.js";
import { SecretsSection } from "../debug/src/components/SecretsSection.js";

// Obviously fake values, built at runtime so no key-shaped literal sits in the repo.
const FAKE = "fake" + "Secret" + "Value-1234567890";
const FAKE_HEX = "ab".repeat(32);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "boop-secrets-test-"));
  setKnownSecrets([]);
});

afterEach(async () => {
  setKnownSecrets([]);
  await rm(dir, { recursive: true, force: true });
});

function fileStore(extra: Partial<ConstructorParameters<typeof SecretStore>[0]> = {}) {
  return new SecretStore({ dir, prefer: "file", platform: "darwin", updateRedactor: false, ...extra });
}

describe("redaction of known values", () => {
  const secrets = [{ name: "MY_TOKEN", value: "p@ss word/+=?&" }];

  it("redacts the raw value and its common encodings", () => {
    const v = secrets[0].value;
    const forms = [
      v,
      Buffer.from(v).toString("base64"),
      Buffer.from(v).toString("base64").replace(/=+$/, ""),
      Buffer.from(v).toString("base64url"),
      encodeURIComponent(v),
      Buffer.from(v).toString("hex"),
    ];
    for (const form of forms) {
      const out = redactValues(`before ${form} after`, secrets);
      expect(out).toBe("before [REDACTED:MY_TOKEN] after");
    }
  });

  it("redacts every occurrence and prefers the longest match", () => {
    const b64 = Buffer.from("p@ss word/+=?&").toString("base64");
    const out = redactValues(`${b64} and p@ss word/+=?& and ${b64}`, secrets);
    expect(out).not.toContain("p@ss");
    expect(out).not.toContain(b64);
    expect(out.match(/\[REDACTED:MY_TOKEN\]/g)).toHaveLength(3);
  });

  it("leaves very short values alone so output isn't mangled", () => {
    expect(redactValues("a b c", [{ name: "X", value: "a" }])).toBe("a b c");
  });

  it("uses the cache of stored values for logs, including nested tool inputs", () => {
    setKnownSecrets([{ name: "R2_SECRET", value: FAKE }]);
    expect(redactSecrets(`key=${FAKE}`)).toBe("key=[REDACTED:R2_SECRET]");
    expect(redactSecretsDeep({ cmd: `curl -H "x: ${FAKE}"`, n: 1 })).toEqual({
      cmd: 'curl -H "x: [REDACTED:R2_SECRET]"',
      n: 1,
    });
    setKnownSecrets([]);
    expect(redactSecrets(`key=${FAKE}`)).toBe(`key=${FAKE}`);
  });
});

describe("spotting secrets pasted into chat", () => {
  it("catches common key shapes", () => {
    const samples = [
      "AKIA" + "ABCDEFGHIJKLMNOP",
      "ghp_" + "a".repeat(36),
      "sk-ant-" + "x".repeat(30),
      "xoxb-" + "1234567890-abcdef",
      FAKE_HEX, // R2/S3 secret access key shape
      "Ab3" + "x9Kq".repeat(10), // Cloudflare-style token
      "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----",
    ];
    for (const s of samples) {
      const scan = scanForSecrets(`here you go: ${s} thanks`);
      expect(scan.found, s).toBe(true);
      expect(scan.redacted).not.toContain(s);
      expect(scan.redacted).toContain(SECRET_PLACEHOLDER);
      expect(hadSecretRemoved(scan.redacted)).toBe(true);
    }
  });

  it("catches KEY=value assignments but keeps the name", () => {
    const scan = scanForSecrets("R2_SECRET_ACCESS_KEY=hunter2hunter2");
    expect(scan.found).toBe(true);
    expect(scan.redacted).toBe(`R2_SECRET_ACCESS_KEY=${SECRET_PLACEHOLDER}`);
  });

  it("ignores ordinary messages, URLs, git SHAs and UUIDs", () => {
    const fine = [
      "can you set up R2 for the video uploads?",
      "https://example.com/path/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      "ship build " + "a1b2c3d".repeat(5) + "a1b2c", // 40 hex chars
      "123e4567-e89b-12d3-a456-426614174000",
      "Supercalifragilisticexpialidocious",
    ];
    for (const text of fine) expect(scanForSecrets(text).found, text).toBe(false);
    expect(isRandomLookingToken("hello")).toBe(false);
  });

  it("flags a value that is already stored", () => {
    setKnownSecrets([{ name: "SHORTISH", value: "plainword99" }]);
    expect(scanForSecrets("it's plainword99").found).toBe(true);
  });

  it("has a reply that tells the owner to rotate and use the secure link", () => {
    expect(PASTED_SECRET_REPLY).toMatch(/rotate/i);
    expect(PASTED_SECRET_REPLY).toMatch(/link/i);
  });
});

describe("one-time entry links", () => {
  it("expire after about ten minutes", () => {
    let now = 1_000;
    const reg = new SecretRequestRegistry(() => now);
    const { token } = reg.create({ name: "R2_SECRET", description: "x" });
    expect(reg.peek(token).ok).toBe(true);
    now += SECRET_REQUEST_TTL_MS - 1;
    expect(reg.peek(token).ok).toBe(true);
    now += 1;
    expect(reg.peek(token)).toEqual({ ok: false, reason: "expired" });
    expect(reg.consume(token)).toEqual({ ok: false, reason: "expired" });
    expect(SECRET_REQUEST_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("work exactly once; looking doesn't use them", () => {
    const reg = new SecretRequestRegistry();
    const { token } = reg.create({ name: "R2_SECRET", description: "x" });
    expect(reg.peek(token).ok).toBe(true);
    expect(reg.peek(token).ok).toBe(true);
    const first = reg.consume(token);
    expect(first.ok && first.request.name).toBe("R2_SECRET");
    expect(reg.consume(token)).toEqual({ ok: false, reason: "used" });
    expect(reg.peek(token)).toEqual({ ok: false, reason: "used" });
  });

  it("use long random tokens and reject unknown ones", () => {
    const reg = new SecretRequestRegistry();
    const a = reg.create({ name: "A_KEY", description: "" }).token;
    const b = reg.create({ name: "B_KEY", description: "" }).token;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(reg.peek("nope")).toEqual({ ok: false, reason: "unknown" });
  });

  it("replace an older open link for the same name", () => {
    const reg = new SecretRequestRegistry();
    const old = reg.create({ name: "A_KEY", description: "" }).token;
    const fresh = reg.create({ name: "A_KEY", description: "" }).token;
    expect(reg.peek(old).ok).toBe(false);
    expect(reg.peek(fresh).ok).toBe(true);
    expect(reg.pending().map((p) => p.name)).toEqual(["A_KEY"]);
  });
});

describe("secret store", () => {
  it("validates names", () => {
    expect(validateSecretName("R2_SECRET_ACCESS_KEY")).toBeNull();
    expect(validateSecretName("A")).toBeNull();
    for (const bad of ["r2_secret", "_X", "1KEY", "KEY-NAME", "KEY NAME", ""]) {
      expect(validateSecretName(bad), bad).not.toBeNull();
    }
  });

  it("only runs on the Mac", () => {
    expect(secretsSupported("darwin")).toBe(true);
    expect(secretsSupported("linux")).toBe(false);
  });

  it("stores values in a chmod 600 file and lists names only", async () => {
    const store = fileStore({ now: () => 42 });
    await store.set("MY_KEY", FAKE);
    expect(await store.get("MY_KEY")).toBe(FAKE);
    expect(await store.list()).toEqual([{ name: "MY_KEY", updatedAt: 42, backend: "file" }]);
    expect(JSON.stringify(await store.list())).not.toContain(FAKE);
    const file = path.join(dir, "secrets.env");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, "secrets.index.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(dir, "secrets.index.json"), "utf8")).not.toContain(FAKE);
    await expect(store.set("bad-name", FAKE)).rejects.toThrow(/UPPER_SNAKE_CASE/);
  });

  it("round-trips awkward values and deletes", async () => {
    const store = fileStore();
    const value = 'line1\nquote " back\\slash = # not a comment';
    await store.set("WEIRD", value);
    await store.set("OTHER", "x".repeat(10));
    expect(await store.get("WEIRD")).toBe(value);
    expect(await store.delete("WEIRD")).toBe(true);
    expect(await store.delete("WEIRD")).toBe(false);
    expect(await store.get("WEIRD")).toBeNull();
    expect(await store.get("OTHER")).toBe("x".repeat(10));
  });

  it("prefers the Keychain and falls back to the file when it fails", async () => {
    const saved = new Map<string, string>();
    let broken = false;
    const keychain: SecretBackend = {
      kind: "keychain",
      get: async (n) => saved.get(n) ?? null,
      set: async (n, v) => {
        if (broken) throw new Error("locked");
        saved.set(n, v);
      },
      delete: async (n) => void saved.delete(n),
    };
    const store = new SecretStore({ dir, platform: "darwin", keychain, updateRedactor: false });
    await store.set("IN_KEYCHAIN", FAKE);
    expect((await store.list())[0].backend).toBe("keychain");
    expect(await store.get("IN_KEYCHAIN")).toBe(FAKE);
    await expect(readFile(path.join(dir, "secrets.env"), "utf8")).rejects.toThrow();
    broken = true;
    await store.set("IN_FILE", FAKE);
    expect((await store.list()).find((s) => s.name === "IN_FILE")?.backend).toBe("file");
    expect(await store.get("IN_FILE")).toBe(FAKE);
  });

  it("never puts the value in the security CLI's arguments", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    let stored = "";
    const backend = keychainBackend(async (args, stdin) => {
      calls.push({ args, stdin });
      if (args[0] === "-i") {
        const hex = stdin!.match(/-X ([0-9a-f]+)/)![1];
        stored = Buffer.from(hex, "hex").toString("utf8");
        return { code: 0, stdout: "" };
      }
      return { code: 0, stdout: `${stored}\n` };
    });
    await backend.set("MY_KEY", FAKE);
    expect(await backend.get("MY_KEY")).toBe(FAKE);
    for (const c of calls) expect(c.args.join(" ")).not.toContain(FAKE);
    expect(calls[0].stdin).not.toContain(FAKE);
  });

  it("imports an env file and can remove it afterwards", async () => {
    const store = fileStore();
    const envFile = path.join(dir, "r2.env");
    await writeFile(envFile, `# R2\nexport R2_ACCESS_KEY_ID="abc123"\nR2_SECRET_ACCESS_KEY='${FAKE}'\n\n`);
    const result = await store.importEnvFile(envFile, { removeFile: true, home: dir });
    expect(result).toEqual({ imported: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"], invalid: [], empty: [], removedFile: true });
    expect(await store.get("R2_SECRET_ACCESS_KEY")).toBe(FAKE);
    await expect(stat(envFile)).rejects.toThrow();
  });

  it("keeps the file when the import was partial, and refuses files outside home", async () => {
    const store = fileStore();
    const envFile = path.join(dir, "mixed.env");
    await writeFile(envFile, "GOOD_KEY=value1\nlower_key=value2\n");
    const result = await store.importEnvFile(envFile, { removeFile: true, home: dir });
    expect(result.imported).toEqual(["GOOD_KEY"]);
    expect(result.invalid).toEqual(["lower_key"]);
    expect(result.removedFile).toBe(false);
    await expect(store.importEnvFile("/etc/hosts", { home: dir })).rejects.toThrow(/home folder/);
  });

  it("parses env files", () => {
    expect(parseEnvFile('A_B="x y" # c\nC=d # note\nexport E=\'f\'').entries).toEqual([
      { name: "A_B", value: "x y" },
      { name: "C", value: "d" },
      { name: "E", value: "f" },
    ]);
  });
});

describe("run_with_secrets", () => {
  it("injects secrets as env vars and redacts them (and encodings) from output", async () => {
    const result = await runCommandWithSecrets({
      command: 'echo "raw=$MY_KEY"; printf %s "$MY_KEY" | base64; echo "err=$MY_KEY" >&2; echo ok',
      secrets: { MY_KEY: FAKE },
    });
    const text = formatRunResult(result);
    expect(result.exitCode).toBe(0);
    expect(text).not.toContain(FAKE);
    expect(text).not.toContain(Buffer.from(FAKE).toString("base64"));
    expect(text).toContain("raw=[REDACTED:MY_KEY]");
    expect(text).toContain("err=[REDACTED:MY_KEY]");
    expect(text).toContain("ok");
  });

  it("gives agents names, never values, and refuses unknown names", async () => {
    const store = fileStore();
    await store.set("MY_KEY", FAKE);
    const tools = createSecretExecutionTools({ store: () => store, platform: "darwin" });
    const run = tools.find((t) => t.name === "run_with_secrets")!;
    const ok = await run.handle({ command: 'test -n "$MY_KEY" && echo "len=${#MY_KEY}" && echo "$MY_KEY"', secretNames: ["MY_KEY"] });
    expect(ok.text).toContain(`len=${FAKE.length}`);
    expect(ok.text).not.toContain(FAKE);
    const missing = await run.handle({ command: "true", secretNames: ["NOT_THERE"] });
    expect(missing.success).toBe(false);
    expect(missing.text).toMatch(/Not stored: NOT_THERE/);
    const list = await tools.find((t) => t.name === "list_secrets")!.handle({});
    expect(list.text).toContain("MY_KEY: set");
    expect(list.text).not.toContain(FAKE);
  });

  it("refuses cleanly on the server copy", async () => {
    const tools = createSecretExecutionTools({ store: () => fileStore(), platform: "linux" });
    const res = await tools[0].handle({ command: "true", secretNames: [] });
    expect(res.success).toBe(false);
    expect(res.text).toMatch(/only on the owner's Mac/);
  });
});

describe("dispatcher tools", () => {
  it("request_secret returns a one-time link and never a value", async () => {
    const requests = new SecretRequestRegistry();
    const tools = createSecretDispatcherTools("sms:test", {
      store: () => fileStore(),
      requests,
      platform: "darwin",
      env: { PORT: "3456" },
    });
    const req = tools.find((t) => t.name === "request_secret")!;
    const bad = await req.handle({ name: "lowercase", description: "x" });
    expect(bad.success).toBe(false);
    const res = await req.handle({ name: "R2_SECRET_ACCESS_KEY", description: "R2 secret" });
    const token = res.text.match(/secrets\/enter\/([A-Za-z0-9_-]+)/)![1];
    expect(res.text).toContain("http://localhost:3456/secrets/enter/");
    expect(requests.peek(token).ok).toBe(true);
    expect(requests.pending()[0].name).toBe("R2_SECRET_ACCESS_KEY");
  });

  it("request_secret refuses on the server copy", async () => {
    const tools = createSecretDispatcherTools("sms:test", { store: () => fileStore(), platform: "linux" });
    const res = await tools.find((t) => t.name === "request_secret")!.handle({ name: "A_KEY", description: "" });
    expect(res.success).toBe(false);
  });

  it("delete_secret needs confirmation", async () => {
    const store = fileStore();
    await store.set("A_KEY", FAKE);
    const tools = createSecretDispatcherTools("c", { store: () => store, platform: "darwin" });
    const del = tools.find((t) => t.name === "delete_secret")!;
    expect((await del.handle({ name: "A_KEY", confirmed: false })).success).toBe(false);
    expect(await store.has("A_KEY")).toBe(true);
    expect((await del.handle({ name: "A_KEY", confirmed: true })).success).toBe(true);
    expect(await store.has("A_KEY")).toBe(false);
  });

  it("only offers a remote link behind Cloudflare Access", () => {
    expect(secretEntryUrls("t", { PORT: "1" }).remote).toBeNull();
    expect(secretEntryUrls("t", { PUBLIC_URL: "https://agent.example.com" }).remote).toBeNull();
    expect(
      secretEntryUrls("t", {
        PUBLIC_URL: "https://agent.example.com/",
        CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        CF_ACCESS_AUD: "aud",
      }).remote,
    ).toBe("https://agent.example.com/secrets/enter/t");
  });
});

describe("entry page", () => {
  async function serve(router: express.Router) {
    const app = express();
    app.use("/secrets", router);
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise((r) => server.close(r)) };
  }

  it("saves once, never echoes the value, and the link is then dead", async () => {
    const store = fileStore();
    const requests = new SecretRequestRegistry();
    const saved: string[] = [];
    const { token } = requests.create({ name: "MY_KEY", description: "<b>desc</b>" });
    const { base, close } = await serve(
      createSecretsRouter({ store: () => store, requests, platform: "darwin", onSaved: (r) => void saved.push(r.name) }),
    );
    try {
      const form = await fetch(`${base}/secrets/enter/${token}`);
      const html = await form.text();
      expect(form.status).toBe(200);
      expect(html).toContain('type="password"');
      expect(html).toContain("&lt;b&gt;desc&lt;/b&gt;");
      expect(form.headers.get("cache-control")).toBe("no-store");
      // Under no-referrer a browser posts the form with `Origin: null`, which
      // the local trust check refuses: the submit came back {"error":"not found"}.
      expect(form.headers.get("referrer-policy")).toBe("same-origin");
      expect(html).toContain('<meta name="referrer" content="same-origin">');

      const post = () =>
        fetch(`${base}/secrets/enter/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ value: FAKE }).toString(),
        });
      const first = await post();
      const firstHtml = await first.text();
      expect(first.status).toBe(200);
      expect(firstHtml).toContain("Saved MY_KEY");
      expect(firstHtml).not.toContain(FAKE);
      expect(await store.get("MY_KEY")).toBe(FAKE);
      expect(saved).toEqual(["MY_KEY"]);

      const second = await post();
      expect(second.status).toBe(410);
      expect(await second.text()).toContain("already used");

      const status = await (await fetch(`${base}/secrets/status`)).json();
      expect(status.supported).toBe(true);
      expect(status.secrets.map((s: { name: string }) => s.name)).toEqual(["MY_KEY"]);
      expect(JSON.stringify(status)).not.toContain(FAKE);

      const del = await fetch(`${base}/secrets/MY_KEY/delete`, { method: "POST" });
      expect(del.status).toBe(200);
      expect(await store.has("MY_KEY")).toBe(false);
    } finally {
      await close();
    }
  });

  it("rejects an empty value without spending the link, and expired links", async () => {
    let now = Date.now();
    const requests = new SecretRequestRegistry(() => now);
    const { token } = requests.create({ name: "MY_KEY", description: "" });
    const { base, close } = await serve(createSecretsRouter({ store: () => fileStore(), requests, platform: "darwin" }));
    try {
      const empty = await fetch(`${base}/secrets/enter/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "value=",
      });
      expect(empty.status).toBe(400);
      expect(requests.peek(token).ok).toBe(true);
      now += SECRET_REQUEST_TTL_MS;
      const expired = await fetch(`${base}/secrets/enter/${token}`);
      expect(expired.status).toBe(410);
      expect(await expired.text()).toContain("expired");
    } finally {
      await close();
    }
  });

  it("refuses on the server copy", async () => {
    const { base, close } = await serve(createSecretsRouter({ store: () => fileStore(), platform: "linux" }));
    try {
      const status = await (await fetch(`${base}/secrets/status`)).json();
      expect(status.supported).toBe(false);
      expect((await fetch(`${base}/secrets/enter/anything`)).status).toBe(404);
    } finally {
      await close();
    }
  });
});

describe("dashboard section", () => {
  it("shows names and status with a Delete button, never values", () => {
    const html = renderToStaticMarkup(
      createElement(SecretsSection, {
        isDark: false,
        initialStatus: {
          supported: true,
          secrets: [{ name: "R2_SECRET_ACCESS_KEY", updatedAt: Date.now(), backend: "keychain" }],
          pending: [{ name: "R2_ACCOUNT_ID", expiresAt: Date.now() + 60_000 }],
        },
      }),
    );
    expect(html).toContain("R2_SECRET_ACCESS_KEY");
    expect(html).toContain("Delete");
    expect(html).toContain("Not set");
    // Wraps on narrow screens instead of overflowing.
    expect(html).toContain("flex-wrap");
    expect(html).toContain("break-all");
  });
});
