import "./env-setup.js";
import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { createSendblueRouter, inboundQueue } from "./sendblue.js";
import { startSendbluePoller } from "./sendblue-poller.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { runCurator, startCuratorLoop } from "./skills/curator.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { ensureSlackWatcher, sendSlackDigest, startSlackDigestLoop } from "./proactive-slack.js";
import { preloadLocalModel } from "./embeddings.js";
import { createMemoryRouter } from "./memory-routes.js";
import { createBrowserRouter } from "./browser-routes.js";
import { createAppleRouter } from "./apple-routes.js";
import { closeLocalBrowser } from "./browser/launcher.js";
import { createChangelogRouter } from "./changelog.js";
import {
  getRuntimeConfig,
  resolveModelInput,
  resolveReasoningEffortInput,
  resolveRuntimeInput,
  setCodexReasoningEffort,
  setRuntimeModel,
  setRuntimeProvider,
} from "./runtime-config.js";
import { startImageCleanup } from "./images/clean.js";
import { isPublicServerRequest, isTrustedLocalRequest } from "./local-access.js";
import { accessConfigFromEnv, isAccessAuthenticatedRequest } from "./cloudflare-access.js";
import { mountDashboard } from "./dashboard.js";
import { installMissedUpdates, resumeSelfBuilds, startNextQueuedBuild } from "./self-build/run.js";
import { instanceIdentity, resolvePublicUrl, startInstanceCoordinator } from "./instance.js";
import { startSelfUpdateLoop } from "./self-update.js";
import { keepAwake } from "./keep-awake.js";
import { createKeepAwakeRouter, startBuildWakeLockLoop, startKeepAwakeSettingLoop } from "./keep-awake-routes.js";
import {
  checkCswapLogin,
  getClaudeAccount,
  listCswapAccounts,
  switchCswapAccount,
} from "./claude-account.js";

