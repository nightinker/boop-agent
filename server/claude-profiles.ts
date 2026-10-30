import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

/**
 * Claude account profiles: separate Claude Code config dirs on this Mac
 * (`~/.claude`, `~/.claude-work`, …), each signed in to its own account.
 * Boop picks one by setting CLAUDE_CONFIG_DIR for the Claude runtime.
 *
 * This module only ever reads the public account identity (email and org)
 * from each dir's `.claude.json`. It never reads credential files or the
 * Keychain, and never returns, stores or logs tokens. Signing in to a new
 * profile happens outside chat: `CLAUDE_CONFIG_DIR=~/.claude-work claude`.
 */

export const CLAUDE_ACCOUNT_KEY = "claude_account";
export const DEFAULT_PROFILE_LABEL = "default";
const PROFILE_CACHE_MS = 30_000;

export interface ClaudeProfile {
  label: string;
  configDir: string;
  /** The account Boop uses when no profile is chosen (no CLAUDE_CONFIG_DIR override). */
  isDefault: boolean;
  email: string | null;
  orgName: string | null;
}

export interface DiscoverOptions {
  home?: string;
  /** Boop's own CLAUDE_CONFIG_DIR, if it was started with one. */
  envConfigDir?: string;
  /** Extra profile dirs, from BOOP_CLAUDE_CONFIG_DIRS (comma, colon or newline separated). */
  extraDirs?: string;
}

const PROFILE_DIR_PATTERN = /^\.claude[-_]([a-z0-9][a-z0-9_.-]*)$/i;

function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function labelForDir(dir: string): string {
  const name = basename(dir);
  const match = PROFILE_DIR_PATTERN.exec(name);
  if (match) return match[1].toLowerCase();
  return name.replace(/^\.+/, "").toLowerCase() || "profile";
}

/**
 * Pull only the public identity out of a `.claude.json`. Anything else in
 * that file (API key responses, project history) is ignored on purpose.
 */
export function parseProfileIdentity(json: string): { email: string; orgName: string | null } | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const account = (data as { oauthAccount?: unknown } | null)?.oauthAccount;
  if (!account || typeof account !== "object") return null;
  const { emailAddress, organizationName } = account as Record<string, unknown>;
  if (typeof emailAddress !== "string" || !emailAddress) return null;
  return {
    email: emailAddress,
    orgName: typeof organizationName === "string" && organizationName ? organizationName : null,
  };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readIdentity(candidates: string[]) {
  for (const file of candidates) {
    try {
      const identity = parseProfileIdentity(await readFile(file, "utf8"));
      if (identity) return identity;
    } catch {
      // missing or unreadable: try the next location
    }
  }
  return null;
}

/**
 * Find the Claude config dirs on this Mac that have a signed-in account.
 * Dirs with no account are skipped: Boop only switches between logins that
 * already exist.
 */
export async function discoverClaudeProfiles(options: DiscoverOptions = {}): Promise<ClaudeProfile[]> {
  const home = options.home ?? homedir();
  const homeDefaultDir = join(home, ".claude");
  const defaultDir = options.envConfigDir?.trim()
    ? resolve(expandHome(options.envConfigDir.trim(), home))
    : homeDefaultDir;

  const dirs = new Set<string>([defaultDir, homeDefaultDir]);
  try {
    for (const entry of await readdir(home)) {
      if (PROFILE_DIR_PATTERN.test(entry)) dirs.add(join(home, entry));
    }
  } catch {
    // unreadable home: fall back to the explicit dirs
  }
  for (const raw of (options.extraDirs ?? "").split(/[,:\n]/)) {
    if (raw.trim()) dirs.add(resolve(expandHome(raw.trim(), home)));
  }

  const profiles: ClaudeProfile[] = [];
  const usedLabels = new Set<string>();
  for (const dir of dirs) {
    if (!(await isDir(dir))) continue;
    // Claude Code keeps the default login's state in ~/.claude.json, and a
    // CLAUDE_CONFIG_DIR login's state inside that dir.
    const candidates =
      dir === homeDefaultDir
        ? [join(home, ".claude.json"), join(dir, ".claude.json")]
        : [join(dir, ".claude.json")];
    const identity = await readIdentity(candidates);
    if (!identity) continue;
    const isDefault = dir === defaultDir;
    const base = dir === homeDefaultDir ? "home" : labelForDir(dir);
    let label = isDefault ? DEFAULT_PROFILE_LABEL : base === DEFAULT_PROFILE_LABEL ? "home" : base;
    for (let n = 2; usedLabels.has(label); n++) label = `${base}-${n}`;
    usedLabels.add(label);
    profiles.push({ label, configDir: dir, isDefault, ...identity });
  }
  return profiles.sort((a, b) =>
    a.isDefault === b.isDefault ? a.label.localeCompare(b.label) : a.isDefault ? -1 : 1,
  );
}

