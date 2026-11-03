import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { redactSecrets } from "../secrets/redact.js";
import type { CiCheck, SuiteCheck } from "./plan.js";

/**
 * Repo checks to report alongside browser results:
 * - CI status from GitHub through the `gh` CLI (read-only commands only).
 * - A repo's own test script (package.json "test", "test:e2e", "lint", …)
 *   run with the repo's package manager.
 *
 * Commands run with execFile (no shell) and validated arguments.
 */

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the program couldn't be started (e.g. not installed). */
  spawnError?: string;
}

export type Exec = (
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

const MAX_BUFFER = 8 * 1024 * 1024;

export const execCommand: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: opts.env ?? process.env,
        killSignal: "SIGKILL",
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (e && typeof e.code === "string") {
          resolve({ code: null, stdout: String(stdout), stderr: String(stderr), timedOut: false, spawnError: e.code });
          return;
        }
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });

export interface CheckResult {
  label: string;
  /** passed / failed / pending / error (couldn't check). */
  status: "passed" | "failed" | "pending" | "error";
  summary: string;
  details: string[];
}

function tailLines(text: string, n: number): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}

// --- CI via gh ----------------------------------------------------------------

interface GhCheck {
  name?: string;
  state?: string;
  bucket?: string;
  link?: string;
  workflow?: string;
}

interface GhRun {
  databaseId?: number;
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  headSha?: string;
  url?: string;
}

function ghUnavailable(r: ExecResult): string | null {
  if (r.spawnError === "ENOENT") {
    return "The GitHub CLI (gh) isn't installed on this machine. Install it (https://cli.github.com) and run `gh auth login`, or set GH_TOKEN in Boop's environment.";
  }
  if (/auth login|not logged in|authentication|HTTP 401/i.test(r.stderr)) {
    return "The GitHub CLI isn't logged in here. Run `gh auth login` on this machine, or set GH_TOKEN in Boop's environment.";
  }
  return null;
}

export async function ciStatus(check: CiCheck, exec: Exec = execCommand): Promise<CheckResult> {
  const label = `CI ${check.repo}${check.pr ? ` PR #${check.pr}` : check.branch ? ` (${check.branch})` : check.commit ? ` @${check.commit.slice(0, 7)}` : ""}`;
  const timeoutMs = 60_000;
  if (check.pr) {
    const r = await exec(
      "gh",
      ["pr", "checks", String(check.pr), "--repo", check.repo, "--json", "name,state,bucket,link,workflow"],
      { timeoutMs },
    );
    const unavailable = ghUnavailable(r);
    if (unavailable) return { label, status: "error", summary: unavailable, details: [] };
    let checks: GhCheck[];
    try {
      checks = JSON.parse(r.stdout || "[]") as GhCheck[];
    } catch {
      return { label, status: "error", summary: `gh pr checks failed: ${tailLines(r.stderr || r.stdout, 3).join(" ")}`, details: [] };
    }
    if (checks.length === 0) return { label, status: "pending", summary: "No checks reported for this PR.", details: [] };
    const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
    const pending = checks.filter((c) => c.bucket === "pending");
    const passed = checks.filter((c) => c.bucket === "pass");
    const status = failed.length ? "failed" : pending.length ? "pending" : "passed";
    return {
      label,
      status,
      summary: `${passed.length} passed, ${failed.length} failed, ${pending.length} pending (${checks.length} checks).`,
      details: [...failed, ...pending].slice(0, 15).map((c) => `${c.bucket === "pending" ? "…" : "✗"} ${c.workflow ? `${c.workflow} / ` : ""}${c.name}${c.link ? ` ${c.link}` : ""}`),
    };
  }

  const args = ["run", "list", "--repo", check.repo, "--limit", "10", "--json", "databaseId,name,workflowName,status,conclusion,headSha,url"];
  if (check.branch) args.push("--branch", check.branch);
  if (check.commit) args.push("--commit", check.commit);
  const r = await exec("gh", args, { timeoutMs });
  const unavailable = ghUnavailable(r);
  if (unavailable) return { label, status: "error", summary: unavailable, details: [] };
  let runs: GhRun[];
  try {
    runs = JSON.parse(r.stdout || "[]") as GhRun[];
  } catch {
    return { label, status: "error", summary: `gh run list failed: ${tailLines(r.stderr || r.stdout, 3).join(" ")}`, details: [] };
  }
  if (runs.length === 0) return { label, status: "pending", summary: "No workflow runs found.", details: [] };
  // Latest run per workflow, for the newest commit.
  const sha = runs[0].headSha;
  const latest = new Map<string, GhRun>();
  for (const run of runs) {
    if (run.headSha !== sha) continue;
    const key = run.workflowName ?? run.name ?? String(run.databaseId);
    if (!latest.has(key)) latest.set(key, run);
  }
  const list = [...latest.values()];
  const failed = list.filter((x) => x.status === "completed" && x.conclusion && !["success", "skipped", "neutral"].includes(x.conclusion));
  const pending = list.filter((x) => x.status !== "completed");
  const details = list.map(
    (x) =>
      `${x.status !== "completed" ? "…" : failed.includes(x) ? "✗" : "✓"} ${x.workflowName ?? x.name} — ${x.status === "completed" ? x.conclusion : x.status}${x.url ? ` ${x.url}` : ""}`,
  );
  for (const run of failed.slice(0, 2)) {
    if (!run.databaseId) continue;
    const log = await exec("gh", ["run", "view", String(run.databaseId), "--repo", check.repo, "--log-failed"], { timeoutMs });
    const lines = tailLines(log.stdout, 25);
    if (lines.length) details.push(`Failed log (${run.workflowName ?? run.name}, last lines):`, ...lines.map((l) => `  ${l.slice(0, 240)}`));
  }
  return {
    label,
    status: failed.length ? "failed" : pending.length ? "pending" : "passed",
    summary: `${list.length - failed.length - pending.length} passed, ${failed.length} failed, ${pending.length} running (commit ${sha?.slice(0, 7) ?? "?"}).`,
    details: details.map(redactSecrets),
  };
}

