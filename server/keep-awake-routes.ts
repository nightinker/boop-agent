import express from "express";
import { getKeepAwakeEnabled, setKeepAwakeEnabled } from "./runtime-config.js";
import { KEEP_AWAKE_UNSUPPORTED_MESSAGE, type KeepAwakeController } from "./keep-awake.js";

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
