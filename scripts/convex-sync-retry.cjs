"use strict";
// Retry helpers for the Convex sync that runs when Boop starts.
//
// Right after the Mac wakes (or a self-build restarts the app) the network is
// often not up yet, and `convex dev` fails with "fetch failed" and exits 1.
// These helpers wait for connectivity and retry with backoff so a short outage
// never stops Boop from starting. Used by electron/main.cjs (the one-off
// `convex dev --once` before the server starts) and scripts/dev.mjs (the
// long-running `convex dev` watcher next to the server).
//
// CommonJS on purpose: the Electron main process requires it, and the ESM dev
// script imports it.

const DEFAULT_PROBE_URL = "https://api.convex.dev";

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff: baseMs, 2×, 4×, … capped at maxMs. `attempt` starts at 1. */
function backoffDelay(attempt, { baseMs = 2000, maxMs = 30_000, factor = 2 } = {}) {
  const n = Math.max(1, Math.floor(attempt) || 1);
  return Math.min(maxMs, baseMs * factor ** (n - 1));
}

/** True when the probe URL answers at all. Any HTTP status counts as online. */
async function isNetworkReachable({
  url = DEFAULT_PROBE_URL,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") return true;
  try {
    await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll `isOnline` until it says yes. Returns true once online, false when the
 * timeout passes or `shouldStop` says to give up. `onWaiting` fires once, the
 * first time the network is found to be down.
 */
async function waitForNetwork({
  isOnline = () => isNetworkReachable(),
  sleep = defaultSleep,
  now = Date.now,
  intervalMs = 2000,
  timeoutMs = Infinity,
  shouldStop = () => false,
  onWaiting = () => {},
} = {}) {
  const deadline = now() + timeoutMs;
  let announced = false;
  for (;;) {
    let online = false;
    try {
      online = await isOnline();
    } catch {
      online = false;
    }
    if (online) return true;
    if (!announced) {
      announced = true;
      onWaiting();
    }
    if (shouldStop() || now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Run `task` until it resolves, waiting for the network before each attempt
 * and backing off between failures, for at most `budgetMs`.
 *
 * Resolves to { ok: true, attempts } on success, or
 * { ok: false, attempts, error, stopped } once the budget is spent or
 * `shouldStop` returns true. Never throws.
 */
async function retryWithBackoff(task, options = {}) {
  const {
    budgetMs = 150_000,
    baseMs = 2000,
    maxMs = 30_000,
    networkPollMs = 2000,
    isOnline = () => isNetworkReachable(),
    sleep = defaultSleep,
    now = Date.now,
    shouldStop = () => false,
    onWaitingForNetwork = () => {},
    onAttemptFailed = () => {},
  } = options;
  const deadline = now() + budgetMs;
  let attempts = 0;
  let lastError;

  for (;;) {
    if (shouldStop()) return { ok: false, attempts, error: lastError, stopped: true };
    // If the network never comes back within the budget, still make one
    // attempt so the caller gets the real error.
    await waitForNetwork({
      isOnline,
      sleep,
      now,
      intervalMs: networkPollMs,
      timeoutMs: Math.max(0, deadline - now()),
      shouldStop,
      onWaiting: onWaitingForNetwork,
    });
    if (shouldStop()) return { ok: false, attempts, error: lastError, stopped: true };

    attempts += 1;
    try {
      await task(attempts);
      return { ok: true, attempts };
    } catch (error) {
      lastError = error;
    }
    if (shouldStop()) return { ok: false, attempts, error: lastError, stopped: true };

    const delay = backoffDelay(attempts, { baseMs, maxMs });
    if (now() + delay > deadline) {
      onAttemptFailed(lastError, attempts, null);
      return { ok: false, attempts, error: lastError, stopped: false };
    }
    onAttemptFailed(lastError, attempts, delay);
    await sleep(delay);
  }
}

/**
 * Keep a long-running child process (the `convex dev` watcher) alive: when it
 * exits with a non-zero code, wait with backoff, wait for the network, and
 * start a fresh one. The backoff resets once a child reports ready.
 *
 * `start()` returns a child that emits "exit" (code) and may carry a `ready`
 * promise. Returns `{ current() }` to get the live child (for shutdown).
 */
function restartOnFailure({
  start,
  isShuttingDown = () => false,
  isOnline = () => isNetworkReachable(),
  sleep = defaultSleep,
  log = () => {},
  baseMs = 2000,
  maxMs = 60_000,
  networkPollMs = 5000,
}) {
  let failures = 0;
  let child;

  const launch = () => {
    const launched = start();
    child = launched;
    if (launched.ready && typeof launched.ready.then === "function") {
      launched.ready.then(() => {
        if (child === launched) failures = 0;
      });
    }
    launched.on("exit", (code) => {
      if (child !== launched || isShuttingDown()) return;
      if (code === null || code === 0) return;
      failures += 1;
      const delay = backoffDelay(failures, { baseMs, maxMs });
      log(
        `Convex sync exited with code ${code}; the server keeps running. ` +
          `Retrying in ${Math.round(delay / 1000)}s (attempt ${failures + 1}).`,
      );
      void (async () => {
        await sleep(delay);
        if (isShuttingDown()) return;
        await waitForNetwork({
          isOnline,
          sleep,
          intervalMs: networkPollMs,
          shouldStop: isShuttingDown,
          onWaiting: () => log("Waiting for network connectivity before retrying Convex sync."),
        });
        if (isShuttingDown() || child !== launched) return;
        launch();
      })();
    });
    return launched;
  };

  launch();
  return { current: () => child };
}

module.exports = {
  DEFAULT_PROBE_URL,
  backoffDelay,
  isNetworkReachable,
  waitForNetwork,
  retryWithBackoff,
  restartOnFailure,
};
