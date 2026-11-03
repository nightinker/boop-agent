import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { scanForSecrets } from "../secrets/redact.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { DEFAULT_DECAY, SEGMENT_PREFERRED_TIER, makeMemoryId } from "./types.js";

const NAMESPACE = "boop-memory";

const tierEnum = z.enum(["short", "long", "permanent"]);
const segmentEnum = z.enum([
  "identity",
  "preference",
  "relationship",
  "project",
  "knowledge",
  "context",
]);

export function createMemoryTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "write_memory",
      "Persist a fact about the user or conversation that you want available in future turns. Prefer aggressive writing — memory is cheap, forgetting is expensive. Only use for durable facts (preferences, identity, projects, relationships), NOT for transient conversational state.",
      {
        content: z.string().describe("The fact to remember, in one clear sentence."),
        segment: segmentEnum.describe(
          "identity: core facts about who they are. preference: how they like things done. relationship: people they know. project: ongoing work. knowledge: facts about their world. context: current situation.",
        ),
        importance: z.number().min(0).max(1).describe("0-1; how critical to retain."),
        tier: tierEnum.optional().describe("Override; defaults by segment."),
        supersedes: z
          .array(z.string())
          .optional()
          .describe("memoryId(s) this replaces (will be archived)."),
      },
      async (args) => {
        // Secrets never go into memory, stored or pasted.
        const scan = scanForSecrets(args.content);
        if (scan.found) {
          return runtimeText("Not stored: that looks like it contains a secret. Secrets never go into memory.", false);
        }
        const tier = args.tier ?? SEGMENT_PREFERRED_TIER[args.segment];
        const memoryId = makeMemoryId();
        const embedding = (await embed(args.content)) ?? undefined;
        await convex.mutation(api.memoryRecords.upsert, {
          memoryId,
          content: args.content,
          tier,
          segment: args.segment,
          importance: args.importance,
          decayRate: DEFAULT_DECAY[tier],
          supersedes: args.supersedes,
          embedding,
        });
        await convex.mutation(api.memoryEvents.emit, {
          eventType: "memory.written",
          conversationId,
          memoryId,
          data: JSON.stringify({ tier, segment: args.segment, importance: args.importance }),
        });
        return runtimeText(`Stored ${memoryId} (tier=${tier}, segment=${args.segment}).`);
      },
    ),

    defineRuntimeTool(
      NAMESPACE,
      "recall",
      "Search your memories for anything relevant to the current turn. Call this early in any conversation that touches the user's preferences, projects, or past decisions.",
      {
        query: z.string().describe("Keywords or topic to search for."),
        limit: z.number().optional().default(10),
      },
      async (args) => {
        let results: any[] = [];
        let mode: "vector" | "substring" = "substring";

        if (embeddingsAvailable()) {
          const queryVec = await embed(args.query);
          if (queryVec) {
            const hits = await convex.action(api.memoryRecords.vectorSearch, {
              embedding: queryVec,
              limit: args.limit,
            });
            results = hits.map((h) => h.record);
            mode = "vector";
          }
        }
        if (results.length === 0) {
          results = await convex.query(api.memoryRecords.search, {
            query: args.query,
            limit: args.limit,
          });
        }

        for (const r of results) {
          await convex.mutation(api.memoryRecords.markAccessed, { memoryId: r.memoryId });
        }
        await convex.mutation(api.memoryEvents.emit, {
          eventType: "memory.recalled",
          conversationId,
          data: JSON.stringify({ query: args.query, hits: results.length, mode }),
        });
        if (results.length === 0) {
          return runtimeText("No memories matched.");
        }
        const body = results
          .map(
            (r) =>
              `• [${r.tier}/${r.segment} importance=${r.importance.toFixed(2)}] ${r.memoryId}: ${r.content}`,
          )
          .join("\n");
        return runtimeText(body);
      },
    ),

    defineRuntimeTool(
      NAMESPACE,
      "search_history",
      "Keyword search over the owner's imported work history: observations, session summaries and prompts from past coding sessions across all their projects (from claude-mem). Use it for 'did we already fix X', 'what did we decide about Y', 'when did I work on Z'. Separate from recall, which holds facts about the owner.",
      {
        query: z.string().describe("Words to look for, e.g. 'stripe webhook retry'."),
        project: z.string().optional().describe("Only this project, e.g. 'boop-agent'."),
        kind: z
          .enum(["observation", "summary", "prompt"])
          .optional()
          .describe("observation: one finding or change. summary: a whole session. prompt: what the owner asked."),
        limit: z.number().optional().default(8),
      },
      async (args) => {
        const hits = await convex.query(api.archiveRecords.search, {
          query: args.query,
          project: args.project,
          kind: args.kind,
          limit: args.limit,
        });
        await convex.mutation(api.memoryEvents.emit, {
          eventType: "history.searched",
          conversationId,
          data: JSON.stringify({ query: args.query, project: args.project, kind: args.kind, hits: hits.length }),
        });
        return runtimeText(formatHistoryHits(hits));
      },
    ),
  ];
}

interface HistoryHit {
  kind: string;
  project: string;
  title: string;
  content: string;
  type?: string;
  occurredAt: number;
  sourceId: string;
}

const SNIPPET = 600;

/** One block per hit: when, where, what, then the start of the text. */
export function formatHistoryHits(hits: HistoryHit[]): string {
  if (hits.length === 0) return "No history matched.";
  return hits
    .map((h) => {
      const date = new Date(h.occurredAt).toISOString().slice(0, 10);
      let body = h.content.replace(/^\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
      if (h.kind !== "prompt" && body.startsWith(h.title)) body = body.slice(h.title.length).trim();
      const snippet = body.length > SNIPPET ? `${body.slice(0, SNIPPET - 1)}…` : body;
      return `• ${date} [${h.project} · ${h.type ?? h.kind}] ${h.title} (${h.sourceId})\n  ${snippet}`;
    })
    .join("\n");
}

export function createMemoryMcp(conversationId: string) {
  return createClaudeMcpServer(NAMESPACE, createMemoryTools(conversationId));
}
