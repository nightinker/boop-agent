import "../env-setup.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import {
  DEFAULT_BOOP_URL,
  DEFAULT_CONVERSATION_ID,
  addMemory,
  deleteMemory,
  listConversations,
  listMemories,
  readMessages,
  searchMemories,
  sendMessage,
  updateMemory,
  type BoopMcpContext,
} from "./boop-tools.js";

const tierEnum = z.enum(["short", "long", "permanent"]);
const segmentEnum = z.enum([
  "identity",
  "preference",
  "correction",
  "relationship",
  "project",
  "knowledge",
  "context",
]);

const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
if (!convexUrl) {
  console.error("boop-mcp: CONVEX_URL (or VITE_CONVEX_URL) is not set.");
  process.exit(1);
}

const ctx: BoopMcpContext = {
  convex: new ConvexHttpClient(convexUrl),
  convexUrl,
  boopUrl: process.env.BOOP_URL ?? DEFAULT_BOOP_URL,
  allowRemoteWrites: process.env.BOOP_MCP_ALLOW_REMOTE_WRITES === "1",
  defaultConversationId: process.env.BOOP_MCP_CONVERSATION_ID,
  embed: async (text) => {
    const { embed } = await import("../embeddings.js");
    return embed(text);
  },
};

function respond(run: () => Promise<unknown>) {
  return run().then(
    (value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }),
    (err: unknown) => ({
      isError: true,
      content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
    }),
  );
}

const server = new McpServer({ name: "boop", version: "0.1.0" });

server.registerTool(
  "boop_memory_list",
  {
    description: "READ. List Boop's memories, newest first. Defaults to active ones.",
    inputSchema: {
      tier: tierEnum.optional(),
      segment: segmentEnum.optional(),
      lifecycle: z.enum(["active", "archived", "pruned"]).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => respond(() => listMemories(ctx, args)),
);

server.registerTool(
  "boop_memory_search",
  {
    description: "READ. Substring search over Boop's active memories, best importance first.",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true },
  },
  (args) => respond(() => searchMemories(ctx, args)),
);

server.registerTool(
  "boop_memory_add",
  {
    description:
      "WRITE. Add a new memory to Boop. Rejects content that looks like a secret. Tier and importance default from the segment.",
    inputSchema: {
      content: z.string().min(1).describe("The fact, in one clear sentence."),
      segment: segmentEnum,
      importance: z.number().min(0).max(1).optional(),
      tier: tierEnum.optional(),
      supersedes: z.array(z.string()).optional().describe("memoryIds this replaces (they get archived)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  (args) => respond(() => addMemory(ctx, args)),
);

server.registerTool(
  "boop_memory_update",
  {
    description:
      "WRITE. Change an existing memory's content, segment, tier or importance. Overwrites the previous values; the old text is not kept.",
    inputSchema: {
      memoryId: z.string(),
      content: z.string().min(1).optional(),
      segment: segmentEnum.optional(),
      importance: z.number().min(0).max(1).optional(),
      tier: tierEnum.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  (args) => respond(() => updateMemory(ctx, args)),
);

server.registerTool(
  "boop_memory_delete",
  {
    description:
      "WRITE, DESTRUCTIVE. mode=archive hides the memory but keeps it (recoverable, the default). mode=delete removes it permanently.",
    inputSchema: {
      memoryId: z.string(),
      mode: z.enum(["archive", "delete"]).default("archive"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  (args) => respond(() => deleteMemory(ctx, args)),
);

server.registerTool(
  "boop_send_message",
  {
    description: `WRITE. Send Boop a chat message and wait for its reply (a full agent turn, can take a while). Needs Boop running at BOOP_URL. Default conversation: ${DEFAULT_CONVERSATION_ID}.`,
    inputSchema: { content: z.string().min(1), conversationId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  (args) => respond(() => sendMessage(ctx, args)),
);

server.registerTool(
  "boop_read_messages",
  {
    description: `READ. Recent messages in a Boop conversation, oldest first. Default conversation: ${DEFAULT_CONVERSATION_ID}.`,
    inputSchema: {
      conversationId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  (args) => respond(() => readMessages(ctx, args)),
);

server.registerTool(
  "boop_list_conversations",
  {
    description: "READ. List Boop's conversations (ids, message counts, last activity).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () => respond(() => listConversations(ctx)),
);

await server.connect(new StdioServerTransport());
