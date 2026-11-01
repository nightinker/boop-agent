import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { redactValues, secretVariants, type KnownSecret } from "./redact.js";

/**
 * Runs a shell command with secrets in its environment and returns its output
 * with every secret value (and its common encodings) scrubbed out. The caller
 * passes names; values never leave this module except into the child's env.
 */

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_CAPTURE_BYTES = 200_000;
const MAX_RETURN_CHARS = 20_000;

export interface RunWithSecretsResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function tail(text: string, max: number): string {
  return text.length > max ? `…(${text.length - max} chars cut)\n${text.slice(-max)}` : text;
}

/**
 * When capture stopped early, the last kept chunk may end partway through a
 * secret, which redaction can't recognise. Drop that many trailing chars.
 */
function cutPartial(text: string, totalBytes: number, known: KnownSecret[]): string {
  if (totalBytes <= MAX_CAPTURE_BYTES) return text;
  const longest = Math.max(0, ...known.flatMap((k) => secretVariants(k.value).map((v) => v.length)));
  return `${text.slice(0, Math.max(0, text.length - longest))}\n…(output cut)`;
}

export function runCommandWithSecrets(opts: {
  command: string;
  secrets: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  shell?: string;
}): Promise<RunWithSecretsResult> {
  const known: KnownSecret[] = Object.entries(opts.secrets).map(([name, value]) => ({ name, value }));
  const timeoutMs = Math.min(Math.max(1_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  return new Promise((resolve) => {
    const child = spawn(opts.shell ?? "/bin/bash", ["-c", opts.command], {
      cwd: opts.cwd ?? homedir(),
      env: { ...process.env, ...opts.secrets },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (outBytes < MAX_CAPTURE_BYTES) out.push(d);
      outBytes += d.length;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (errBytes < MAX_CAPTURE_BYTES) err.push(d);
      errBytes += d.length;
    });
    const finish = (exitCode: number | null, signal: string | null, extraErr = "") => {
      clearTimeout(timer);
      // Redact the whole capture before trimming, so a value split by the cut
      // can't leak half of itself.
      const stdout = cutPartial(redactValues(Buffer.concat(out).toString("utf8"), known), outBytes, known);
      const stderr = cutPartial(redactValues(Buffer.concat(err).toString("utf8"), known), errBytes, known) + extraErr;
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: tail(stdout, MAX_RETURN_CHARS),
        stderr: tail(stderr, MAX_RETURN_CHARS),
      });
    };
    child.on("error", (e) => finish(null, null, `\n${e.message}`));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export function formatRunResult(r: RunWithSecretsResult): string {
  const status = r.timedOut
    ? "timed out (killed)"
    : r.signal
      ? `killed by ${r.signal}`
      : `exit code ${r.exitCode}`;
  const parts = [`[${status}]`];
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trimEnd()}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trimEnd()}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push("(no output)");
  return parts.join("\n\n");
}
