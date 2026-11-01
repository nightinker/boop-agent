import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, writeSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setKnownSecrets } from "./redact.js";

/**
 * Boop's secret store. Secret names and values live only on the owner's Mac:
 * values in the macOS login Keychain (via the `security` CLI), or, when the
 * Keychain can't be used, in a chmod 600 file under ~/.config/boop/. A small
 * index file next to it records which names exist and when they changed.
 *
 * Nothing here talks to Convex, memory, logs or the model. Callers only ever
 * get names back, except the two places that need values: injecting them into
 * a command's environment (run_with_secrets) and the redactor's cache.
 */

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
export const MAX_SECRET_NAME_LENGTH = 128;
export const MAX_SECRET_VALUE_BYTES = 16 * 1024;
export const KEYCHAIN_SERVICE = "boop-secrets";

export type SecretBackendKind = "keychain" | "file";

export interface SecretStatus {
  name: string;
  updatedAt: number;
  backend: SecretBackendKind;
}

export function validateSecretName(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "Secret name is required.";
  if (name.length > MAX_SECRET_NAME_LENGTH) return `Secret name is longer than ${MAX_SECRET_NAME_LENGTH} characters.`;
  if (!SECRET_NAME_RE.test(name)) {
    return "Secret names must be UPPER_SNAKE_CASE: a capital letter, then capitals, digits or underscores (e.g. R2_SECRET_ACCESS_KEY).";
  }
  return null;
}

export function validateSecretValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return "The value is empty.";
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) return "The value is too large (16 KB max).";
  if (value.includes("\0")) return "The value contains a NUL byte.";
  return null;
}

/** Secrets only exist on the Mac. A server copy refuses instead of guessing. */
export function secretsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export const SECRETS_UNSUPPORTED_MESSAGE =
  "Secrets live only on the owner's Mac, and this is Boop's server copy. Try again when the Mac is the active copy.";

// --- atomic, private file writes --------------------------------------------

export async function writePrivateFileAtomic(file: string, contents: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await chmod(file, 0o600);
}

// --- env file format ---------------------------------------------------------

/** Parses KEY=value lines (with optional `export`, quotes and comments). */
export function parseEnvFile(text: string): { entries: { name: string; value: string }[]; invalid: string[] } {
  const entries: { name: string; value: string }[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const name = m[1];
    let value = m[2];
    if (value.startsWith('"')) {
      const end = findClosingQuote(value);
      try {
        value = end > 0 ? (JSON.parse(value.slice(0, end + 1)) as string) : value.slice(1);
      } catch {
        value = value.slice(1, end > 0 ? end : undefined);
      }
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = value.slice(1, end > 0 ? end : undefined);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    if (validateSecretName(name)) invalid.push(name);
    else entries.push({ name, value });
  }
  return { entries, invalid };
}

function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\") i++;
    else if (value[i] === '"') return i;
  }
  return -1;
}

