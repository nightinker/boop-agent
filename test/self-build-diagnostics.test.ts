import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));
const convexMock = vi.hoisted(() => ({ query: vi.fn(), mutation: vi.fn() }));
const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home.dir || actual.homedir() };
});
vi.mock("../server/convex-client.js", () => ({ convex: convexMock }));
vi.mock("../server/notify.js", () => ({ notifyConversation: notifyMock }));

import {
  DEFAULT_HEALTH_TIMEOUT_SEC,
  healthTimeoutSeconds,
  logsToPrune,
  restartScript,
  rollbackMessage,
  startupLogName,
} from "../server/self-build/plan.js";
import { listSelfBuilds, reportPendingRestart } from "../server/self-build/run.js";

describe("health check timeout", () => {
  it("defaults to 180s", () => {
    expect(healthTimeoutSeconds(undefined, undefined)).toBe(DEFAULT_HEALTH_TIMEOUT_SEC);
    expect(DEFAULT_HEALTH_TIMEOUT_SEC).toBe(180);
  });

  it("reads BOOP_SELF_BUILD_HEALTH_TIMEOUT, and an explicit value wins", () => {
    expect(healthTimeoutSeconds(undefined, "300")).toBe(300);
    expect(healthTimeoutSeconds(600, "300")).toBe(600);
  });

  it("ignores junk and clamps to 30s–1h", () => {
    expect(healthTimeoutSeconds(undefined, "soon")).toBe(180);
    expect(healthTimeoutSeconds(undefined, "")).toBe(180);
    expect(healthTimeoutSeconds(5, undefined)).toBe(30);
    expect(healthTimeoutSeconds(99999, undefined)).toBe(3600);
  });

  it("is written into the restart script", () => {
    const script = restartScript({
      buildId: "b1",
      newAppPath: "/n/Boop.app",
      appPath: "/Applications/Boop.app",
      backupDir: "/b",
      resultPath: "/r",
      healthUrl: "h",
      healthTimeoutSec: 420,
    });
    expect(script).toContain("HEALTH_TIMEOUT=420");
    expect(script).toContain('-lt "$HEALTH_TIMEOUT"');
  });
});

describe("startup log files", () => {
  it("names logs by build id and attempt", () => {
    expect(startupLogName("b1", [])).toBe("startup-b1-1.log");
    expect(startupLogName("b1", ["startup-b1-1.log", "startup-b1-2.log", "startup-b2-7.log", "x"])).toBe(
      "startup-b1-3.log",
    );
  });

  it("keeps only the newest 10 of each kind", () => {
    const files = Array.from({ length: 12 }, (_, i) => [
      { name: `startup-b${i}-1.log`, mtimeMs: i },
      { name: `restart-b${i}.log`, mtimeMs: i },
      { name: `restart-b${i}.sh`, mtimeMs: i },
    ]).flat();
    files.push({ name: "pending-result.json", mtimeMs: 0 }, { name: "previous", mtimeMs: 0 });
    const pruned = logsToPrune(files);
    expect(pruned.sort()).toEqual(
      ["restart-b0.log", "restart-b0.sh", "restart-b1.log", "restart-b1.sh", "startup-b0-1.log", "startup-b1-1.log"].sort(),
    );
  });

  it("puts the log path and tail in the rollback text", () => {
    const text = rollbackMessage({ buildId: "b1", logPath: "/logs/startup-b1-1.log", logTail: "Error: boom", healthTimeoutSec: 180 });
    expect(text).toContain("rolled back");
    expect(text).toContain("within 180s");
    expect(text).toContain("/logs/startup-b1-1.log");
    expect(text).toContain("Error: boom");
    expect(rollbackMessage({ buildId: "b1" })).not.toContain("Startup log");
  });
});

/**
 * Runs the real generated script with the macOS tools it calls stubbed out:
 * `open` plays the new build (claims the marker and writes to the startup log)
 * and then the old one (no marker, so it must not touch that log).
 */
