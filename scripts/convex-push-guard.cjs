"use strict";
// Keeps an older copy of Boop from pushing its Convex functions over newer
// ones. The Mac app pushes its functions every time it starts. If a build
// shipped from the server while the Mac was off, main (and possibly the
// deployed functions) is ahead of the Mac's app, and the Mac is about to
// install main anyway (the catch-up install); the newer app pushes when it
// starts. So when main is ahead of this app and changed convex/, skip the push.
//
// CommonJS on purpose: the Electron main process requires it.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * The commit this app was built from: stamped at build time
 * (scripts/stamp-build-info.cjs), else the install record. The install record
 * is only for apps built before the stamp: on the first start after an
 * install it still names the previous build.
 */
function appCommit({ appDir, home = os.homedir() } = {}) {
  for (const file of [
    appDir && path.join(appDir, "build-info.json"),
    path.join(home, "Library", "Application Support", "Boop", "self-build", "installed.json"),
  ]) {
    if (!file) continue;
    try {
      const commit = JSON.parse(fs.readFileSync(file, "utf8")).commit;
      if (typeof commit === "string" && commit) return commit;
    } catch {
      // missing or unreadable: try the next one
    }
  }
  return null;
}

// This runs before every Mac start's Convex sync, so keep it short: a slow
// network gives up after a few seconds and the app pushes as usual.
const FETCH_TIMEOUT_MS = 5_000;
const LOCAL_TIMEOUT_MS = 3_000;

function defaultGit(cwd) {
  return (args) =>
    new Promise((resolve, reject) => {
      const timeout = args[0] === "fetch" ? FETCH_TIMEOUT_MS : LOCAL_TIMEOUT_MS;
      execFile("git", args, { cwd, timeout }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())));
    });
}

/**
 * { skip: true, target } when origin/main is ahead of `commit` and changed
 * convex/. Never throws; any doubt (offline, unknown commit) means push.
 */
async function newerFunctionsOnMain({ sourceDir, commit, git = sourceDir ? defaultGit(sourceDir) : null }) {
  if (!sourceDir || !commit || !git) return { skip: false };
  try {
    await git(["fetch", "--quiet", "origin", "main"]);
    const target = await git(["rev-parse", "origin/main"]);
    if (!target || target === commit) return { skip: false };
    // Only when main is strictly ahead of this app.
    const ahead = await git(["merge-base", "--is-ancestor", commit, target]).then(
      () => true,
      () => false,
    );
    if (!ahead) return { skip: false };
    const changed = (await git(["diff", "--name-only", commit, target, "--", "convex"]))
      .split("\n")
      .filter((f) => f && !f.startsWith("convex/_generated/"));
    return changed.length ? { skip: true, target } : { skip: false };
  } catch {
    return { skip: false };
  }
}

module.exports = { appCommit, newerFunctionsOnMain };
