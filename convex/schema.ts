import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    agentId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    mediaError: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_conversation_turn", ["conversationId", "turnId"])
    .index("by_createdAt", ["createdAt"]),

  // Replies Boop wrote but couldn't send (the network dropped). The active
  // copy resends them; a row is deleted once sent or given up on.
  replyOutbox: defineTable({
    conversationId: v.string(),
    toNumber: v.string(),
    content: v.string(),
    createdAt: v.number(),
    attempts: v.number(),
    lastError: v.optional(v.string()),
  }).index("by_createdAt", ["createdAt"]),

  conversations: defineTable({
    conversationId: v.string(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    messageCount: v.number(),
    lastActivityAt: v.number(),
  }).index("by_conversation", ["conversationId"]),

  memoryRecords: defineTable({
    memoryId: v.string(),
    content: v.string(),
    tier: v.union(v.literal("short"), v.literal("long"), v.literal("permanent")),
    segment: v.union(
      v.literal("identity"),
      v.literal("preference"),
      v.literal("correction"),
      v.literal("relationship"),
      v.literal("project"),
      v.literal("knowledge"),
      v.literal("context"),
    ),
    importance: v.number(),
    decayRate: v.number(),
    accessCount: v.number(),
    lastAccessedAt: v.number(),
    sourceTurn: v.optional(v.string()),
    lifecycle: v.union(v.literal("active"), v.literal("archived"), v.literal("pruned")),
    supersedes: v.optional(v.array(v.string())),
    // Legacy: embeddings now live in memoryEmbeddings. Kept optional until
    // every record has been migrated (memoryRecords.migrateEmbeddingsBatch).
    embedding: v.optional(v.array(v.float64())),
    // True once this memory's vector is stored in memoryEmbeddings.
    hasEmbedding: v.optional(v.boolean()),
    // Structured sidecar data (JSON blob). Currently used to carry
    // `corrects` text on correction-segment memories. Intentionally loose
    // so extraction prompts can stash provider-specific hints without
    // schema churn.
    metadata: v.optional(v.string()),
    createdAt: v.number(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
  })
    .index("by_memory_id", ["memoryId"])
    .index("by_tier", ["tier"])
    .index("by_segment", ["segment"])
    .index("by_lifecycle", ["lifecycle"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["lifecycle"],
    }),

  // One vector per memory, kept apart from memoryRecords so that reading a
  // memory (lists, counts, the dashboard) doesn't also read ~8 KB of floats.
  memoryEmbeddings: defineTable({
    memoryId: v.string(),
    memoryRecordId: v.id("memoryRecords"),
    // "live" for active real memories (the only ones recall searches), "demo"
    // for active demo memories, otherwise the memory's lifecycle.
    searchKey: v.string(),
    embedding: v.array(v.float64()),
  })
    .index("by_memory_id", ["memoryId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["searchKey"],
    }),

  // Precomputed dashboard numbers, refreshed at most every few minutes while
  // a dashboard is open, so viewers read one small record instead of
  // scanning messages, memories, agents and usage on every change.
  dashboardStats: defineTable({
    key: v.string(),
    payload: v.string(),
    computedAt: v.number(),
  }).index("by_key", ["key"]),

  executionAgents: defineTable({
    agentId: v.string(),
    conversationId: v.optional(v.string()),
    name: v.string(),
    task: v.string(),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    model: v.optional(v.string()),
    reasoningEffort: v.optional(v.string()),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    status: v.union(
      v.literal("spawned"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("paused"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    mcpServers: v.array(v.string()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.optional(v.number()),
    cacheCreationTokens: v.optional(v.number()),
    costUsd: v.number(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    // The run this one re-ran, when it was started with Retry.
    retryOf: v.optional(v.string()),
  })
    .index("by_agent_id", ["agentId"])
    .index("by_status", ["status"])
    .index("by_conversation", ["conversationId"]),

  // Append-only LLM usage log. Every model call (dispatcher, execution,
  // extract, consolidation) writes a row here so you can query total cost
  // by source, conversation, or time range.
  usageRecords: defineTable({
    source: v.union(
      v.literal("dispatcher"),
      v.literal("execution"),
      v.literal("extract"),
      v.literal("consolidation-proposer"),
      v.literal("consolidation-adversary"),
      v.literal("consolidation-judge"),
      v.literal("proactive"),
      v.literal("skill-review"),
      v.literal("self-build"),
      v.literal("skill-learn"),
      v.literal("skill-curator"),
      v.literal("slack-watch"),
      v.literal("orchestrator"),
    ),
    conversationId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    runId: v.optional(v.string()),
    // The self-build this usage belongs to.
    buildId: v.optional(v.string()),
    runtime: v.optional(v.union(v.literal("claude"), v.literal("codex"))),
    billingMode: v.optional(v.union(v.literal("api"), v.literal("codex-subscription"))),
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheReadTokens: v.number(),
    cacheCreationTokens: v.number(),
    costUsd: v.number(),
    durationMs: v.number(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_agent", ["agentId"])
    .index("by_source", ["source"]),

  agentLogs: defineTable({
    agentId: v.string(),
    logType: v.union(
      v.literal("thinking"),
      v.literal("tool_use"),
      v.literal("tool_result"),
      v.literal("text"),
      v.literal("error"),
    ),
    toolName: v.optional(v.string()),
    // Composio account aliases targeted by this tool call (e.g. ["gmail_charry-fusc"]).
    // Populated when the input names a specific connected account, so multi-account
    // toolkits make it visible which inbox / workspace was actually hit.
    accounts: v.optional(v.array(v.string())),
    content: v.string(),
    createdAt: v.number(),
  }).index("by_agent", ["agentId"]),

  memoryEvents: defineTable({
    eventType: v.string(),
    conversationId: v.optional(v.string()),
    memoryId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    data: v.string(),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_type", ["eventType"]),

  automations: defineTable({
    automationId: v.string(),
    name: v.string(),
    task: v.string(),
    integrations: v.array(v.string()),
    schedule: v.string(),
    // IANA timezone the cron expression is evaluated in. Stored at create
    // time so changing the user's global timezone later doesn't shift
    // existing automations. Optional for backwards compatibility — pre-TZ
    // automations fall back to the user's current setting at run time.
    timezone: v.optional(v.string()),
    enabled: v.boolean(),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    nextRunAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_automation_id", ["automationId"])
    .index("by_enabled", ["enabled"]),

  sendblueDedup: defineTable({
    handle: v.string(),
    claimedAt: v.number(),
  }).index("by_handle", ["handle"]),

  // Each running copy of Boop (the owner's Mac, a Linux server) checks in here
  // every few seconds. The online copy with the highest priority is the
  // active one: it answers texts and runs automations; the others stand by.
  instances: defineTable({
    instanceId: v.string(),
    label: v.string(),
    platform: v.string(),
    priority: v.number(),
    publicUrl: v.optional(v.string()),
    // The git commit a server copy runs, so the Mac can tell, from its
    // regular check-in, that main moved on and install it.
    commit: v.optional(v.string()),
    startedAt: v.number(),
    lastSeenAt: v.number(),
  }).index("by_instanceId", ["instanceId"]),

  // Every inbound iMessage, saved before Boop answers it. Each conversation's
  // texts are handled one at a time, oldest first. Rows come from the Sendblue
  // webhook or from the poller that catches texts the webhook never delivered.
  inboundMessages: defineTable({
    handle: v.string(),
    conversationId: v.string(),
    fromNumber: v.string(),
    content: v.string(),
    mediaUrls: v.array(v.string()),
    source: v.union(v.literal("webhook"), v.literal("poll")),
    status: v.union(
      v.literal("queued"),
      v.literal("processing"),
      v.literal("done"),
      v.literal("failed"),
      // Dropped by a "never mind" sent while it was still waiting.
      v.literal("cancelled"),
    ),
    attempts: v.number(),
    error: v.optional(v.string()),
    receivedAt: v.number(),
    enqueuedAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_handle", ["handle"])
    .index("by_status_and_enqueuedAt", ["status", "enqueuedAt"])
    .index("by_conversationId_and_status_and_enqueuedAt", ["conversationId", "status", "enqueuedAt"]),

  drafts: defineTable({
    draftId: v.string(),
    conversationId: v.string(),
    kind: v.string(),
    summary: v.string(),
    payload: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("rejected"),
      v.literal("expired"),
    ),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_draft_id", ["draftId"])
    .index("by_conversation_status", ["conversationId", "status"]),

  consolidationRuns: defineTable({
    runId: v.string(),
    trigger: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    proposalsCount: v.number(),
    mergedCount: v.number(),
    prunedCount: v.number(),
    notes: v.optional(v.string()),
    // JSON blob: { proposals: [...], decisions: [...], applied: [...] }
    // Captured so you can inspect the reasoning for any historical run.
    details: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_run_id", ["runId"])
    .index("by_status", ["status"]),

  // Runtime overrides for things normally pinned by env vars (e.g. the Claude
  // model). Lets the user say "use opus" via iMessage and have the next agent
  // run respect it without a redeploy.
  // Slack mentions and DMs Boop has seen, for urgent texts and the digest.
  slackMentions: defineTable({
    key: v.string(),
    channel: v.string(),
    ts: v.string(),
    threadTs: v.optional(v.string()),
    kind: v.union(v.literal("dm"), v.literal("mention")),
    sender: v.string(),
    channelName: v.optional(v.string()),
    text: v.string(),
    summary: v.string(),
    permalink: v.string(),
    urgent: v.boolean(),
    notifiedAt: v.optional(v.number()),
    answeredAt: v.optional(v.number()),
    digestedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_channel", ["channel"])
    .index("by_created", ["createdAt"]),

  settings: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  automationRuns: defineTable({
    runId: v.string(),
    automationId: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    agentId: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_automation", ["automationId"])
    .index("by_run_id", ["runId"]),

  // Procedural memory: how to do a class of task, written and refined by Boop.
  skills: defineTable({
    name: v.string(),
    description: v.string(),
    body: v.string(),
    status: v.union(v.literal("active"), v.literal("archived")),
    pinned: v.boolean(),
    // Set by the curator when a skill hasn't been used for a while.
    stale: v.optional(v.boolean()),
    createdBy: v.union(v.literal("agent"), v.literal("user")),
    viewCount: v.number(),
    patchCount: v.number(),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_status", ["status"]),

  skillRevisions: defineTable({
    name: v.string(),
    action: v.union(
      v.literal("create"),
      v.literal("patch"),
      v.literal("rewrite"),
      v.literal("archive"),
      v.literal("restore"),
    ),
    description: v.string(),
    body: v.string(),
    reason: v.optional(v.string()),
    origin: v.union(
      v.literal("execution"),
      v.literal("review"),
      v.literal("correction"),
      v.literal("user"),
      v.literal("learn"),
      v.literal("curator"),
    ),
    agentId: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_name", ["name", "createdAt"]),

  // Agent skill edits waiting for the user, when "approve skill changes" is on.
  skillPendingChanges: defineTable({
    name: v.string(),
    action: v.union(v.literal("create"), v.literal("patch"), v.literal("rewrite")),
    description: v.string(),
    body: v.string(),
    previousBody: v.optional(v.string()),
    previousDescription: v.optional(v.string()),
    reason: v.optional(v.string()),
    origin: v.union(
      v.literal("execution"),
      v.literal("review"),
      v.literal("correction"),
      v.literal("user"),
      v.literal("learn"),
      v.literal("curator"),
    ),
    agentId: v.optional(v.string()),
    // One agent run's edits to a skill stack into a single pending change.
    batchId: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  }).index("by_status", ["status", "createdAt"]),

  // Read-only history imported from other memory stores (claude-mem today):
  // observations, session summaries and prompts from past coding sessions.
  // Kept apart from memoryRecords so tens of thousands of rows never reach
  // recall's decay, consolidation or the dashboard, and searched by keyword.
  archiveRecords: defineTable({
    // Stable id from the source, e.g. "claude-mem:observation:123". Upserts
    // key on it, so a re-run never duplicates a record.
    sourceId: v.string(),
    source: v.string(),
    kind: v.string(),
    project: v.string(),
    title: v.string(),
    content: v.string(),
    // Source-side subtype, such as an observation's "bugfix" or "decision".
    type: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    // When it happened in the source, not when it was imported.
    occurredAt: v.number(),
    // Hash of everything above; an unchanged record is skipped on re-import.
    contentHash: v.string(),
    importedAt: v.number(),
  })
    .index("by_source_id", ["sourceId"])
    .index("by_occurred_at", ["occurredAt"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["kind", "project", "source"],
    }),

  // Running row counts for archiveRecords, one per "source:kind", so the
  // totals can be read without scanning the whole table.
  archiveCounts: defineTable({
    key: v.string(),
    count: v.number(),
  }).index("by_key", ["key"]),

  // Features Boop builds into its own code when the owner asks over iMessage.
  selfBuilds: defineTable({
    buildId: v.string(),
    conversationId: v.string(),
    request: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("coding"),
      v.literal("testing"),
      v.literal("pr_open"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("shipping"),
      v.literal("restarting"),
      v.literal("shipped"),
      v.literal("rolled_back"),
    ),
    branch: v.optional(v.string()),
    worktreePath: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    summary: v.optional(v.string()),
    testsPassed: v.optional(v.boolean()),
    testOutput: v.optional(v.string()),
    error: v.optional(v.string()),
    // Failed-start diagnostics kept when a restart rolls back.
    startupLogPath: v.optional(v.string()),
    startupLogTail: v.optional(v.string()),
    // Newest lines of what the build is doing, for the dashboard.
    activity: v.optional(v.string()),
    // The build this one re-runs, when it was started with Retry.
    retryOf: v.optional(v.string()),
    // Which copy of Boop (instances.instanceId) is coding or shipping it, so
    // a restart only fails the builds it actually cut off. Older rows have
    // none; those ran on the Mac.
    runner: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_buildId", ["buildId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"]),
});
