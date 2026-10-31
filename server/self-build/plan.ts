/**
 * Pure pieces of self-build: who may ask, naming, the coding agent's brief,
 * the PR text and the restart script. No I/O, so it can be tested directly.
 */

export function digitsOnly(value: string): string {
  return value.replace(/[^\d]/g, "");
}

/**
 * Only the owner may change Boop's code. Local conversations (the dashboard
 * and the local-only /chat endpoint) are the owner by definition; an iMessage
 * conversation must come from a number listed in BOOP_OWNER_NUMBERS. With no
 * owner configured, self-build is off for every iMessage sender.
 */
export function isOwnerConversation(conversationId: string, ownerNumbers: string | undefined): boolean {
  if (!conversationId.startsWith("sms:")) return true;
  const sender = digitsOnly(conversationId.slice(4));
  if (!sender) return false;
  return (ownerNumbers ?? "")
    .split(",")
    .map(digitsOnly)
    .filter(Boolean)
    .some((owner) => owner === sender);
}

export function newBuildId(now = Date.now(), random = Math.random()): string {
  return `b${now.toString(36)}${random.toString(36).slice(2, 6)}`;
}

export function slugify(request: string, maxWords = 6): string {
  return (
    request
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word && !["boop", "please", "can", "you", "a", "the", "to", "me", "my"].includes(word))
      .slice(0, maxWords)
      .join("-")
      .replace(/-+/g, "-")
      .slice(0, 48)
      .replace(/-$/, "") || "feature"
  );
}

export function branchName(request: string, buildId: string): string {
  return `boop/self-build-${slugify(request)}-${buildId}`;
}

