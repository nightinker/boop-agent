import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getKeepAwakeEnabled, setKeepAwakeEnabled } from "./runtime-config.js";
import { KEEP_AWAKE_UNSUPPORTED_MESSAGE, type KeepAwakeController } from "./keep-awake.js";
import { activeBuildIds } from "./keep-awake-labels.js";

// The setting lives in Convex and can change from another copy's dashboard,
// so re-read it now and then; the dashboard toggle applies at once anyway.
const SETTING_REFRESH_MS = 30_000;

export async function refreshKeepAwakeSetting(controller: KeepAwakeController): Promise<void> {
  controller.setEnabled(await getKeepAwakeEnabled());
}

export function startKeepAwakeSettingLoop(controller: KeepAwakeController): () => void {
  const refresh = () =>
    refreshKeepAwakeSetting(controller).catch((err) =>
      console.warn("[keep-awake] reading the setting failed", err instanceof Error ? err.message : err),
    );
  void refresh();
  const timer = setInterval(() => void refresh(), SETTING_REFRESH_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Self-builds hold the wake lock while they're in progress. Status changes made
// by this process re-check at once (syncBuildWakeLock); the poll catches the
// rest (another copy queueing a build, a restart marking builds failed).
const BUILD_REFRESH_MS = 15_000;

export type BuildLister = () => Promise<{ buildId: string; status: string; createdAt?: number }[]>;

// Only queued and running builds, without their text, so the 15s poll reads
// a few small rows instead of the last 20 builds in full.
const listBuilds: BuildLister = () => convex.query(api.selfBuilds.inProgress, {});

/**
 * Returns a function that reads the builds in progress and hands them to the
 * controller. Overlapping calls are fine: only the newest answer is applied.
 * If the read fails the previous builds stay, so a Convex blip doesn't let the
 * Mac sleep mid-build.
 */
export function createBuildWakeLockSync(
  controller: KeepAwakeController,
  list: BuildLister = listBuilds,
): () => Promise<void> {
  let latest = 0;
  return async () => {
    if (!controller.status().supported) return;
    const seq = ++latest;
    const builds = await list();
    if (seq !== latest) return;
    controller.setBuilds(activeBuildIds(builds));
  };
}

let syncBuilds: (() => Promise<void>) | null = null;

/** Re-checks the builds in progress now. A no-op until startBuildWakeLockLoop runs. */
export function syncBuildWakeLock(): void {
  syncBuilds?.().catch((err) =>
    console.warn("[keep-awake] reading self-builds failed", err instanceof Error ? err.message : err),
  );
}

export function startBuildWakeLockLoop(
  controller: KeepAwakeController,
  list: BuildLister = listBuilds,
): () => void {
  // Nothing to hold off macOS (e.g. the Linux server copy), so don't poll.
  if (!controller.status().supported) return () => undefined;
  syncBuilds = createBuildWakeLockSync(controller, list);
  syncBuildWakeLock();
  const timer = setInterval(syncBuildWakeLock, BUILD_REFRESH_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    syncBuilds = null;
  };
}

export function createKeepAwakeRouter(controller: KeepAwakeController): express.Router {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(controller.status());
  });

  router.post("/", async (req, res) => {
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be true or false" });
      return;
    }
    if (!controller.status().supported) {
      res.status(409).json({ ...controller.status(), error: KEEP_AWAKE_UNSUPPORTED_MESSAGE });
      return;
    }
    try {
      await setKeepAwakeEnabled(enabled);
      controller.setEnabled(enabled);
      res.json(controller.status());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
