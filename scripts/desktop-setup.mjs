#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const productName = "Boop";

const runtimeItems = [
  ".env.example",
  "assets",
  "convex",
  "debug",
  "orchestrator-go",
  "package-lock.json",
  "package.json",
  "scripts",
  "server",
  "tsconfig.json",
];

const mutableRuntimeItems = [
  ".env",
  ".env.local",
  ".env.*.local",
  ".convex",
  "convex/_generated",
  "data",
  "debug/dist",
  "dist",
  "node_modules",
];

function runtimeRootForPlatform() {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", productName, "runtime");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), productName, "runtime");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), productName, "runtime");
}

const runtimeRoot = runtimeRootForPlatform();

function logStep(title) {
  console.log(`\n==> ${title}`);
}

function commandEnv() {
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = process.env[pathKey] ?? process.env.PATH ?? "";
  const pathParts = [
    join(root, "node_modules", ".bin"),
    currentPath,
  ];
  if (process.platform === "darwin") {
    pathParts.push(
      join(homedir(), ".local", "bin"),
      join(homedir(), ".npm-global", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    );
  }
  pathParts.push(dirname(process.execPath));
  return {
    ...process.env,
    [pathKey]: pathParts.filter(Boolean).join(delimiter),
  };
}

function run(cmd, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? commandEnv(),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

function pathMatchesGlob(relativePath, pattern) {
  if (!pattern.includes("*")) return false;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(relativePath);
}

function isMutableRuntimePath(relativePath) {
  return mutableRuntimeItems.some(
    (item) =>
      relativePath === item ||
      relativePath.startsWith(`${item}/`) ||
      pathMatchesGlob(relativePath, item),
  );
}

function lstatIfExists(value) {
  try {
    return lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function copyRuntimeItem(sourceRoot, targetRoot, relativePath) {
  if (isMutableRuntimePath(relativePath)) return;

  const source = join(sourceRoot, relativePath);
  const target = join(targetRoot, relativePath);
  if (!existsSync(source)) return;

  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const targetStat = lstatIfExists(target);
    if (targetStat && !targetStat.isDirectory()) {
      rmSync(target, { force: true, recursive: true });
    }
    mkdirSync(target, { recursive: true });
    const sourceEntries = new Set(readdirSync(source));
    for (const entry of readdirSync(target)) {
      const childPath = join(relativePath, entry);
      if (isMutableRuntimePath(childPath) || sourceEntries.has(entry)) continue;
      rmSync(join(target, entry), { force: true, recursive: true });
    }
    for (const entry of [...sourceEntries].sort()) {
      copyRuntimeItem(sourceRoot, targetRoot, join(relativePath, entry));
    }
    return;
  }

  const targetStat = lstatIfExists(target);
  if (targetStat && !targetStat.isFile()) {
    rmSync(target, { force: true, recursive: true });
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function prepareRuntimeFiles() {
  mkdirSync(runtimeRoot, { recursive: true });
  for (const item of runtimeItems) {
    copyRuntimeItem(root, runtimeRoot, item);
  }
  writeFileSync(
    join(runtimeRoot, ".boop-desktop-runtime"),
    `source=${root}\nupdated=${new Date().toISOString()}\n`,
  );
}

function ensureDependencies() {
  const requiredBins = [
    join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
    join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"),
  ];
  if (requiredBins.every((bin) => existsSync(bin))) return Promise.resolve();

  logStep("Installing project dependencies");
  return run("npm", ["install"]);
}

function ensureTemporaryNodeModulesLink() {
  const source = join(root, "node_modules");
  const target = join(runtimeRoot, "node_modules");
  if (!existsSync(source)) {
    throw new Error("node_modules is missing after npm install");
  }

  let targetExists = true;
  try {
    lstatSync(target);
  } catch {
    targetExists = false;
  }

  if (!targetExists) {
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    return true;
  }

  try {
    if (lstatSync(target).isSymbolicLink()) {
      const current = readlinkSync(target);
      if (resolve(dirname(target), current) === source) return false;
      rmSync(target, { force: true, recursive: true });
      symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
      return true;
    }
  } catch {
    rmSync(target, { force: true, recursive: true });
    symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    return true;
  }

  return false;
}

function removeTemporaryNodeModulesLink(created) {
  if (!created) return;
  rmSync(join(runtimeRoot, "node_modules"), { force: true, recursive: true });
}

async function runRuntimeSetup() {
  const tsx = join(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsx.cmd" : "tsx",
  );
  const createdLink = ensureTemporaryNodeModulesLink();
  try {
    await run(tsx, ["scripts/setup.ts"], { cwd: runtimeRoot });
  } finally {
    removeTemporaryNodeModulesLink(createdLink);
  }
}

async function copyToApplicationsIfWanted(appPath) {
  if (process.platform !== "darwin" || !existsSync(appPath)) return;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("\nCopy Boop.app to /Applications now? [Y/n] ");
    if (answer.trim().toLowerCase().startsWith("n")) return;
  } finally {
    rl.close();
  }

  const destination = "/Applications/Boop.app";
  rmSync(destination, { force: true, recursive: true });
  await run("ditto", [appPath, destination], { cwd: root });
  console.log(`\nInstalled: ${destination}`);
}

async function main() {
  console.log(`
Boop desktop setup

This command prepares the desktop app runtime folder, runs Boop's existing setup
there, then builds the desktop app. Secrets stay in:
  ${runtimeRoot}

They are not copied into the app bundle.
`);

  await ensureDependencies();

  logStep("Preparing desktop runtime files");
  prepareRuntimeFiles();
  console.log(`Runtime folder: ${runtimeRoot}`);

  logStep("Running Boop setup in the desktop runtime");
  await runRuntimeSetup();

  logStep("Building the desktop app");
  await run("npm", ["run", "desktop:pack"]);

  const appPath =
    process.platform === "darwin"
      ? join(root, "dist", process.arch === "arm64" ? "mac-arm64" : "mac", "Boop.app")
      : join(root, "dist");
  await copyToApplicationsIfWanted(appPath);

  console.log(`
Done.

Runtime: ${runtimeRoot}
App:     ${appPath}

Launch Boop from the app bundle, then keep it in the Dock if you want it handy.
`);
}

main().catch((err) => {
  console.error(`\nDesktop setup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
