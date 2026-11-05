#!/usr/bin/env node
// Runs test/mcp-tools.test.ts against a throwaway local anonymous Convex
// backend. Refuses to run where .env.local points at a real deployment, since
// `convex dev` rewrites that file.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = resolve(root, ".env.local");

function readEnv() {
  if (!existsSync(envFile)) return {};
  return Object.fromEntries(
    readFileSync(envFile, "utf8")
      .split("\n")
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
}

const deployment = readEnv().CONVEX_DEPLOYMENT;
if (deployment && !deployment.startsWith("anonymous:")) {
  console.error(
    "mcp-test: .env.local points at a real Convex deployment. Run this from a clean git worktree (no .env.local) so `convex dev` cannot touch it.",
  );
  process.exit(1);
}

const convex = spawn("npx", ["convex", "dev", "--typecheck=disable"], {
  cwd: root,
  env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
  stdio: ["ignore", "pipe", "inherit"],
});

const stop = () => convex.kill("SIGTERM");
process.on("exit", stop);

convex.stdout.on("data", (chunk) => process.stdout.write(chunk));
const exited = new Promise((_, reject) =>
  convex.on("exit", (code) => reject(new Error(`convex dev exited early (${code})`))),
);

// `convex dev` prints nothing useful without a TTY, so wait until the local
// backend answers a pushed function instead of parsing its output.
async function waitForFunctions() {
  const { ConvexHttpClient } = await import("convex/browser");
  const { anyApi } = await import("convex/server");
  for (let i = 0; i < 120; i++) {
    const url = readEnv().VITE_CONVEX_URL;
    if (url) {
      try {
        await new ConvexHttpClient(url).query(anyApi.conversations.list, {});
        return;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("local Convex backend never became ready");
}
const ready = Promise.race([waitForFunctions(), exited]);

try {
  await ready;
  const url = readEnv().VITE_CONVEX_URL;
  const local = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url ?? "");
  if (!local) throw new Error(`refusing to test against non-local URL: ${url}`);
  const vitest = spawn("npx", ["vitest", "run", "test/mcp-tools.test.ts"], {
    cwd: root,
    env: { ...process.env, BOOP_MCP_TEST_CONVEX_URL: url },
    stdio: "inherit",
  });
  const code = await new Promise((r) => vitest.on("exit", r));
  stop();
  process.exit(code ?? 1);
} catch (err) {
  console.error(String(err));
  stop();
  process.exit(1);
}
