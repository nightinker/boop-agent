"use strict";
// Records the commit a Mac app is built from in electron/build-info.json, so
// the app knows its own version at startup (scripts/convex-push-guard.cjs).
// Without it the app falls back to the install record, which still names the
// previous build on the first start after an install, and would skip pushing
// its Convex functions. Runs before every desktop:pack.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function stampBuildInfo(root = path.join(__dirname, "..")) {
  const file = path.join(root, "electron", "build-info.json");
  let commit;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    commit = "";
  }
  if (!commit) {
    // Not a git checkout: an old stamp would name the wrong commit.
    fs.rmSync(file, { force: true });
    return null;
  }
  fs.writeFileSync(file, JSON.stringify({ commit }));
  return commit;
}

module.exports = { stampBuildInfo };

if (require.main === module) {
  const commit = stampBuildInfo();
  console.log(commit ? `build-info: ${commit.slice(0, 7)}` : "build-info: no git commit; not stamped");
}
