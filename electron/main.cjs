const { app, BrowserWindow, Menu, ipcMain, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const isMac = process.platform === "darwin";
const productName = "Boop";
const mutableRuntimeItems = [
  ".env",
  ".env.local",
  ".convex",
  "convex/_generated",
  "data",
  "debug/dist",
  "dist",
  "node_modules",
];
const runtimeItems = [
  ".env.example",
  "assets",
  "convex",
  "debug",
  "package-lock.json",
  "package.json",
  "scripts",
  "server",
  "tsconfig.json",
];

let mainWindow;
let boopProcess;
let bootstrapProcess;
let webhookCheckTimer;
let webhookCheckSequence = 0;
let quitting = false;
let intentionalStop = false;
let starting = false;
let runtimeRoot = "";
let cachedConnectionStatus = null;

const status = {
  state: "stopped",
  server: "stopped",
  convex: "stopped",
  dashboard: "stopped",
  tunnel: "unknown",
  webhook: "unknown",
  dashboardUrl: "http://localhost:5173",
  publicUrl: "",
  expectedWebhookUrl: "",
  registeredWebhookUrl: "",
  webhookDetails: "",
  webhookCheckedAt: "",
  convexUrl: "",
  phoneNumber: "",
  runtimeRoot: "",
  lastMessage: "",
};

function desktopDataRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", productName);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), productName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), productName);
}

app.setName(productName);
app.setPath("userData", desktopDataRoot());

// Self-build restart diagnostics. When the restart helper launches a new
// build it leaves a marker naming a per-build log file; this launch claims
// the marker and appends all startup output there with timestamps and phase
// markers, so a build that fails its health check (and gets rolled back)
// still leaves a record of why. Normal launches find no marker and log nothing.
const STARTUP_LOG_MAX_MS = 15 * 60_000;
const STARTUP_LOG_MAX_BYTES = 5 * 1024 * 1024;
let startupLog = null;