/** Match what the owner typed against a profile label or its account email. */
export function resolveProfileInput(input: string, profiles: ClaudeProfile[]): ClaudeProfile | null {
  const wanted = input.trim().toLowerCase().replace(/^~\/\.?claude[-_.]?/, "");
  if (!wanted) return null;
  return (
    profiles.find((p) => p.label === wanted) ??
    profiles.find((p) => p.email?.toLowerCase() === wanted) ??
    (wanted === "claude" ? profiles.find((p) => p.isDefault) : undefined) ??
    null
  );
}

/** Which profile is active, given the saved label. A label that no longer exists falls back to the default. */
export function pickActiveProfile(
  profiles: ClaudeProfile[],
  savedLabel: string | null,
): { active: ClaudeProfile | null; missingSavedLabel: string | null } {
  const saved = savedLabel ? profiles.find((p) => p.label === savedLabel) : undefined;
  const fallback = profiles.find((p) => p.isDefault) ?? null;
  return {
    active: saved ?? fallback,
    missingSavedLabel: savedLabel && !saved ? savedLabel : null,
  };
}

export function describeProfile(profile: ClaudeProfile): string {
  const who = profile.orgName ? `${profile.email} (${profile.orgName})` : profile.email;
  return `${profile.label} — ${who}`;
}

export function formatProfileList(
  profiles: ClaudeProfile[],
  savedLabel: string | null,
): string {
  if (profiles.length === 0) {
    return "No signed-in Claude accounts found on this Mac. Sign in with `claude` in Terminal (or `CLAUDE_CONFIG_DIR=~/.claude-<name> claude` for an extra account), then ask again.";
  }
  const { active, missingSavedLabel } = pickActiveProfile(profiles, savedLabel);
  const lines = profiles.map(
    (p) => `${p.label === active?.label ? "• (active) " : "• "}${describeProfile(p)}`,
  );
  const notes: string[] = [];
  if (missingSavedLabel) {
    notes.push(
      `The saved account "${missingSavedLabel}" is no longer signed in on this Mac, so Boop is using ${active ? `"${active.label}"` : "the default login"}.`,
    );
  }
  if (profiles.length === 1) {
    notes.push(
      "This is the only Claude account found. To add another, run `CLAUDE_CONFIG_DIR=~/.claude-<name> claude` in Terminal and sign in there.",
    );
  }
  return [...lines, ...notes].join("\n");
}

let cache: { at: number; profiles: ClaudeProfile[]; savedLabel: string | null } | null = null;

export function clearClaudeProfileCache(): void {
  cache = null;
}

async function loadState(): Promise<{ profiles: ClaudeProfile[]; savedLabel: string | null }> {
  if (cache && Date.now() - cache.at < PROFILE_CACHE_MS) return cache;
  const [profiles, savedLabel] = await Promise.all([
    discoverClaudeProfiles({
      envConfigDir: process.env.CLAUDE_CONFIG_DIR,
      extraDirs: process.env.BOOP_CLAUDE_CONFIG_DIRS,
    }),
    convex.query(api.settings.get, { key: CLAUDE_ACCOUNT_KEY }).catch((err) => {
      console.warn("[claude-profiles] settings:get failed", err);
      return null;
    }),
  ]);
  cache = { at: Date.now(), profiles, savedLabel };
  return cache;
}

export async function listClaudeProfiles() {
  const state = await loadState();
  return { ...state, ...pickActiveProfile(state.profiles, state.savedLabel) };
}

export async function setClaudeProfile(profile: ClaudeProfile): Promise<void> {
  if (profile.isDefault) {
    await convex.mutation(api.settings.clear, { key: CLAUDE_ACCOUNT_KEY });
  } else {
    await convex.mutation(api.settings.set, { key: CLAUDE_ACCOUNT_KEY, value: profile.label });
  }
  cache = null;
}

/**
 * The config dir of the chosen account, or undefined to keep Boop's own
 * login (the default account, or nothing chosen).
 */
export async function activeClaudeConfigDir(): Promise<string | undefined> {
  try {
    const { savedLabel, active } = await listClaudeProfiles();
    if (!savedLabel || !active || active.isDefault) return undefined;
    return active.configDir;
  } catch (err) {
    console.warn("[claude-profiles] could not resolve the active account; using the default", err);
    return undefined;
  }
}

/** The child-process env for a Claude Code run under the chosen account. */
export function envWithClaudeConfigDir(
  configDir: string | undefined,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> | undefined {
  if (!configDir) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}