async function main() {
  await loadIntegrations();
  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();
  startCuratorLoop();
  startSlackDigestLoop();
  startImageCleanup();
  // No-op when a paid embedding key is set; otherwise downloads/loads the
  // local BGE-large model in the background so the first user-facing
  // recall() doesn't pay the model-load cost.
  preloadLocalModel();
  // Keep the Mac awake (caffeinate) while this copy is the active one. A no-op
  // off macOS. It only starts once the coordinator says this copy is active.
  const awake = keepAwake();
  startKeepAwakeSettingLoop(awake);
  // A self-build in progress also holds it, toggle or not, until it's done.
  startBuildWakeLockLoop(awake);

  const app = express();
  // Behind Cloudflare Access (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD), a visitor
  // who passed its login is trusted like a local one, so the dashboard works
  // at the public URL. Everyone else only reaches /health and the webhooks.
  const accessConfig = accessConfigFromEnv();
  if (accessConfig) console.log(`[access] trusting Cloudflare Access logins from ${accessConfig.teamDomain}`);
  const isTrustedRequest = async (req: Parameters<typeof isTrustedLocalRequest>[0]) =>
    isTrustedLocalRequest(req) || (await isAccessAuthenticatedRequest(req, accessConfig));
  app.use((req, res, next) => {
    if (isPublicServerRequest(req)) {
      next();
      return;
    }
    isTrustedRequest(req)
      .then((trusted) => {
        if (trusted) next();
        else res.status(404).json({ error: "not found" });
      })
      .catch(next);
  });
  app.use(cors());
  // The dashboard calls the API under /api (the Vite dev server strips it on
  // the Mac); accept the same paths when Boop serves the dashboard itself.
  app.use((req, _res, next) => {
    if (req.url === "/api" || req.url.startsWith("/api/") || req.url.startsWith("/api?")) {
      req.url = req.url.slice(4) || "/";
    }
    next();
  });
  // Composio webhook receiver must read raw bytes for HMAC verification, so
  // its body parser is mounted BEFORE the global express.json. Without this
  // ordering the JSON parser consumes the stream first and the raw buffer
  // arrives empty.
  app.use("/composio/webhook", express.raw({ type: "application/json", limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "boop-agent" });
  });

  app.get("/runtime-config", async (_req, res) => {
    try {
      res.json(await getRuntimeConfig());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/claude-account", async (_req, res) => {
    const [account, cswap] = await Promise.allSettled([getClaudeAccount(), listCswapAccounts()]);
    res.json({
      account: account.status === "fulfilled" ? account.value : null,
      accountError: account.status === "rejected" ? String(account.reason) : null,
      cswap:
        cswap.status === "fulfilled"
          ? cswap.value
          : { available: false, activeAccountNumber: null, accounts: [] },
      cswapError: cswap.status === "rejected" ? String(cswap.reason) : null,
    });
  });

  app.post("/claude-account/check", async (req, res) => {
    const accountNumber = Number((req.body as { accountNumber?: unknown })?.accountNumber);
    if (!Number.isInteger(accountNumber) || accountNumber < 1) {
      res.status(400).json({ error: "accountNumber must be a positive integer" });
      return;
    }
    res.json(await checkCswapLogin(accountNumber));
  });

  app.post("/claude-account/switch", async (req, res) => {
    const accountNumber = Number((req.body as { accountNumber?: unknown })?.accountNumber);
    if (!Number.isInteger(accountNumber) || accountNumber < 1) {
      res.status(400).json({ error: "accountNumber must be a positive integer" });
      return;
    }
    try {
      res.json({ account: await switchCswapAccount(accountNumber) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/slack/digest", async (_req, res) => {
    try {
      res.json(await sendSlackDigest({ force: true }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/skills/curate", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { consolidate?: unknown };
      res.json(
        await runCurator({ force: true, consolidate: body.consolidate === true ? true : undefined }),
      );
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/runtime-config", async (req, res) => {
    try {
      const body = req.body as {
        runtime?: unknown;
        model?: unknown;
        reasoningEffort?: unknown;
      };
      let runtime =
        body.runtime === undefined
          ? undefined
          : resolveRuntimeInput(String(body.runtime));
      if (body.runtime !== undefined && !runtime) {
        res.status(400).json({ error: `Unknown runtime "${String(body.runtime)}"` });
        return;
      }

      if (runtime) {
        await setRuntimeProvider(runtime);
      }

      runtime ??= (await getRuntimeConfig()).runtime;

      if (body.model !== undefined) {
        const model = resolveModelInput(String(body.model), runtime);
        if (!model) {
          res
            .status(400)
            .json({ error: `Unknown ${runtime} model "${String(body.model)}"` });
          return;
        }
        await setRuntimeModel(model, runtime);
      }

      if (body.reasoningEffort !== undefined) {
        const effort = resolveReasoningEffortInput(String(body.reasoningEffort));
        if (!effort) {
          res.status(400).json({
            error: `Unknown Codex reasoning effort "${String(body.reasoningEffort)}"`,
          });
          return;
        }
        await setCodexReasoningEffort(effort);
      }

      res.json(await getRuntimeConfig());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.use("/sendblue", createSendblueRouter());
  app.use("/composio", createComposioRouter());
  app.use("/memory", createMemoryRouter());
  app.use("/browser", createBrowserRouter());
  app.use("/apple", createAppleRouter());
  app.use("/changelog", createChangelogRouter());
  app.use("/keep-awake", createKeepAwakeRouter(awake));

  app.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const reply = await handleUserMessage({
        conversationId,
        content,
        persistAssistantReply: true,
      });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/connection-config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ phoneNumber: process.env.SENDBLUE_FROM_NUMBER ?? "" });
  });

  mountDashboard(app);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, request) => {
    void isTrustedRequest(request).then((trusted) => {
      if (!trusted) {
        ws.close(1008, "local connections only");
        return;
      }
      addClient(ws);
      ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
    });
  });

  let coordinator: ReturnType<typeof startInstanceCoordinator> | null = null;
  let stopPoller: (() => void) | null = null;
  let resumedSelfBuilds = false;
  const onActivate = async (othersOnline: boolean) => {
    awake.setActiveCopy(true);
    // Texts a crash cut off are only re-answered when no other copy is up;
    // otherwise one stepping down may still be answering them.
    if (!othersOnline) {
      const { requeued, failed } = await inboundQueue
        .recover()
        .catch((err) => (console.error("[inbound] recovery failed", err), { requeued: 0, failed: 0 }));
      if (requeued || failed) console.log(`[inbound] after takeover: ${requeued} requeued, ${failed} given up`);
    } else {
      void inboundQueue.drainAll().catch((err) => console.error("[inbound] drain failed", err));
    }
    stopPoller ??= startSendbluePoller(inboundQueue);
    // Composio sends events to one address, so point it at this copy.
    const publicUrl = await resolvePublicUrl();
    if (publicUrl) {
      ensureProactiveWatcher(publicUrl).catch((err) => console.error("[proactive] startup failed", err));
      ensureSlackWatcher(publicUrl).catch((err) => console.error("[slack-watch] startup failed", err));
    }
    // Self-builds run on the Mac. Only the first activation after this
    // process started cleans up builds a restart interrupted; later ones
    // (e.g. waking from sleep) just start whatever was queued meanwhile.
    // When the Mac comes back online it also installs whatever landed on main
    // while it was off; queued builds wait until that restart is done.
    void (async () => {
      if (!resumedSelfBuilds) {
        resumedSelfBuilds = true;
        await resumeSelfBuilds({ startQueued: false });
      }
      if (!(await installMissedUpdates())) await startNextQueuedBuild();
    })();
  };

  // A server copy follows main, so builds shipped from the Mac reach it too.
  startSelfUpdateLoop({ isBusy: () => inboundQueue.isBusy() });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    // Work that must happen once, or costs tokens, runs only on the active
    // copy of Boop (the Mac first, a server while the Mac is offline).
    coordinator = startInstanceCoordinator({
      identity: instanceIdentity(),
      checkIn: (identity) => convex.mutation(api.instances.checkIn, identity),
      leave: async (instanceId) => {
        await convex.mutation(api.instances.leave, { instanceId });
      },
      publicUrl: () => resolvePublicUrl(),
      onActivate: ({ othersOnline }) => onActivate(othersOnline),
      onDeactivate: () => {
        // Standing by: let this machine sleep; the active copy keeps answering.
        awake.setActiveCopy(false);
        stopPoller?.();
        stopPoller = null;
      },
    });
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    console.log(`  sendblue    POST http://localhost:${port}/sendblue/webhook`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });

  const signalExitCodes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const;
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Release the wake lock first so no caffeinate outlives this process.
      awake.stop();
      // Hand over to another copy right away instead of after a timeout.
      const leaving = coordinator?.stop() ?? Promise.resolve();
      Promise.allSettled([closeLocalBrowser(), Promise.race([leaving, new Promise((r) => setTimeout(r, 3_000))])])
        .finally(() => process.exit(signalExitCodes[sig]));
    });
  }
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
