import "./env-setup.js";
import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient, broadcast } from "./broadcast.js";
import { createSendblueRouter, inboundQueue, sendImessage } from "./sendblue.js";
import { startSendbluePoller } from "./sendblue-poller.js";
import { handleUserMessage } from "./interaction-agent.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { runCurator, startCuratorLoop } from "./skills/curator.js";
import { availableIntegrations, cancelAgent, retryAgent, runningAgentIds, spawnExecutionAgent } from "./execution-agent.js";
import { startAgentRetry } from "./agent-retry.js";
import { notifyConversation } from "./notify.js";
import { createOrchestratorBridgeRouter } from "./orchestrator-bridge.js";
import { completeWithRuntime } from "./orchestrator-llm.js";
import { runAgentRuntime } from "./runtimes/index.js";
import { orchestratorSidecar, SIDECAR_KEY_NAME } from "./orchestrator-sidecar.js";
import { createOrchestratorDashboardRouter } from "./orchestrator-dashboard.js";
import { createComposioRouter } from "./composio-routes.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { ensureSlackWatcher, sendSlackDigest, startSlackDigestLoop } from "./proactive-slack.js";
import { preloadLocalModel } from "./embeddings.js";
import { createMemoryRouter } from "./memory-routes.js";
import { createBrowserRouter } from "./browser-routes.js";
import { createAppleRouter } from "./apple-routes.js";
import { closeLocalBrowser } from "./browser/launcher.js";
import { createChangelogRouter } from "./changelog.js";
import { createSecretsRouter, type SecretsRouterDeps } from "./secrets/routes.js";
import { createSecretsPublicApp, secretsHostDispatcher, secretsPublicConfigFromEnv } from "./secrets/public-host.js";
import { secretStore, secretsSupported } from "./secrets/store.js";
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
import {
  cancelSelfBuild,
  catchUpWithPeers,
  installMissedUpdates,
  resumeSelfBuilds,
  retrySelfBuild,
  selfBuildBusy,
  startNextQueuedBuild,
  type CatchUpOptions,
} from "./self-build/run.js";
import { withOptionalArgs } from "./convex-compat.js";
import { execFileSync } from "node:child_process";
import { instanceIdentity, isActiveInstance, resolvePublicUrl, startInstanceCoordinator } from "./instance.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { networkHealth, probeNetwork } from "./network-health.js";
import { startReplyOutbox } from "./reply-outbox.js";
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
  // Load stored secret values into the redactor so logs and replies are
  // scrubbed from the first turn. Secrets only exist on the Mac.
  if (secretsSupported()) {
    secretStore()
      .refreshRedactor()
      .catch((err) => console.warn("[secrets] couldn't load the redactor", err instanceof Error ? err.message : err));
  }
  // Keep the Mac awake (caffeinate) while this copy is the active one. A no-op
  // off macOS. It only starts once the coordinator says this copy is active.
  const awake = keepAwake();
  startKeepAwakeSettingLoop(awake);
  // A self-build in progress also holds it, toggle or not, until it's done.
  startBuildWakeLockLoop(awake);

  // The Go orchestrator sidecar, run as a child of this process. Its planner
  // and merger call back to /orchestrator/complete (Boop's Claude runtime); an
  // optional ANTHROPIC_API_KEY override comes only from the secret store
  // (Keychain), never from Boop's env.
  const sidecar = orchestratorSidecar({
    getApiKey: async () => (secretsSupported() ? secretStore().get(SIDECAR_KEY_NAME) : null),
  });

  // What happens when a secret is saved from an entry link, on the Mac or on
  // the public secrets host.
  const secretsDeps: Pick<SecretsRouterDeps, "onChanged" | "onSaved"> = {
    onChanged: () => {
      broadcast("secrets_changed", {});
      // A newly saved ANTHROPIC_API_KEY restarts the sidecar with it.
      void sidecar.refreshKey().catch(() => undefined);
    },
    // Tell the owner it's done (name only), so the chat can pick up again.
    onSaved: async (request) => {
      const text = `🔐 Saved ${request.name} securely on your Mac. Tell me when you want me to carry on.`;
      if (!request.conversationId) return;
      if (request.conversationId.startsWith("sms:")) await sendImessage(request.conversationId.slice(4), text);
      await convex.mutation(api.messages.send, {
        conversationId: request.conversationId,
        role: "assistant",
        content: text,
      });
      broadcast("assistant_message", { conversationId: request.conversationId, content: text });
    },
  };

  const app = express();
  // The public secrets host (SECRETS_PUBLIC_BASE_URL): a request addressed to
  // it only ever reaches the secrets-only app, which 404s everything but the
  // entry pages. It runs before the access check below, which would otherwise
  // turn every tunnelled request into {"error":"not found"}.
  const secretsPublic = secretsPublicConfigFromEnv();
  if (!secretsPublic.ok && secretsPublic.reason) console.warn(`[secrets] remote entry off: ${secretsPublic.reason}`);
  if (secretsPublic.ok) {
    const secretsApp = createSecretsPublicApp({ config: secretsPublic.config, ...secretsDeps });
    console.log(`[secrets] remote entry served for ${secretsPublic.config.baseUrl}`);
    app.use(secretsHostDispatcher(secretsPublic.config, secretsApp));
    if (secretsPublic.config.port) {
      // Secrets-only listener for a tunnel; loopback so only the tunnel agent reaches it.
      createServer(secretsApp)
        .on("error", (err) => console.warn(`[secrets] couldn't listen on ${secretsPublic.config.port}: ${err.message}`))
        .listen(secretsPublic.config.port, "127.0.0.1");
    }
  }
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
  // Why this copy is (or isn't) flagged for a bad network, for the dashboard.
  app.get("/network", (_req, res) => {
    res.json({ ...networkHealth.status(), active: isActiveInstance() });
  });
  app.use(
    "/orchestrator",
    createOrchestratorBridgeRouter({
      spawn: spawnExecutionAgent,
      integrations: availableIntegrations,
      // The sidecar's planner, llm agent and merger run through Boop's own
      // runtime here, so they work without ANTHROPIC_API_KEY.
      complete: (req) =>
        completeWithRuntime(req, {
          runtimeConfig: getRuntimeConfig,
          run: runAgentRuntime,
          recordUsage: async ({ usage, config, durationMs }) => {
            if (usage.costUsd <= 0 && usage.inputTokens <= 0) return;
            await convex.mutation(api.usageRecords.record, {
              source: "orchestrator",
              runtime: config.runtime,
              billingMode: config.billingMode,
              model: usage.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheCreationTokens: usage.cacheCreationTokens,
              costUsd: usage.costUsd,
              durationMs,
            });
          },
        }),
    }),
  );
  // "Is the orchestrator working?" for the dashboard and curl, same as the tool.
  app.get("/orchestrator/sidecar", async (_req, res) => {
    await sidecar.checkHealth();
    res.json(sidecar.status());
  });
  // The dashboard's Orchestrator tab: health, log tail and runs in one call,
  // plus one run's plan graph. The browser never talks to the sidecar itself.
  app.use(
    "/orchestrator/dashboard",
    createOrchestratorDashboardRouter({ status: () => sidecar.status(), checkHealth: () => sidecar.checkHealth() }),
  );
  app.post("/orchestrator/sidecar/self-test", async (_req, res) => {
    const result = await sidecar.selfTest();
    res.json({ selfTest: result, status: sidecar.status() });
  });
  app.use("/secrets", createSecretsRouter(secretsDeps));

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

  // Starts the retry and answers with the new run's id right away; the answer
  // is texted to the original conversation when the run completes.
  app.post("/agents/:id/retry", async (req, res) => {
    const result = await startAgentRetry(req.params.id, {
      getAgent: (agentId) => convex.query(api.agents.get, { agentId }),
      retry: retryAgent,
      notify: (conversationId, text) => notifyConversation(conversationId, text, "agent_retried"),
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // Dashboard Retry / Cancel on a self-build. They act as the conversation the
  // build came from, so the owner check and the progress texts are the same as
  // asking Boop in chat.
  for (const action of ["retry", "cancel"] as const) {
    app.post(`/self-builds/:id/${action}`, async (req, res) => {
      const build = await convex.query(api.selfBuilds.get, { buildId: req.params.id });
      if (!build) {
        res.status(404).json({ error: "build not found" });
        return;
      }
      const run = action === "retry" ? retrySelfBuild : cancelSelfBuild;
      try {
        res.json({ message: await run({ conversationId: build.conversationId, buildId: build.buildId }) });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

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
  // The Mac installs what landed on main, but not while an execution agent is
  // working: the restart would cut it off, so the install waits for it.
  const catchUp: CatchUpOptions = { isBusy: () => runningAgentIds().length > 0 };
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
    void outbox.flush();
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
    // Moves memory embeddings to their own table (one-time, in batches on
    // Convex). After it has finished this is a single small read.
    void convex
      .mutation(api.memoryRecords.startEmbeddingMigration, {})
      .catch((err) => console.warn("[memory] embedding migration didn't start", err instanceof Error ? err.message : err));
    void (async () => {
      if (!resumedSelfBuilds) {
        resumedSelfBuilds = true;
        await resumeSelfBuilds({ startQueued: false });
      }
      if (!(await installMissedUpdates(catchUp))) await startNextQueuedBuild();
    })();
  };

  // Safety net for builds queued while this copy wasn't in charge (e.g. the
  // server took a request during a handover): the active copy looks for them
  // every minute. It's a no-op without a source checkout or while one builds.
  setInterval(() => {
    if (isActiveInstance()) void startNextQueuedBuild();
  }, 60_000).unref();

  // Replies that were written but couldn't be sent: the active copy resends
  // them every minute (and right after taking over).
  const outbox = startReplyOutbox({
    pending: () => convex.query(api.replyOutbox.pending, {}),
    send: async (toNumber, text) => {
      await sendImessage(toNumber, text);
    },
    remove: async (id) => {
      await convex.mutation(api.replyOutbox.remove, { id: id as Id<"replyOutbox"> });
    },
    noteAttempt: async (id, error) => {
      await convex.mutation(api.replyOutbox.noteAttempt, { id: id as Id<"replyOutbox">, error });
    },
    isActive: isActiveInstance,
  });

  // A server copy follows main, so builds shipped from the Mac reach it too.
  // It waits while it's answering, running an agent, or coding a build.
  startSelfUpdateLoop({
    isBusy: () => inboundQueue.isBusy() || runningAgentIds().length > 0 || selfBuildBusy(),
  });

  // A server cleans up its own builds a restart cut off right away, active or
  // not: they're marked with its id, so the Mac would never fail them, and
  // they'd hold up the queue. (The Mac does this on its first activation.)
  if (process.platform !== "darwin") {
    resumedSelfBuilds = true;
    void resumeSelfBuilds({ startQueued: false });
  }

  // A server reports the commit it runs with each check-in, so the Mac can
  // tell main moved on (a build shipped here) and install it.
  const runningCommit = process.platform === "darwin" ? undefined : gitHead();

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    // Work that must happen once, or costs tokens, runs only on the active
    // copy of Boop (the Mac first, a server while the Mac is offline).
    coordinator = startInstanceCoordinator({
      identity: { ...instanceIdentity(), ...(runningCommit ? { commit: runningCommit } : {}) },
      // Convex functions older than this code: check in without the commit
      // (remembered, so each check-in is still one call).
      checkIn: (identity) =>
        withOptionalArgs("instances.checkIn", (args) => convex.mutation(api.instances.checkIn, args), identity, ["commit"]),
      onSummary: (summary) => {
        if (process.platform === "darwin") void catchUpWithPeers(summary, catchUp);
      },
      leave: async (instanceId) => {
        await convex.mutation(api.instances.leave, { instanceId });
      },
      publicUrl: () => resolvePublicUrl(),
      // Flaky Wi-Fi: hand over to a healthier copy instead of losing replies.
      network: networkHealth,
      // While flagged, prove the network is good again: texts come in through
      // this copy's public URL (ngrok on the Mac), replies go out via
      // Sendblue, and turns need the model API.
      probe: async () => {
        const publicUrl = await resolvePublicUrl().catch(() => undefined);
        return probeNetwork([
          { name: "public url", url: publicUrl ? `${publicUrl}/health` : undefined },
          { name: "sendblue", url: "https://api.sendblue.com/" },
          { name: "model api", url: "https://api.anthropic.com/" },
        ]);
      },
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
    console.log(`  typing      POST http://localhost:${port}/sendblue/typing`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
    // Build (if needed) and start the Go orchestrator sidecar now that the
    // bridge it calls back into is listening. Non-fatal: start() never
    // throws, and without it Boop just runs without the orchestrator tools.
    void sidecar.start();
  });

  const signalExitCodes = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129 } as const;
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // Release the wake lock first so no caffeinate outlives this process.
      awake.stop();
      // Texts still in their quiet period are already saved as queued; they
      // are answered after the restart or by the copy that takes over.
      const waiting = inboundQueue.stop();
      if (waiting) console.log(`[inbound] ${waiting} conversation(s) left queued for the next start`);
      // Hand over to another copy right away instead of after a timeout.
      const leaving = coordinator?.stop() ?? Promise.resolve();
      Promise.allSettled([
        closeLocalBrowser(),
        sidecar.stop(),
        Promise.race([leaving, new Promise((r) => setTimeout(r, 3_000))]),
      ])
        .finally(() => process.exit(signalExitCodes[sig]));
    });
  }
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});

function gitHead(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}