/** owner/name from an https or ssh GitHub remote URL. */
export function parseGitHubRepo(remoteUrl: string): string | null {
  const match = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function codingPrompt(request: string): string {
  return `You are working on Boop's own source code, in a fresh git worktree on its own branch. The owner asked, over iMessage:

"${request}"

Build it.
- Read AGENTS.md / CLAUDE.md and the code around the change first, and follow the existing conventions.
- Keep the change focused on the request. No unrelated refactors.
- Add or update tests under test/ for the behaviour you change.
- Run \`npx tsc --noEmit\` and \`npx vitest run\` and fix what fails.
- Commit your work on this branch with a clear message (git add + git commit). Do not push, do not open a PR, do not switch branches.
- Never create, read, print or edit .env, .env.local or any secrets file, and never add credentials to the code.
- Do not run the app, \`npm run dev\`, \`npm run desktop:*\` or anything that restarts Boop.

Finish with a short plain-language summary for the owner: what you built, how to use it, and anything you could not do.`;
}

export function tail(text: string, lines = 30): string {
  const all = text.trimEnd().split("\n");
  return all.slice(-lines).join("\n");
}

export function prBody(input: {
  request: string;
  summary: string;
  testsPassed: boolean;
  testOutput: string;
}): string {
  return [
    "Built by Boop from an iMessage request.",
    "",
    `> ${input.request.replace(/\n/g, "\n> ")}`,
    "",
    "## Summary",
    input.summary.trim() || "(no summary)",
    "",
    `## Checks: ${input.testsPassed ? "passing" : "FAILING"}`,
    "```",
    tail(input.testOutput, 40),
    "```",
    "",
    "Reply \"ship it\" to Boop to merge, rebuild and restart.",
  ].join("\n");
}

export function readyMessage(input: {
  buildId: string;
  summary: string;
  prUrl: string;
  testsPassed: boolean;
}): string {
  const summary = input.summary.trim().split("\n").slice(0, 8).join("\n");
  return [
    `Build ${input.buildId} is ready for review.`,
    "",
    summary,
    "",
    input.testsPassed ? "Typecheck and tests pass." : "Heads up: typecheck or tests are failing.",
    input.prUrl,
    "",
    "Reply \"ship it\" to install it (I'll restart), or \"cancel build\".",
  ].join("\n");
}

/**
 * Runs outside Boop, because the app can't replace itself while running:
 * quit Boop, swap in the new bundle, relaunch, and put the previous build
 * back if the new one doesn't answer its health check.
 *
 * Quitting has to be thorough. A plain SIGTERM leaves the Electron main
 * process alive (it only stops the server), and macOS `open` then just
 * re-activates that old instance instead of launching the new bundle. So:
 * quit by bundle id, then make sure no process from the bundle and nothing on
 * Boop's ports survives, force-killing what does.
 */
export function restartScript(input: {
  buildId: string;
  newAppPath: string;
  appPath: string;
  backupDir: string;
  resultPath: string;
  healthUrl: string;
  logPath?: string;
  bundleId?: string;
  ports?: number[];
  /** Per-build, per-attempt file the new build writes its startup output to. */
  startupLogPath?: string;
  /** File the new build's Electron main reads to learn where startupLogPath is. */
  startupMarkerPath?: string;
  healthTimeoutSec?: number;
}): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const ports = (input.ports ?? [3456, 5173, 4040]).join(" ");
  const startupLog = input.startupLogPath ?? `${input.resultPath}.startup.log`;
  return `#!/bin/bash
set -u
# open passes this to the app it launches; Boop would start as plain Node and exit.
unset ELECTRON_RUN_AS_NODE BOOP_NODE_CMD
NEW=${q(input.newAppPath)}
APP=${q(input.appPath)}
BACKUP=${q(input.backupDir)}
RESULT=${q(input.resultPath)}
HEALTH=${q(input.healthUrl)}
BUILD=${q(input.buildId)}
LOG=${q(input.logPath ?? `${input.resultPath}.log`)}
BUNDLE_ID=${q(input.bundleId ?? "com.raroque.boop")}
PORTS="${ports}"
STARTUP_LOG=${q(startupLog)}
STARTUP_MARKER=${q(input.startupMarkerPath ?? `${input.resultPath}.startup-request`)}
HEALTH_TIMEOUT=${input.healthTimeoutSec === undefined ? healthTimeoutSeconds() : Math.max(1, Math.round(input.healthTimeoutSec))}

log() { printf '%s %s\\n' "$(date +%H:%M:%S)" "$*" >> "$LOG"; }
# Notes in the new build's own startup log. Appended only, never truncated.
startup_note() { printf '%s [restart-helper] %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$STARTUP_LOG"; }

write_result() {
  log "result: $1"
  printf '{"buildId":"%s","status":"%s","at":"%s","startupLog":"%s","healthTimeoutSec":%s}\\n' "$BUILD" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STARTUP_LOG" "$HEALTH_TIMEOUT" > "$RESULT"
}

boop_pids() {
  pgrep -f "^$APP/Contents/" 2>/dev/null
  for port in $PORTS; do lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null; done
}

stop_boop() {
  log "quitting $BUNDLE_ID"
  osascript -e "tell application id \\"$BUNDLE_ID\\" to quit" >/dev/null 2>&1
  for _ in $(seq 1 30); do
    [ -z "$(boop_pids)" ] && { log "stopped cleanly"; return 0; }
    sleep 1
  done
  log "still running, sending TERM: $(boop_pids | sort -u | tr '\\n' ' ')"
  boop_pids | sort -u | xargs kill -TERM 2>/dev/null
  sleep 5
  if [ -n "$(boop_pids)" ]; then
    log "sending KILL: $(boop_pids | sort -u | tr '\\n' ' ')"
    boop_pids | sort -u | xargs kill -KILL 2>/dev/null
    sleep 2
  fi
  [ -z "$(boop_pids)" ] && { log "stopped"; return 0; }
  log "could not stop: $(boop_pids | sort -u | tr '\\n' ' ')"
  return 1
}

wait_for_health() {
  local start=$SECONDS
  while [ $((SECONDS - start)) -lt "$HEALTH_TIMEOUT" ]; do
    curl -fsS -m 3 "$HEALTH" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

log "restart for build $BUILD"
sleep 3
stop_boop || { write_result failed; exit 1; }

mkdir -p "$BACKUP"
rm -rf "$BACKUP/Boop.app"
mv "$APP" "$BACKUP/Boop.app" || { log "backup failed"; open -a "$APP"; write_result failed; exit 1; }
if ! ditto "$NEW" "$APP"; then
  log "copy failed, restoring"
  rm -rf "$APP"; mv "$BACKUP/Boop.app" "$APP"; open -a "$APP"; write_result rolled_back; exit 1
fi
log "launching new build (health timeout \${HEALTH_TIMEOUT}s, startup log $STARTUP_LOG)"
# The new build claims this marker at launch and writes its startup output to
# STARTUP_LOG. It is removed before any rollback so the previous version never
# writes to (or truncates) the failed build's log.
mkdir -p "$(dirname "$STARTUP_LOG")"
startup_note "launching build $BUILD (health check $HEALTH, timeout \${HEALTH_TIMEOUT}s)"
printf '%s\\n' "$STARTUP_LOG" > "$STARTUP_MARKER"
LAUNCHED_AT=$SECONDS
open -a "$APP"

if wait_for_health; then
  rm -f "$STARTUP_MARKER"
  startup_note "[phase] health endpoint ready +$((SECONDS - LAUNCHED_AT))s"
  write_result shipped
else
  rm -f "$STARTUP_MARKER"
  startup_note "health check timed out after $((SECONDS - LAUNCHED_AT))s (limit \${HEALTH_TIMEOUT}s), rolling back"
  log "new build never answered, rolling back"
  stop_boop
  rm -rf "$APP"
  mv "$BACKUP/Boop.app" "$APP"
  open -a "$APP"
  write_result rolled_back
fi
`;
}

