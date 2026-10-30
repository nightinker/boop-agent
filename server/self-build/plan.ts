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
 */
export function restartScript(input: {
  buildId: string;
  newAppPath: string;
  appPath: string;
  backupDir: string;
  resultPath: string;
  healthUrl: string;
}): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/bash
set -u
NEW=${q(input.newAppPath)}
APP=${q(input.appPath)}
BACKUP=${q(input.backupDir)}
RESULT=${q(input.resultPath)}
HEALTH=${q(input.healthUrl)}
BUILD=${q(input.buildId)}

write_result() {
  printf '{"buildId":"%s","status":"%s","at":"%s"}\\n' "$BUILD" "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULT"
}

wait_for_exit() {
  for _ in $(seq 1 60); do
    pgrep -f "$APP/Contents/MacOS/Boop$" >/dev/null || return 0
    sleep 1
  done
  return 1
}

wait_for_health() {
  for _ in $(seq 1 90); do
    curl -fsS -m 3 "$HEALTH" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

sleep 3
pkill -TERM -f "$APP/Contents/MacOS/Boop$"
wait_for_exit || pkill -KILL -f "$APP/Contents/MacOS/Boop$"

mkdir -p "$BACKUP"
rm -rf "$BACKUP/Boop.app"
mv "$APP" "$BACKUP/Boop.app" || { write_result failed; open -a "$BACKUP/Boop.app"; exit 1; }
if ! ditto "$NEW" "$APP"; then
  rm -rf "$APP"; mv "$BACKUP/Boop.app" "$APP"; open -a "$APP"; write_result rolled_back; exit 1
fi
open -a "$APP"

if wait_for_health; then
  write_result shipped
else
  pkill -TERM -f "$APP/Contents/MacOS/Boop$"
  wait_for_exit || pkill -KILL -f "$APP/Contents/MacOS/Boop$"
  rm -rf "$APP"
  mv "$BACKUP/Boop.app" "$APP"
  open -a "$APP"
  write_result rolled_back
fi
`;
}