// --- repo test scripts ------------------------------------------------------

export const DEFAULT_SUITE_TIMEOUT_MS = 10 * 60_000;
export const MAX_SUITE_TIMEOUT_MS = 30 * 60_000;

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function packageManager(dir: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))) return "bun";
  return "npm";
}

/** Pulls the result lines out of vitest/jest/playwright/mocha output. */
export function summarizeTestOutput(output: string): string[] {
  const lines = tailLines(output, 400);
  const keep = lines.filter((l) =>
    /^\s*(Test Files|Tests|Test Suites|Snapshots|Duration|Time:)\b|\b\d+ (passed|failed|skipped|flaky|pending|passing|failing)\b|^\s*(FAIL|✗|×|✘)\s|^\s*\d+\) /i.test(l),
  );
  return keep.slice(-20);
}

export async function runSuite(
  suite: SuiteCheck,
  opts: { exec?: Exec; home?: string; timeoutMs?: number } = {},
): Promise<CheckResult> {
  const exec = opts.exec ?? execCommand;
  const home = opts.home ?? homedir();
  const label = `${suite.script} in ${suite.cwd}`;
  const fail = (summary: string): CheckResult => ({ label, status: "error", summary, details: [] });
  let dir: string;
  try {
    dir = await realpath(path.resolve(expandHome(suite.cwd, home)));
  } catch {
    return fail(`No such folder: ${suite.cwd}. Clone the repo on this machine first.`);
  }
  const homeReal = await realpath(home).catch(() => home);
  const rel = path.relative(homeReal, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return fail("Test suites can only run in folders inside the home folder.");
  let scripts: Record<string, string>;
  try {
    scripts = (JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return fail(`No readable package.json in ${suite.cwd}.`);
  }
  if (!(suite.script in scripts)) {
    const available = Object.keys(scripts).filter((s) => /test|lint|check|e2e|type/i.test(s));
    return fail(`package.json has no "${suite.script}" script.${available.length ? ` Test-like scripts: ${available.join(", ")}.` : ""}`);
  }
  if (!/test|lint|check|e2e|type|spec|ci/i.test(suite.script)) {
    return fail(`"${suite.script}" doesn't look like a test/check script; only scripts named like test, lint, check, e2e, typecheck or ci can run here.`);
  }
  const pm = packageManager(dir);
  const extra = suite.args?.length ? (pm === "npm" ? ["--", ...suite.args] : suite.args) : [];
  const args = ["run", suite.script, ...extra];
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_SUITE_TIMEOUT_MS, MAX_SUITE_TIMEOUT_MS);
  const started = Date.now();
  const r = await exec(pm, args, { cwd: dir, timeoutMs, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (r.spawnError) return fail(`Couldn't run ${pm}: ${r.spawnError}.`);
  const output = redactSecrets(`${r.stdout}\n${r.stderr}`);
  const summary = summarizeTestOutput(output);
  const status = r.timedOut ? "failed" : r.code === 0 ? "passed" : "failed";
  return {
    label: `${pm} run ${suite.script}${suite.args?.length ? ` ${suite.args.join(" ")}` : ""} (${suite.cwd})`,
    status,
    summary: r.timedOut
      ? `Timed out after ${Math.round(timeoutMs / 60_000)} min.`
      : `${r.code === 0 ? "Passed" : `Failed (exit ${r.code})`} in ${seconds}s.`,
    details: status === "passed" ? summary.slice(-4) : [...summary, ...(summary.length < 3 ? tailLines(output, 25) : [])].map((l) => l.slice(0, 240)),
  };
}

export function formatCheckResults(results: CheckResult[]): string {
  if (results.length === 0) return "";
  const icon = { passed: "✅", failed: "❌", pending: "⏳", error: "⚠️" } as const;
  return results
    .map((r) => [`${icon[r.status]} ${r.label}: ${r.summary}`, ...r.details.map((d) => `  ${d}`)].join("\n"))
    .join("\n");
}