export const DEFAULT_HEALTH_TIMEOUT_SEC = 180;

/**
 * How long a restarted build gets to answer its health check: an explicit
 * value (from ship_self_build), else BOOP_SELF_BUILD_HEALTH_TIMEOUT, else 180s.
 * Clamped to 30s–1h so a typo can't hang or instantly fail a ship.
 */
export function healthTimeoutSeconds(
  override?: number | string,
  env: string | undefined = process.env.BOOP_SELF_BUILD_HEALTH_TIMEOUT,
): number {
  for (const candidate of [override, env]) {
    const value = Number(candidate);
    if (candidate !== undefined && candidate !== "" && Number.isFinite(value) && value > 0) {
      return Math.min(3600, Math.max(30, Math.round(value)));
    }
  }
  return DEFAULT_HEALTH_TIMEOUT_SEC;
}

/** startup-<buildId>-<attempt>.log, attempt counting up per ship of that build. */
export function startupLogName(buildId: string, existing: string[]): string {
  const prefix = `startup-${buildId}-`;
  const attempts = existing
    .filter((name) => name.startsWith(prefix) && name.endsWith(".log"))
    .map((name) => Number(name.slice(prefix.length, -".log".length)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return `${prefix}${Math.max(0, ...attempts) + 1}.log`;
}

export const KEEP_BUILD_LOGS = 10;

/**
 * Self-build files to delete so only the newest `keep` of each kind remain
 * (startup logs, restart helper logs, restart scripts).
 */
export function logsToPrune(files: { name: string; mtimeMs: number }[], keep = KEEP_BUILD_LOGS): string[] {
  const kinds: [string, string][] = [
    ["startup-", ".log"],
    ["restart-", ".log"],
    ["restart-", ".sh"],
  ];
  return kinds.flatMap(([prefix, suffix]) =>
    files
      .filter((f) => f.name.startsWith(prefix) && f.name.endsWith(suffix))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(keep)
      .map((f) => f.name),
  );
}

export const ROLLBACK_LOG_LINES = 50;

export function rollbackMessage(input: { buildId: string; logPath?: string; logTail?: string; healthTimeoutSec?: number }): string {
  const lines = [
    `Build ${input.buildId} didn't start properly${input.healthTimeoutSec ? ` (no health check answer within ${input.healthTimeoutSec}s)` : ""}, so I rolled back to the previous version. The code is still merged; ask me to look into it.`,
  ];
  if (input.logPath) {
    lines.push("", `Startup log: ${input.logPath}`);
    lines.push(input.logTail?.trim() ? `Last lines:\n${input.logTail.trimEnd()}` : "(the new build wrote nothing to it)");
    lines.push("", "To retry with more time: ship it again with a longer health timeout.");
  }
  return lines.join("\n");
}
