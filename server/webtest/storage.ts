import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { secretStore, secretsSupported, writePrivateFileAtomic, type SecretStore } from "../secrets/store.js";
import { SESSION_NAME_RE } from "./plan.js";

/**
 * Where the web test runner keeps things, and how it gets credentials.
 *
 * ~/.config/boop/webtest/
 *   sessions/<name>.json  Playwright storage state (cookies + localStorage), 0600
 *   plans/<name>.yaml     saved test plans
 *
 * Credentials are looked up by NAME only:
 * - On the Mac: the secret store (Keychain), same as run_with_secrets.
 * - Anywhere (including the Linux server, where the secret store doesn't
 *   exist): environment variables named WEBTEST_*, set by the owner in the
 *   server's environment. Only WEBTEST_* names are read from the environment
 *   so a plan can't type Boop's own API keys into a web page.
 */

export const WEBTEST_ENV_PREFIX = "WEBTEST_";

export function webtestDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOOP_WEBTEST_DIR?.trim() || path.join(homedir(), ".config", "boop", "webtest");
}

function validName(name: string, kind: string): string {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error(`Invalid ${kind} name "${name}": use letters, digits, dots, dashes or underscores (max 64).`);
  }
  return name;
}

export function sessionPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(webtestDir(env), "sessions", `${validName(name, "session")}.json`);
}

export function planPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(webtestDir(env), "plans", `${validName(name, "plan")}.yaml`);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
}

export async function sessionExists(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return existsSync(sessionPath(name, env));
}

/** Makes sure the sessions dir exists (0700) and returns the path to write a session to. */
export async function prepareSessionPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = sessionPath(name, env);
  await ensurePrivateDir(path.dirname(file));
  return file;
}

export async function lockDownSessionFile(file: string): Promise<void> {
  await chmod(file, 0o600).catch(() => undefined);
}

export interface SavedItem {
  name: string;
  updatedAt: number;
}

async function listDir(dir: string, ext: string): Promise<SavedItem[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const out: SavedItem[] = [];
  for (const file of entries) {
    if (!file.endsWith(ext)) continue;
    const name = file.slice(0, -ext.length);
    if (!SESSION_NAME_RE.test(name)) continue;
    const info = await stat(path.join(dir, file)).catch(() => null);
    if (info?.isFile()) out.push({ name, updatedAt: info.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listSessions(env: NodeJS.ProcessEnv = process.env): Promise<SavedItem[]> {
  return listDir(path.join(webtestDir(env), "sessions"), ".json");
}

export function listPlans(env: NodeJS.ProcessEnv = process.env): Promise<SavedItem[]> {
  return listDir(path.join(webtestDir(env), "plans"), ".yaml");
}

export async function deleteSession(name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const file = sessionPath(name, env);
  if (!existsSync(file)) return false;
  await unlink(file);
  return true;
}

export async function savePlanText(name: string, text: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = planPath(name, env);
  await ensurePrivateDir(path.dirname(file));
  await writePrivateFileAtomic(file, text.endsWith("\n") ? text : `${text}\n`);
  return file;
}

export async function readPlanText(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return readFile(planPath(name, env), "utf8").catch(() => null);
}

// --- credentials ------------------------------------------------------------

export interface CredentialLookup {
  values: Record<string, string>;
  missing: string[];
}

export interface CredentialSource {
  getMany(names: string[]): Promise<CredentialLookup>;
  /** Where to tell the owner to put a missing credential. */
  missingHint(names: string[]): string;
}

export function defaultCredentialSource(
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; store?: () => SecretStore } = {},
): CredentialSource {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const store = opts.store ?? secretStore;
  const useStore = secretsSupported(platform);
  return {
    async getMany(names) {
      const values: Record<string, string> = {};
      let remaining = [...new Set(names)];
      if (useStore && remaining.length) {
        const fromStore = await store().getMany(remaining);
        Object.assign(values, fromStore.values);
        remaining = fromStore.missing;
      }
      const missing: string[] = [];
      for (const name of remaining) {
        const v = name.startsWith(WEBTEST_ENV_PREFIX) ? env[name] : undefined;
        if (v) values[name] = v;
        else missing.push(name);
      }
      return { values, missing };
    },
    missingHint(names) {
      const list = names.join(", ");
      const envNames = names.filter((n) => n.startsWith(WEBTEST_ENV_PREFIX));
      return useStore
        ? `Missing test credentials: ${list}. Stop and report that Boop needs to request ${names.length === 1 ? "it" : "them"} from the owner with request_secret (by name). Never ask for the value in chat.`
        : [
            `Missing test credentials: ${list}. This copy of Boop runs on a server without the Mac's secret store.`,
            envNames.length === names.length
              ? `The owner can set ${list} in the server's environment (e.g. the server's .env.local), or save a logged-in session with webtest_save_session.`
              : `On the server, credentials must be environment variables named ${WEBTEST_ENV_PREFIX}* (e.g. ${WEBTEST_ENV_PREFIX}${names[0]}), or use a saved session. Never ask for the value in chat.`,
          ].join(" ");
    },
  };
}
