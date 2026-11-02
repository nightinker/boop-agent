import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OrchestratorClient,
  orchestratorAvailable,
  resetOrchestratorProbe,
  type RunResultResponse,
} from "../server/orchestrator-client.js";
import {
  OrchestratorSidecar,
  checkSelfTestResult,
  findGo,
  formatSidecarStatus,
  hashGoSources,
  needsBuild,
  restartDelayMs,
  selfTestPlan,
  sidecarEnv,
  type SidecarOptions,
} from "../server/orchestrator-sidecar.js";
import { createOrchestratorHealthTool, ORCHESTRATOR_HEALTH_TOOL } from "../server/orchestrator-tools.js";

const FAKE_KEY = "sk-ant-test-NOT-A-REAL-KEY-0123456789";

let dirs: string[] = [];
function tmp(prefix = "boop-sidecar-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function goSource(): string {
  const d = tmp("boop-sidecar-src-");
  writeFileSync(join(d, "go.mod"), "module x\n\ngo 1.22\n");
  mkdirSync(join(d, "cmd", "orchestrator"), { recursive: true });
  writeFileSync(join(d, "cmd", "orchestrator", "main.go"), "package main\nfunc main() {}\n");
  return d;
}

beforeEach(() => resetOrchestratorProbe());
afterEach(() => {
  resetOrchestratorProbe();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("sidecar helpers", () => {
  it("backs off 1s, 2s, 4s … up to 60s", () => {
    expect([1, 2, 3, 4, 7, 20].map(restartDelayMs)).toEqual([1000, 2000, 4000, 8000, 60000, 60000]);
  });

  it("gives the child a minimal env: the stored key, never Boop's own secrets", () => {
    const base = { PATH: "/usr/bin", HOME: "/Users/x", ANTHROPIC_API_KEY: "from-boop-env", CONVEX_DEPLOY_KEY: "c", SENDBLUE_API_SECRET: "s", ORCHESTRATOR_TOKEN: "t" };
    const without = sidecarEnv({ addr: "127.0.0.1:3460", boopUrl: "http://127.0.0.1:3456", base });
    expect(without).toEqual({ PATH: "/usr/bin", HOME: "/Users/x", ORCHESTRATOR_TOKEN: "t", ORCHESTRATOR_ADDR: "127.0.0.1:3460", BOOP_URL: "http://127.0.0.1:3456" });
    const withKey = sidecarEnv({ addr: "127.0.0.1:3460", boopUrl: "http://127.0.0.1:3456", base, apiKey: FAKE_KEY });
    expect(withKey.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(withKey.CONVEX_DEPLOY_KEY).toBeUndefined();
  });

  it("finds go on PATH, then the usual install places, or honours GO_BIN", () => {
    const has = (set: string[]) => (f: string) => set.includes(f);
    expect(findGo({ PATH: "/a:/b", HOME: "/h" }, has(["/b/go"]))).toBe("/b/go");
    expect(findGo({ PATH: "/a", HOME: "/h" }, has(["/usr/local/go/bin/go"]))).toBe("/usr/local/go/bin/go");
    expect(findGo({ PATH: "/a", HOME: "/h" }, has([]))).toBeNull();
    expect(findGo({ PATH: "/b", GO_BIN: "/custom/go", HOME: "/h" }, has(["/b/go"]))).toBeNull();
  });

  it("rebuilds when the Go source changes, not for test files", async () => {
    const src = goSource();
    const h1 = await hashGoSources(src);
    writeFileSync(join(src, "cmd", "orchestrator", "main_test.go"), "package main\n");
    expect(await hashGoSources(src)).toBe(h1);
    writeFileSync(join(src, "cmd", "orchestrator", "main.go"), "package main\nfunc main() { println() }\n");
    const h2 = await hashGoSources(src);
    expect(h2).not.toBe(h1);

    const bin = join(tmp(), "orchestrator");
    const stamp = `${bin}.stamp.json`;
    expect(await needsBuild(bin, stamp, h2)).toBe(true); // no binary
    writeFileSync(bin, "");
    expect(await needsBuild(bin, stamp, h2)).toBe(true); // no stamp
    writeFileSync(stamp, JSON.stringify({ hash: h1 }));
    expect(await needsBuild(bin, stamp, h2)).toBe(true); // stale
    writeFileSync(stamp, JSON.stringify({ hash: h2 }));
    expect(await needsBuild(bin, stamp, h2)).toBe(false);
  });

  it("passes a self-test only when a merged answer keeps both steps", () => {
    const { plan, urls } = selfTestPlan("abc");
    expect((plan.tasks as unknown[]).length).toBe(2);
    const base: RunResultResponse = { id: "run_0123456789abcdef", state: "SUCCEEDED", done: true, tokens_used: 2, token_budget: 20000 };
    expect(checkSelfTestResult({ ...base, result: { answer: `A ${urls[0]}\nB ${urls[1]}`, method: "fallback" } }, urls).ok).toBe(true);
    expect(checkSelfTestResult({ ...base, result: { answer: "both fine", method: "llm", sources: urls } }, urls).ok).toBe(true);
    expect(checkSelfTestResult({ ...base, result: { answer: `A ${urls[0]}`, method: "llm" } }, urls)).toMatchObject({ ok: false });
    expect(checkSelfTestResult({ ...base, state: "FAILED", error: "boom" }, urls).detail).toContain("FAILED");
    expect(checkSelfTestResult({ ...base, done: false, state: "MERGING" }, urls).ok).toBe(false);
  });
});

// ---- the supervisor, with a fake child process and client ---------------------

class FakeChild extends EventEmitter {
  static nextPid = 40_000;
  pid = FakeChild.nextPid++;
  signals: string[] = [];
  exitOnTerm = true;
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(sig);
    if (sig === "SIGKILL" || this.exitOnTerm) setImmediate(() => this.emit("exit", null, sig));
    return true;
  }
}

interface Harness {
  sidecar: OrchestratorSidecar;
  children: FakeChild[];
  envs: NodeJS.ProcessEnv[];
  logs: string[];
  builds: number;
  up: { value: boolean };
  key: { value: string | null };
}

function harness(over: Partial<SidecarOptions> & { goMissing?: boolean; buildFails?: boolean } = {}): Harness {
  const h: Harness = { children: [], envs: [], logs: [], builds: 0, up: { value: false }, key: { value: null } } as unknown as Harness;
  const client = {
    baseUrl: "http://127.0.0.1:3460",
    health: async () => {
      if (!h.up.value) throw new Error("connection refused");
      return { ok: true, planner: h.envs.at(-1)?.ANTHROPIC_API_KEY !== undefined };
    },
  } as unknown as OrchestratorClient;
  h.sidecar = new OrchestratorSidecar({
    sourceDir: goSource(),
    stateDir: tmp(),
    env: { PATH: "/usr/bin", HOME: "/h", ANTHROPIC_API_KEY: "from-boop-env-must-not-be-used" },
    client,
    log: (m) => h.logs.push(m),
    getApiKey: async () => h.key.value,
    findGo: () => (over.goMissing ? null : "/fake/go"),
    build: async (_go, args) => {
      h.builds++;
      if (over.buildFails) return { ok: false, output: "main.go:1: syntax error" };
      writeFileSync(args[3], "#!/bin/sh\n");
      return { ok: true, output: "" };
    },
    spawn: ((_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const c = new FakeChild();
      h.children.push(c);
      h.envs.push(opts.env);
      setImmediate(() => {
        h.up.value = true;
      });
      c.on("exit", () => {
        h.up.value = false;
      });
      return c as unknown as ChildProcess;
    }) as SidecarOptions["spawn"],
    processCommand: async () => null,
    healthIntervalMs: 20,
    startTimeoutMs: 2_000,
    stopTimeoutMs: 200,
    ...over,
  });
  return h;
}

describe("orchestrator sidecar supervisor", () => {
  it("boots normally when Go is missing: no throw, tools off, a clear log line", async () => {
    const h = harness({ goMissing: true });
    await expect(h.sidecar.start()).resolves.toBeUndefined();
    expect(h.sidecar.status().state).toBe("failed");
    expect(h.logs.join("\n")).toMatch(/Go isn't installed.*continues without the orchestrator tools/);
    expect(h.children).toHaveLength(0);
    expect(await orchestratorAvailable({ health: async () => ({ ok: true, planner: false }) } as unknown as OrchestratorClient)).toBe(false);
    await h.sidecar.stop();
  });

  it("boots normally when the build fails", async () => {
    const h = harness({ buildFails: true });
    await h.sidecar.start();
    const st = h.sidecar.status();
    expect(st.state).toBe("failed");
    expect(st.problem).toContain("syntax error");
    expect(readFileSync(st.logFile, "utf8")).toContain("go build FAILED");
    await h.sidecar.stop();
  });

  it("builds once, starts with the Keychain key (not Boop's env), and turns the tools on", async () => {
    const h = harness();
    h.key.value = FAKE_KEY;
    await h.sidecar.start();
    expect(h.builds).toBe(1);
    expect(h.children).toHaveLength(1);
    expect(h.envs[0].ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(h.envs[0].ORCHESTRATOR_ADDR).toBe("127.0.0.1:3460");
    const st = h.sidecar.status();
    expect(st).toMatchObject({ state: "running", managed: true, port: 3460, keyPresent: true, keyPassed: true });
    expect(await orchestratorAvailable()).toBe(true);
    // The key value never reaches logs, status or the owner-facing text.
    const everything = [...h.logs, JSON.stringify(st), formatSidecarStatus(st), readFileSync(st.logFile, "utf8")].join("\n");
    expect(everything).not.toContain(FAKE_KEY);
    await h.sidecar.stop();

    // Second boot with the same source: no rebuild.
    const again = new OrchestratorSidecar({ ...(h.sidecar as unknown as { opts: SidecarOptions }).opts });
    await again.start();
    expect(h.builds).toBe(1);
    await again.stop();
  });

  it("starts without the key when it isn't stored and says it needs request_secret", async () => {
    const h = harness();
    await h.sidecar.start();
    expect(h.envs[0].ANTHROPIC_API_KEY).toBeUndefined();
    expect(h.logs.join("\n")).toContain('request_secret("ANTHROPIC_API_KEY")');
    const text = formatSidecarStatus(h.sidecar.status());
    expect(text).toContain("running");
    expect(text).toContain("not stored");
    expect(text).toContain("request_secret");
    await h.sidecar.stop();
  });

  it("restarts a sidecar that dies (tools off meanwhile) and stops cleanly", async () => {
    const h = harness();
    await h.sidecar.start();
    h.children[0].emit("exit", 2, null);
    await vi.waitFor(() => expect(h.sidecar.status().state).toBe("restarting"));
    expect(await orchestratorAvailable()).toBe(false);
    await vi.waitFor(() => expect(h.children).toHaveLength(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(h.sidecar.status().state).toBe("running"));
    expect(h.sidecar.status().restarts).toBe(1);
    expect(await orchestratorAvailable()).toBe(true);

    await h.sidecar.stop();
    expect(h.children[1].signals).toEqual(["SIGTERM"]);
    expect(h.sidecar.status().state).toBe("stopped");
    expect(await orchestratorAvailable()).toBe(false);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(h.children).toHaveLength(2); // no restart after a deliberate stop
  });

  it("kills a sidecar that ignores SIGTERM on shutdown", async () => {
    const h = harness();
    await h.sidecar.start();
    h.children[0].exitOnTerm = false;
    await h.sidecar.stop();
    expect(h.children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("restarts with the key once it's saved to the secret store", async () => {
    const h = harness();
    await h.sidecar.start();
    expect(h.sidecar.status().keyPresent).toBe(false);
    await h.sidecar.refreshKey(); // unchanged: no restart
    expect(h.children).toHaveLength(1);
    h.key.value = FAKE_KEY;
    await h.sidecar.refreshKey();
    expect(h.children).toHaveLength(2);
    expect(h.envs[1].ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(h.sidecar.status()).toMatchObject({ state: "running", keyPresent: true, keyPassed: true, restarts: 0 });
    expect(h.logs.join("\n")).not.toContain(FAKE_KEY);
    await h.sidecar.stop();
  });

  it("uses a sidecar that's already answering instead of starting a second one", async () => {
    const h = harness();
    h.up.value = true;
    await h.sidecar.start();
    expect(h.children).toHaveLength(0);
    expect(h.sidecar.status()).toMatchObject({ state: "external", managed: false });
    expect(await orchestratorAvailable()).toBe(true);
    await h.sidecar.stop();
  });

  it("exposes status and the self-test through the orchestrator_health tool", async () => {
    expect(ORCHESTRATOR_HEALTH_TOOL).toBe("mcp__boop-orchestrator__orchestrator_health");
    const h = harness({ goMissing: true });
    await h.sidecar.start();
    const tool = createOrchestratorHealthTool({ sidecar: () => h.sidecar });
    const out = await tool.handle({ selfTest: true });
    const text = JSON.stringify(out);
    expect(text).toContain("NOT running");
    expect(text).toContain("port 3460");
    expect(text).toContain("Last self-test");
    expect(text).toContain("Go isn't installed");
    await h.sidecar.stop();
  });
});

// ---- for real: go build, start, self-test, stop --------------------------------

function hasGo(): boolean {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe.skipIf(!hasGo())("orchestrator sidecar for real", () => {
  it("builds the binary, runs it, passes the self-test and stops it", async () => {
    const port = await freePort();
    const logs: string[] = [];
    const stateDir = tmp();
    const sidecar = new OrchestratorSidecar({
      sourceDir: join(process.cwd(), "orchestrator-go"),
      stateDir,
      url: `http://127.0.0.1:${port}`,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      getApiKey: async () => null, // no key: the merge falls back to joining, no model call
      log: (m) => logs.push(m),
      healthIntervalMs: 500,
    });
    try {
      await sidecar.start();
      const st = sidecar.status();
      expect(st.state, logs.join("\n")).toBe("running");
      expect(existsSync(st.binary)).toBe(true);
      expect(st.lastHealth).toMatchObject({ ok: true, planner: false });

      const test = await sidecar.selfTest({ maxWaitMs: 20_000 });
      expect(test.ok, test.detail).toBe(true);
      expect(test.method).toBe("fallback");
      expect(formatSidecarStatus(sidecar.status())).toContain("Last self-test: 0s ago, passed");

      const pid = st.pid!;
      await sidecar.stop();
      expect(() => process.kill(pid, 0)).toThrow();
      expect(readFileSync(st.logFile, "utf8")).toContain("orchestrator listening on");
    } finally {
      await sidecar.stop();
    }
  }, 180_000);
});

describe("the Mac app's runtime copy", () => {
  it("ships the Go source so the packaged Boop can build the sidecar", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { build: { files: string[] } };
    expect(pkg.build.files).toContain("orchestrator-go/**");
    for (const file of ["electron/main.cjs", "scripts/desktop-setup.mjs"]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      const items = src.match(/const runtimeItems = \[([\s\S]*?)\];/)?.[1] ?? "";
      expect(items, file).toContain('"orchestrator-go"');
      // data/ (where the binary and log live) stays mutable, so syncs don't delete them.
      expect(src.match(/const mutableRuntimeItems = \[([\s\S]*?)\];/)?.[1] ?? "", file).toContain('"data"');
    }
  });
});