function formatEnvFile(values: Map<string, string>): string {
  const lines = [
    "# Boop secret store (fallback file). Managed by Boop; do not edit by hand.",
    "# Values are JSON-quoted. Keep this file chmod 600.",
  ];
  for (const [name, value] of [...values.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}=${JSON.stringify(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

// --- backends ------------------------------------------------------------------

export interface SecretBackend {
  kind: SecretBackendKind;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export function fileBackend(file: string): SecretBackend {
  const read = async (): Promise<Map<string, string>> => {
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw err;
    }
    return new Map(parseEnvFile(text).entries.map((e) => [e.name, e.value]));
  };
  return {
    kind: "file",
    async get(name) {
      return (await read()).get(name) ?? null;
    },
    async set(name, value) {
      const values = await read();
      values.set(name, value);
      await writePrivateFileAtomic(file, formatEnvFile(values));
    },
    async delete(name) {
      const values = await read();
      if (!values.delete(name)) return;
      await writePrivateFileAtomic(file, formatEnvFile(values));
    },
  };
}

export type SecurityRunner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>;

/** Runs /usr/bin/security. Its stderr is dropped: never logged, never returned. */
export const runSecurity: SecurityRunner = (args, stdin) =>
  new Promise((resolve) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
    child.stdin.end(stdin ?? "");
  });

/**
 * The login Keychain, as generic passwords under service "boop-secrets".
 * Values never appear in a process's arguments: writes go through
 * `security -i` on stdin, hex-encoded with -X. The stored password is the
 * value's base64, so `find-generic-password -w` always prints it verbatim.
 */
export function keychainBackend(run: SecurityRunner = runSecurity): SecretBackend {
  return {
    kind: "keychain",
    async get(name) {
      const res = await run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
      if (res.code !== 0) return null;
      const b64 = res.stdout.replace(/\r?\n$/, "");
      return Buffer.from(b64, "base64").toString("utf8");
    },
    async set(name, value) {
      const hex = Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8").toString("hex");
      const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -l "Boop secret ${name}" -X ${hex}\n`;
      const res = await run(["-i"], command);
      // `security -i` exits 0 even when a command fails, so read it back.
      const check = res.code === 0 ? await this.get(name) : null;
      if (check !== value) throw new Error("Couldn't save to the macOS Keychain.");
    },
    async delete(name) {
      await run(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
    },
  };
}

// --- the store ----------------------------------------------------------------

interface IndexFile {
  version: 1;
  secrets: Record<string, { updatedAt: number; backend: SecretBackendKind }>;
}

export interface SecretStoreOptions {
  /** Where the index and fallback file live. Default ~/.config/boop. */
  dir?: string;
  /** "auto" tries the Keychain first on macOS. Default "auto". */
  prefer?: "auto" | SecretBackendKind;
  platform?: NodeJS.Platform;
  keychain?: SecretBackend;
  now?: () => number;
  /** Refresh the redactor's cache on every change. Default true. */
  updateRedactor?: boolean;
}

export interface ImportResult {
  imported: string[];
  invalid: string[];
  empty: string[];
  removedFile: boolean;
}

export class SecretStore {
  readonly dir: string;
  readonly indexFile: string;
  readonly fallbackFile: string;
  private readonly file: SecretBackend;
  private readonly keychain: SecretBackend | null;
  private readonly now: () => number;
  private readonly updateRedactor: boolean;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: SecretStoreOptions = {}) {
    this.dir = opts.dir ?? path.join(homedir(), ".config", "boop");
    this.indexFile = path.join(this.dir, "secrets.index.json");
    this.fallbackFile = path.join(this.dir, "secrets.env");
    this.file = fileBackend(this.fallbackFile);
    const platform = opts.platform ?? process.platform;
    const prefer = opts.prefer ?? "auto";
    this.keychain =
      prefer === "file"
        ? null
        : opts.keychain ?? (platform === "darwin" && existsSync("/usr/bin/security") ? keychainBackend() : null);
    this.now = opts.now ?? Date.now;
    this.updateRedactor = opts.updateRedactor ?? true;
  }

  /** Serializes writes so two saves can't clobber the index. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async readIndex(): Promise<IndexFile> {
    try {
      const parsed = JSON.parse(await readFile(this.indexFile, "utf8")) as IndexFile;
      if (parsed && typeof parsed.secrets === "object") return { version: 1, secrets: parsed.secrets };
    } catch {
      // Missing or unreadable: start empty.
    }
    return { version: 1, secrets: {} };
  }

  private async writeIndex(index: IndexFile): Promise<void> {
    await writePrivateFileAtomic(this.indexFile, `${JSON.stringify(index, null, 2)}\n`);
  }

  private backendFor(kind: SecretBackendKind): SecretBackend {
    return kind === "keychain" && this.keychain ? this.keychain : this.file;
  }

  /** Names, last-updated times and where each lives. Never values. */
  async list(): Promise<SecretStatus[]> {
    const index = await this.readIndex();
    return Object.entries(index.secrets)
      .filter(([name]) => SECRET_NAME_RE.test(name))
      .map(([name, meta]) => ({ name, updatedAt: meta.updatedAt, backend: meta.backend }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async has(name: string): Promise<boolean> {
    return name in (await this.readIndex()).secrets;
  }

  /** Internal: only run_with_secrets and the redactor read values. */
  async get(name: string): Promise<string | null> {
    const meta = (await this.readIndex()).secrets[name];
    if (!meta) return null;
    return this.backendFor(meta.backend).get(name);
  }

  async getMany(names: string[]): Promise<{ values: Record<string, string>; missing: string[] }> {
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of names) {
      const v = await this.get(name);
      if (v === null) missing.push(name);
      else values[name] = v;
    }
    return { values, missing };
  }

  async set(name: string, value: string): Promise<SecretStatus> {
    const nameError = validateSecretName(name);
    if (nameError) throw new Error(nameError);
    const valueError = validateSecretValue(value);
    if (valueError) throw new Error(valueError);
    const status = await this.exclusive(() => this.setUnlocked(name, value));
    await this.refreshRedactor();
    return status;
  }

  private async setUnlocked(name: string, value: string): Promise<SecretStatus> {
    const index = await this.readIndex();
    const previous = index.secrets[name];
    let backend: SecretBackendKind = "file";
    if (this.keychain) {
      try {
        await this.keychain.set(name, value);
        backend = "keychain";
      } catch {
        backend = "file";
      }
    }
    if (backend === "file") await this.file.set(name, value);
    // Moving between backends: don't leave the old copy behind.
    if (previous && previous.backend !== backend) {
      await this.backendFor(previous.backend).delete(name).catch(() => undefined);
    }
    const updatedAt = this.now();
    index.secrets[name] = { updatedAt, backend };
    await this.writeIndex(index);
    return { name, updatedAt, backend };
  }

  async delete(name: string): Promise<boolean> {
    const removed = await this.exclusive(async () => {
      const index = await this.readIndex();
      const meta = index.secrets[name];
      if (!meta) return false;
      await this.backendFor(meta.backend).delete(name);
      delete index.secrets[name];
      await this.writeIndex(index);
      return true;
    });
    if (removed) await this.refreshRedactor();
    return removed;
  }

  /**
   * Imports KEY=value lines from an env file under the home folder. With
   * `removeFile`, the plaintext file is deleted once every valid entry is in.
   */
  async importEnvFile(
    filePath: string,
    opts: { names?: string[]; removeFile?: boolean; home?: string } = {},
  ): Promise<ImportResult> {
    const home = opts.home ?? homedir();
    const expanded = filePath.startsWith("~/") ? path.join(home, filePath.slice(2)) : filePath;
    const resolved = path.resolve(expanded);
    const rel = path.relative(home, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Only files in your home folder can be imported.");
    if (resolved === this.fallbackFile || resolved === this.indexFile) {
      throw new Error("That's Boop's own secret file.");
    }
    const info = await lstat(resolved).catch(() => null);
    if (!info || !info.isFile()) throw new Error("No such file.");
    if (info.size > 256 * 1024) throw new Error("That file is too large to be an env file.");
    const { entries, invalid } = parseEnvFile(await readFile(resolved, "utf8"));
    const wanted = opts.names?.length ? new Set(opts.names) : null;
    const imported: string[] = [];
    const empty: string[] = [];
    for (const { name, value } of entries) {
      if (wanted && !wanted.has(name)) continue;
      if (validateSecretValue(value)) {
        empty.push(name);
        continue;
      }
      await this.exclusive(() => this.setUnlocked(name, value));
      imported.push(name);
    }
    await this.refreshRedactor();
    let removedFile = false;
    if (opts.removeFile && imported.length > 0 && !wanted && invalid.length === 0 && empty.length === 0) {
      await unlink(resolved);
      removedFile = true;
    }
    return { imported, invalid, empty, removedFile };
  }

  /** Reloads every value into the redactor's cache. */
  async refreshRedactor(): Promise<void> {
    if (!this.updateRedactor) return;
    const known: { name: string; value: string }[] = [];
    for (const { name } of await this.list()) {
      const value = await this.get(name).catch(() => null);
      if (value) known.push({ name, value });
    }
    setKnownSecrets(known);
  }
}

let defaultStore: SecretStore | null = null;

/** The Mac's store under ~/.config/boop. */
export function secretStore(): SecretStore {
  defaultStore ??= new SecretStore();
  return defaultStore;
}

/** Test hook. */
export function setSecretStoreForTests(store: SecretStore | null): void {
  defaultStore = store;
}