function claimStartupLog() {
  const marker = path.join(desktopDataRoot(), "self-build", "startup-log-request");
  let target = "";
  try {
    target = fs.readFileSync(marker, "utf8").trim();
    fs.unlinkSync(marker);
  } catch {
    return;
  }
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    startupLog = { fd: fs.openSync(target, "a"), startedAt: Date.now(), bytes: 0, phases: new Set() };
    writeStartupLog(`[electron] app launched (version ${app.getVersion()}, pid ${process.pid})`);
    process.on("unhandledRejection", (reason) => {
      writeStartupLog(`[electron] unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
    });
  } catch {
    startupLog = null;
  }
}

function writeStartupLog(line) {
  if (!startupLog) return;
  const elapsed = Date.now() - startupLog.startedAt;
  if (elapsed > STARTUP_LOG_MAX_MS || startupLog.bytes > STARTUP_LOG_MAX_BYTES) {
    closeStartupLog("startup log closed (time or size limit reached)");
    return;
  }
  const text = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.writeSync(startupLog.fd, text);
    startupLog.bytes += Buffer.byteLength(text);
  } catch {
    startupLog = null;
  }
}

function closeStartupLog(reason) {
  if (!startupLog) return;
  const { fd } = startupLog;
  try {
    fs.writeSync(fd, `${new Date().toISOString()} [electron] ${reason}\n`);
    fs.closeSync(fd);
  } catch {}
  startupLog = null;
}

function startupPhase(name) {
  if (!startupLog || startupLog.phases.has(name)) return;
  startupLog.phases.add(name);
  const seconds = ((Date.now() - startupLog.startedAt) / 1000).toFixed(1);
  writeStartupLog(`[phase] ${name} +${seconds}s`);
}

// Observe only: neither hook changes how Electron handles the error.
process.on("uncaughtExceptionMonitor", (error) => {
  writeStartupLog(`[electron] uncaught exception: ${error && error.stack ? error.stack : error}`);
});

function isInsideMutablePath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (/^\.env\..+\.local$/.test(normalized)) return true;
  return mutableRuntimeItems.some(
    (item) => normalized === item || normalized.startsWith(`${item}/`),
  );
}

function lstatIfExists(value) {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function copyRuntimeItem(sourceRoot, targetRoot, relativePath) {
  if (isInsideMutablePath(relativePath)) return;

  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  if (!fs.existsSync(source)) return;

  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    const targetStat = lstatIfExists(target);
    if (targetStat && !targetStat.isDirectory()) {
      fs.rmSync(target, { force: true, recursive: true });
    }
    fs.mkdirSync(target, { recursive: true });

    const sourceEntries = new Set(fs.readdirSync(source));
    for (const entry of fs.readdirSync(target)) {
      const childPath = path.join(relativePath, entry);
      if (isInsideMutablePath(childPath) || sourceEntries.has(entry)) continue;
      fs.rmSync(path.join(target, entry), { force: true, recursive: true });
    }
    for (const entry of fs.readdirSync(source)) {
      copyRuntimeItem(sourceRoot, targetRoot, path.join(relativePath, entry));
    }
    return;
  }

  const targetStat = lstatIfExists(target);
  if (targetStat && !targetStat.isFile()) {
    fs.rmSync(target, { force: true, recursive: true });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function linkNodeModules(sourceRoot, targetRoot) {
  const source = path.join(sourceRoot, "node_modules");
  const target = path.join(targetRoot, "node_modules");
  if (!fs.existsSync(source)) return;
  try {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink()) {
      const current = fs.readlinkSync(target);
      if (path.resolve(path.dirname(target), current) === source) return;
    }
    fs.rmSync(target, { force: true, recursive: true });
  } catch {
    // Missing target is the normal first-launch path.
  }
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(source, target, type);
}

function preparePackagedRuntime() {
  const sourceRoot = app.getAppPath();
  const targetRoot = path.join(app.getPath("userData"), "runtime");
  fs.mkdirSync(targetRoot, { recursive: true });

  for (const item of runtimeItems) {
    copyRuntimeItem(sourceRoot, targetRoot, item);
  }
  linkNodeModules(sourceRoot, targetRoot);
  fs.writeFileSync(
    path.join(targetRoot, ".boop-desktop-runtime"),
    `source=${sourceRoot}${os.EOL}updated=${new Date().toISOString()}${os.EOL}`,
  );
  return targetRoot;
}

function getRuntimeRoot() {
  if (!app.isPackaged) return path.resolve(__dirname, "..");
  return preparePackagedRuntime();
}

function getIconPath() {
  const root = runtimeRoot || getRuntimeRoot();
  const candidates = [
    path.join(root, "assets", "boop-app-icon.png"),
    path.join(root, "assets", "boop.png"),
    path.join(root, "debug", "public", "appicon.png"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function createIcon(size = 256) {
  const image = nativeImage.createFromPath(getIconPath());
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: size, height: size });
}

function writeNodeShim() {
  const shimDir = path.join(app.getPath("userData"), "bin");
  fs.mkdirSync(shimDir, { recursive: true });

  if (process.platform === "win32") {
    const shim = path.join(shimDir, "node.cmd");
    fs.writeFileSync(
      shim,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
    );
    return { dir: shimDir, cmd: shim };
  }

  const shim = path.join(shimDir, "node");
  fs.writeFileSync(
    shim,
    `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  );
  fs.chmodSync(shim, 0o755);
  return { dir: shimDir, cmd: shim };
}

function childEnv() {
  const nodeShim = writeNodeShim();
  const binDir = path.join(runtimeRoot, "node_modules", ".bin");
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const existingPath = process.env[pathKey] || process.env.PATH || "";
  const macCliPaths =
    process.platform === "darwin"
      ? [
          path.join(os.homedir(), ".local", "bin"),
          path.join(os.homedir(), ".npm-global", "bin"),
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
          "/usr/local/sbin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ]
      : [];
  return {
    ...process.env,
    BOOP_DESKTOP: "1",
    BOOP_NODE_CMD: nodeShim.cmd,
    FORCE_COLOR: "0",
    [pathKey]: [nodeShim.dir, binDir, ...macCliPaths, existingPath].filter(Boolean).join(path.delimiter),
  };
}

const packageBinPaths = {
  convex: ["convex", "bin", "main.js"],
  tsx: ["tsx", "dist", "cli.mjs"],
  vite: ["vite", "bin", "vite.js"],
};

function localCommand(name) {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const candidate = path.join(runtimeRoot, "node_modules", ".bin", `${name}${ext}`);
  if (fs.existsSync(candidate)) return { cmd: candidate, args: [] };
  const packageBin = packageBinPaths[name];
  if (packageBin) {
    const script = path.join(runtimeRoot, "node_modules", ...packageBin);
    if (fs.existsSync(script)) return { cmd: "node", args: [script] };
  }
  return { cmd: name, args: [] };
}

function readRuntimeEnv() {
  const env = {};
  if (!runtimeRoot) return env;

  for (const filename of [".env", ".env.local"]) {
    const file = path.join(runtimeRoot, filename);
    if (!fs.existsSync(file)) continue;

    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;

      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      value = value.replace(/^['"]|['"]$/g, "");
      env[key] = value;
    }
  }

  return env;
}

function readConnectionStatus() {
  const env = readRuntimeEnv();
  return {
    convexUrl: env.CONVEX_URL || env.VITE_CONVEX_URL || "",
    phoneNumber: env.SENDBLUE_FROM_NUMBER || "",
  };
}

function refreshConnectionStatus() {
  cachedConnectionStatus = readConnectionStatus();
  return cachedConnectionStatus;
}

function connectionStatus() {
  return cachedConnectionStatus || refreshConnectionStatus();
}

function plainStatus(value) {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ");
}

function setStatus(partial) {
  Object.assign(status, connectionStatus(), partial, { runtimeRoot });
  const ready =
    status.server === "running" &&
    status.convex === "running" &&
    status.dashboard === "running";
  if (ready && status.state !== "error" && status.state !== "setup-required") {
    status.state = "running";
  }
  updateMenus();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("boop-status", status);
  }
}

function webhookUrlFromPublicUrl(publicUrl) {
  const trimmed = (publicUrl || "").replace(/\/$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/sendblue/webhook") ? trimmed : `${trimmed}/sendblue/webhook`;
}

function applyWebhookCheck(result) {
  setStatus({
    webhook: result.state || (result.ok ? "registered" : "error"),
    expectedWebhookUrl: result.expectedWebhookUrl || status.expectedWebhookUrl,
    registeredWebhookUrl: result.registeredWebhookUrl || "",
    webhookDetails: result.details || "",
    webhookCheckedAt: result.checkedAt || new Date().toISOString(),
  });
}

function runWebhookCheck(expectedUrl, sequence = ++webhookCheckSequence) {
  if (!expectedUrl || !runtimeRoot) {
    setStatus({
      webhook: "no-tunnel",
      expectedWebhookUrl: "",
      registeredWebhookUrl: "",
      webhookDetails: "No active public URL is available for Sendblue.",
      webhookCheckedAt: new Date().toISOString(),
    });
    return Promise.resolve(status);
  }

  return new Promise((resolve) => {
    const script = path.join(runtimeRoot, "scripts", "sendblue-webhook.mjs");
    const child = spawn("node", [script, "--check", "--json", expectedUrl], {
      cwd: runtimeRoot,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (sequence !== webhookCheckSequence) return resolve(status);
      setStatus({
        webhook: "error",
        expectedWebhookUrl: expectedUrl,
        registeredWebhookUrl: "",
        webhookDetails: error.message,
        webhookCheckedAt: new Date().toISOString(),
      });
      resolve(status);
    });
    child.on("exit", () => {
      if (sequence !== webhookCheckSequence) return resolve(status);
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      if (!jsonLine) {
        setStatus({
          webhook: "error",
          expectedWebhookUrl: expectedUrl,
          registeredWebhookUrl: "",
          webhookDetails: stderr.trim() || stdout.trim() || "Sendblue webhook check did not return JSON.",
          webhookCheckedAt: new Date().toISOString(),
        });
        return resolve(status);
      }
      try {
        applyWebhookCheck(JSON.parse(jsonLine));
      } catch (error) {
        setStatus({
          webhook: "error",
          expectedWebhookUrl: expectedUrl,
          registeredWebhookUrl: "",
          webhookDetails: error instanceof Error ? error.message : String(error),
          webhookCheckedAt: new Date().toISOString(),
        });
      }
      resolve(status);
    });
  });
}

function scheduleWebhookCheck(publicUrl, delayMs = 1000) {
  const expectedUrl = webhookUrlFromPublicUrl(publicUrl);
  if (!expectedUrl) return;
  const sequence = ++webhookCheckSequence;
  clearTimeout(webhookCheckTimer);
  setStatus({
    webhook: "checking",
    expectedWebhookUrl: expectedUrl,
    registeredWebhookUrl: "",
    webhookDetails: "Checking Sendblue registration against the active tunnel.",
  });
  webhookCheckTimer = setTimeout(() => {
    runWebhookCheck(expectedUrl, sequence).catch(() => undefined);
  }, delayMs);
}

function checkSendblueWebhook() {
  const expectedUrl = status.expectedWebhookUrl || webhookUrlFromPublicUrl(status.publicUrl);
  setStatus({
    webhook: expectedUrl ? "checking" : "no-tunnel",
    expectedWebhookUrl: expectedUrl,
    registeredWebhookUrl: "",
    webhookDetails: expectedUrl
      ? "Checking Sendblue registration against the active tunnel."
      : "No active public URL is available for Sendblue.",
  });
  return runWebhookCheck(expectedUrl);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function loadStatusPage() {
  if (!mainWindow) return;
  mainWindow.loadFile(path.join(__dirname, "status.html")).catch(() => undefined);
  showMainWindow();
}

function ensureNativeWindowButtons() {
  if (!isMac || !mainWindow) return;
  mainWindow.setWindowButtonVisibility(true);
  mainWindow.setWindowButtonPosition({ x: 18, y: 18 });
}

function createWindow() {
  const statusPageUrl = pathToFileURL(path.join(__dirname, "status.html")).href;
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    title: "Boop",
    icon: getIconPath(),
    show: false,
    backgroundColor: "#101012",
    titleBarStyle: isMac ? "hidden" : undefined,
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== statusPageUrl) event.preventDefault();
  });

  if (isMac) {
    ensureNativeWindowButtons();
    mainWindow.on("show", ensureNativeWindowButtons);
    mainWindow.on("focus", ensureNativeWindowButtons);
    mainWindow.on("blur", ensureNativeWindowButtons);
    mainWindow.on("restore", ensureNativeWindowButtons);
  }

  mainWindow.once("ready-to-show", () => {
    ensureNativeWindowButtons();
    mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  loadStatusPage();
}

function openDashboardInWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow) {
    mainWindow.webContents.send("boop-open-dashboard", status.dashboardUrl);
  }
  showMainWindow();
}

function statusMenuTemplate() {
  const canOpenDashboard = status.dashboard === "running" && Boolean(status.dashboardUrl);
  const canStop = Boolean(boopProcess || bootstrapProcess || starting);
  return [
    { label: `Boop: ${plainStatus(status.state)}`, enabled: false },
    { type: "separator" },
    { label: `Server: ${plainStatus(status.server)}`, enabled: false },
    { label: `Convex: ${plainStatus(status.convex)}`, enabled: false },
    { label: `Dashboard: ${plainStatus(status.dashboard)}`, enabled: false },
    { label: `Tunnel: ${plainStatus(status.tunnel)}`, enabled: false },
    { label: `Sendblue Webhook: ${plainStatus(status.webhook)}`, enabled: false },
    { type: "separator" },
    {
      label: "Open Dashboard",
      enabled: canOpenDashboard,
      click: openDashboardInWindow,
    },
    { label: "Show Boop", click: loadStatusPage },
    {
      label: "Check Sendblue Webhook",
      enabled: Boolean(status.expectedWebhookUrl || status.publicUrl),
      click: checkSendblueWebhook,
    },
    { label: "Start Boop", enabled: !boopProcess && !starting, click: startBoop },
    { label: "Restart Boop", enabled: !starting, click: restartBoop },
    { label: "Stop Boop", enabled: canStop, click: stopBoop },
    { type: "separator" },
    { label: "Open Runtime Folder", click: () => shell.openPath(runtimeRoot) },
  ];
}

function updateMenus() {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Status",
      submenu: statusMenuTemplate(),
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function ingestLine(line) {
  const plain = stripAnsi(line).trim();
  if (!plain) return;
  if (
    intentionalStop &&
    (/^ngrok\s+│/.test(plain) || /obj=tunnels\.session|command_line/.test(plain)) &&
    /Stopping forwarder|Listener closed|failed to accept connection|accept failed|session closed/.test(
      plain,
    )
  ) {
    return;
  }

  const next = { lastMessage: plain };
  let checkWebhookForPublicUrl = "";
  if (/boop-agent server listening on :/.test(plain)) {
    next.server = "running";
    startupPhase("server boot: listening");
  }
  if (/Convex functions ready/.test(plain)) {
    next.convex = "running";
    startupPhase("convex connect: functions ready");
  }

  const dashboardMatch =
    plain.match(/Local:\s+(http:\/\/\S+)/) ||
    plain.match(/Debug dashboard(?: \(click me\))?:\s+(http:\/\/\S+)/);
  if (dashboardMatch) {
    next.dashboard = "running";
    next.dashboardUrl = dashboardMatch[1].replace(/\/$/, "");
  }

  const publicMatch = plain.match(/Public URL:\s+(https?:\/\/\S+)/);
  if (publicMatch) {
    const publicUrl = publicMatch[1].replace(/\/$/, "");
    next.tunnel = "running";
    next.publicUrl = publicUrl;
    next.webhook = "checking";
    next.expectedWebhookUrl = webhookUrlFromPublicUrl(publicUrl);
    next.registeredWebhookUrl = "";
    next.webhookDetails = "Checking Sendblue registration against the active tunnel.";
    checkWebhookForPublicUrl = publicUrl;
    startupPhase("tunnel setup: public URL ready");
  }
  if (/could not read tunnel URL/.test(plain)) startupPhase("tunnel setup: failed to read tunnel URL");

  if (/ngrok is not installed|No public tunnel configured/.test(plain)) {
    next.tunnel = "stopped";
    next.webhook = "no-tunnel";
    next.expectedWebhookUrl = "";
    next.registeredWebhookUrl = "";
    next.webhookDetails = "No public tunnel is running, so Sendblue cannot reach this app.";
    startupPhase("tunnel setup: no tunnel configured");
  }
  if (/Convex types haven't been generated/.test(plain)) next.state = "setup-required";
  if (/A child process exited with code|fatal /.test(plain)) next.state = "error";

  setStatus(next);
  if (checkWebhookForPublicUrl) scheduleWebhookCheck(checkWebhookForPublicUrl);
}

function pipeOutput(stream, shouldIngest = () => true) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      writeStartupLog(stripAnsi(buffer.slice(0, index)));
      if (shouldIngest()) ingestLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
}

function runBootstrap(command, args) {
  return new Promise((resolve, reject) => {
    bootstrapProcess = spawn(command, args, {
      cwd: runtimeRoot,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    pipeOutput(bootstrapProcess.stdout);
    pipeOutput(bootstrapProcess.stderr);
    bootstrapProcess.on("error", (error) => {
      bootstrapProcess = undefined;
      reject(error);
    });
    bootstrapProcess.on("exit", (code) => {
      bootstrapProcess = undefined;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function syncConvexRuntime() {
  const generatedApi = path.join(runtimeRoot, "convex", "_generated", "api.js");
  const convex = localCommand("convex");
  setStatus({
    state: "starting",
    convex: "starting",
    lastMessage: fs.existsSync(generatedApi)
      ? "Synchronizing Convex functions for this desktop version."
      : "Generating Convex files in the desktop runtime folder.",
  });
  startupPhase("convex sync: started");
  await runBootstrap(convex.cmd, [...convex.args, "dev", "--once", "--typecheck=disable"]);
  startupPhase("convex sync: finished");
  refreshConnectionStatus();
}

function resetServiceStatuses(state) {
  clearTimeout(webhookCheckTimer);
  webhookCheckSequence += 1;
  refreshConnectionStatus();
  setStatus({
    state,
    server: state === "stopped" ? "stopped" : "starting",
    convex: state === "stopped" ? "stopped" : "starting",
    dashboard: state === "stopped" ? "stopped" : "starting",
    tunnel: "unknown",
    webhook: "unknown",
    publicUrl: "",
    expectedWebhookUrl: "",
    registeredWebhookUrl: "",
    webhookDetails: "",
    webhookCheckedAt: "",
    lastMessage: "",
  });
}

async function startBoop() {
  if (boopProcess || starting) {
    showMainWindow();
    return;
  }

  starting = true;
  intentionalStop = false;
  resetServiceStatuses("starting");
  try {
    await syncConvexRuntime();
  } catch (error) {
    starting = false;
    if (intentionalStop) {
      resetServiceStatuses("stopped");
      return;
    }
    writeStartupLog(`[electron] convex sync failed: ${error instanceof Error ? error.message : String(error)}`);
    setStatus({
      state: "setup-required",
      server: "stopped",
      dashboard: "stopped",
      lastMessage: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const script = path.join(runtimeRoot, "scripts", "dev.mjs");
  boopProcess = spawn("node", [script], {
    cwd: runtimeRoot,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const child = boopProcess;
  starting = false;
  startupPhase("server boot: process started");

  pipeOutput(child.stdout, () => boopProcess === child);
  pipeOutput(child.stderr, () => boopProcess === child);
  child.on("error", (error) => {
    writeStartupLog(`[electron] server process error: ${error.message}`);
    if (boopProcess !== child) return;
    starting = false;
    boopProcess = undefined;
    setStatus({ state: "error", lastMessage: error.message });
  });
  child.on("exit", (code, signal) => {
    writeStartupLog(`[electron] server process exited (code ${code}, signal ${signal})`);
    if (boopProcess !== child) return;
    starting = false;
    boopProcess = undefined;
    if (quitting || intentionalStop || status.state === "stopped") return;
    if (code === 0 || status.state === "setup-required") {
      resetServiceStatuses(status.state === "setup-required" ? "setup-required" : "stopped");
    } else {
      setStatus({
        state: "error",
        server: "stopped",
        convex: "stopped",
        dashboard: "stopped",
        lastMessage: `Boop exited with code ${code}`,
      });
    }
  });
}

function stopBoop() {
  if (bootstrapProcess) {
    intentionalStop = true;
    bootstrapProcess.kill("SIGTERM");
    bootstrapProcess = undefined;
  }
  if (!boopProcess) {
    starting = false;
    resetServiceStatuses("stopped");
    return;
  }
  const child = boopProcess;
  boopProcess = undefined;
  starting = false;
  intentionalStop = true;
  resetServiceStatuses("stopped");
  setStatus({ lastMessage: "Boop is stopped." });
  child.kill("SIGTERM");
}

function restartBoop() {
  stopBoop();
  setStatus({
    state: "starting",
    server: "starting",
    convex: "starting",
    dashboard: "starting",
    tunnel: "unknown",
    publicUrl: "",
    lastMessage: "Restarting Boop.",
  });
  setTimeout(startBoop, 700);
}

ipcMain.handle("boop:get-status", () => status);
ipcMain.handle("boop:start", async () => {
  await startBoop();
  return status;
});
ipcMain.handle("boop:stop", () => {
  stopBoop();
  return status;
});
ipcMain.handle("boop:restart", () => {
  restartBoop();
  return status;
});
ipcMain.handle("boop:check-webhook", async () => {
  await checkSendblueWebhook();
  return status;
});
ipcMain.handle("boop:open-dashboard", () => {
  if (!status.dashboardUrl) return;
  openDashboardInWindow();
  return status.dashboardUrl;
});
ipcMain.handle("boop:show-runtime-folder", () => shell.openPath(runtimeRoot));

claimStartupLog();

app.whenReady().then(() => {
  startupPhase("electron ready");
  runtimeRoot = getRuntimeRoot();
  Object.assign(status, refreshConnectionStatus(), { runtimeRoot });
  if (isMac && app.dock) app.dock.setIcon(createIcon(256));

  createWindow();
  startBoop();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    showMainWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
  stopBoop();
  writeStartupLog("[electron] quitting");
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