describe("restart script run with stubbed system tools", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boop-restart-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(healthy: boolean) {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    mkdirSync(join(dir, "new", "Boop.app"), { recursive: true });
    mkdirSync(join(dir, "app", "Boop.app"), { recursive: true });
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    const marker = join(dir, "state", "startup-log-request");
    stub("sleep", "exit 0");
    stub("osascript", "exit 0");
    stub("pgrep", "exit 1");
    stub("lsof", "exit 1");
    stub("ditto", 'cp -R "$1" "$2"');
    stub("curl", healthy ? "exit 0" : "exit 7");
    stub(
      "open",
      `echo "$*" >> ${JSON.stringify(join(dir, "open-calls"))}
if [ -f ${JSON.stringify(marker)} ]; then
  target="$(cat ${JSON.stringify(marker)})"; rm -f ${JSON.stringify(marker)}
  echo "new build: Error: Cannot find module 'x'" >> "$target"
fi`,
    );
    const startupLog = join(dir, "state", "startup-b1-1.log");
    const script = join(dir, "restart.sh");
    writeFileSync(
      script,
      restartScript({
        buildId: "b1",
        newAppPath: join(dir, "new", "Boop.app"),
        appPath: join(dir, "app", "Boop.app"),
        backupDir: join(dir, "state", "previous"),
        resultPath: join(dir, "state", "pending-result.json"),
        healthUrl: "http://localhost:3456/health",
        logPath: join(dir, "state", "restart-b1.log"),
        startupLogPath: startupLog,
        startupMarkerPath: marker,
        healthTimeoutSec: 1,
      }),
    );
    execFileSync("/bin/bash", [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return {
      marker,
      startupLog: readFileSync(startupLog, "utf8"),
      result: JSON.parse(readFileSync(join(dir, "state", "pending-result.json"), "utf8")),
      opens: readFileSync(join(dir, "open-calls"), "utf8").trim().split("\n"),
    };
  }

  it("keeps the failed start's output through the rollback and reports where it is", () => {
    const { marker, startupLog, result, opens } = run(false);
    expect(opens).toHaveLength(2);
    expect(result).toMatchObject({ buildId: "b1", status: "rolled_back", healthTimeoutSec: 1 });
    expect(result.startupLog).toMatch(/startup-b1-1\.log$/);
    expect(startupLog).toContain("launching build b1");
    expect(startupLog).toContain("Cannot find module 'x'");
    expect(startupLog).toMatch(/health check timed out after \d+s \(limit 1s\), rolling back/);
    expect(existsSync(marker)).toBe(false);
  });

  it("ships as before when the new build answers, noting when health was ready", () => {
    const { marker, startupLog, result, opens } = run(true);
    expect(opens).toHaveLength(1);
    expect(result.status).toBe("shipped");
    expect(startupLog).toMatch(/\[phase\] health endpoint ready \+\d+s/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("reporting a rolled-back restart", () => {
  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), "boop-home-"));
    convexMock.query.mockReset();
    convexMock.mutation.mockReset();
    notifyMock.mockReset();
  });
  afterEach(() => rmSync(home.dir, { recursive: true, force: true }));

  it("texts the owner the log path and its last 50 lines, and stores them on the build", async () => {
    const state = join(home.dir, "Library", "Application Support", "Boop", "self-build");
    mkdirSync(state, { recursive: true });
    const logPath = join(state, "startup-b1-1.log");
    writeFileSync(logPath, Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    writeFileSync(
      join(state, "pending-result.json"),
      JSON.stringify({ buildId: "b1", status: "rolled_back", startupLog: logPath, healthTimeoutSec: 180 }),
    );
    convexMock.query.mockResolvedValue({ buildId: "b1", conversationId: "sms:+15550000000", request: "Add X" });

    await reportPendingRestart();

    const patch = convexMock.mutation.mock.calls[0][1];
    expect(patch).toMatchObject({ buildId: "b1", status: "rolled_back", startupLogPath: logPath });
    expect(patch.startupLogTail.split("\n")).toHaveLength(50);
    expect(patch.startupLogTail).toContain("line 80");
    expect(patch.startupLogTail).not.toContain("line 30\n");
    const text = notifyMock.mock.calls[0][1] as string;
    expect(text).toContain(logPath);
    expect(text).toContain("line 31");
    expect(text).toContain("line 80");
    expect(text).not.toMatch(/line 30\b/);
    expect(existsSync(logPath)).toBe(true);
  });

  it("keeps the success message unchanged", async () => {
    const state = join(home.dir, "Library", "Application Support", "Boop", "self-build");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "pending-result.json"), JSON.stringify({ buildId: "b1", status: "shipped" }));
    convexMock.query.mockResolvedValue({ buildId: "b1", conversationId: "debug", request: "Add X" });

    await reportPendingRestart();

    expect(convexMock.mutation.mock.calls[0][1]).toEqual({ buildId: "b1", status: "shipped" });
    expect(notifyMock).toHaveBeenCalledWith("debug", "I'm back, running build b1: Add X", "self_build");
  });

  it("shows the failed-start log in list_self_builds", async () => {
    // listSelfBuilds asks for recent builds, then the queue (empty here).
    convexMock.query
      .mockResolvedValueOnce([
        {
          buildId: "b2",
          status: "rolled_back",
          request: "Add Y",
          startupLogPath: "/logs/startup-b2-1.log",
          startupLogTail: "Error: boom",
        },
        { buildId: "b1", status: "shipped", request: "Add X" },
      ])
      .mockResolvedValueOnce([]);
    const out = await listSelfBuilds();
    expect(out).toContain("b2 · rolled_back · Add Y\n  failed-start log: /logs/startup-b2-1.log\nError: boom");
    expect(out).toContain("b1 · shipped · Add X");
    expect(out).not.toMatch(/b1[^\n]*\n  failed-start/);
  });
});
