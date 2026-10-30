import {
  createSdkMcpServer,
  query,
  tool,
  type McpServerConfig,
  type McpSdkServerConfigWithInstance,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeRunRequest, RuntimeRunResult, RuntimeTool } from "./types.js";
import { aggregateUsageFromResult, EMPTY_USAGE } from "../usage.js";

type ClaudePrompt = string | AsyncIterable<SDKUserMessage>;

function toClaudePrompt(prompt: RuntimeRunRequest["prompt"]): ClaudePrompt {
  if (typeof prompt === "string") return prompt;
  return (async function* () {
    yield {
      type: "user" as const,
      session_id: "",
      message: {
        role: "user" as const,
        content: prompt as SDKUserMessage["message"]["content"],
      },
      parent_tool_use_id: null,
    };
  })();
}

export function createClaudeMcpServer(
  name: string,
  tools: RuntimeTool[],
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name,
    version: "0.1.0",
    tools: tools.map((runtimeTool) =>
      tool(
        runtimeTool.name,
        runtimeTool.description,
        runtimeTool.inputSchema,
        async (args) => {
          const result = await runtimeTool.handle(args as Record<string, unknown>);
          return {
            content: [{ type: "text" as const, text: result.text }],
          };
        },
      ),
    ),
  });
}

const CLAUDE_STDERR_TAIL_LINES = 40;

/**
 * The SDK only reports "Claude Code process exited with code 1"; the reason is
 * on the CLI's stderr. Attach the tail of it so the logs say what went wrong.
 */
export function withClaudeStderr(err: unknown, stderrTail: string[]): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  if (stderrTail.length === 0) return error;
  error.message = `${error.message}\nClaude Code stderr:\n${stderrTail.join("\n")}`;
  return error;
}

export async function runClaudeAgent(request: RuntimeRunRequest): Promise<RuntimeRunResult> {
  const runtimeServers = new Map<string, RuntimeTool[]>();
  for (const runtimeTool of request.tools) {
    const list = runtimeServers.get(runtimeTool.namespace) ?? [];
    list.push(runtimeTool);
    runtimeServers.set(runtimeTool.namespace, list);
  }

  const mcpServers = {
    ...(request.claudeMcpServers ?? {}),
    ...Object.fromEntries(
      [...runtimeServers.entries()].map(([name, tools]) => [
        name,
        createClaudeMcpServer(name, tools),
      ]),
    ),
  } as Record<string, McpServerConfig>;

  let text = "";
  let lastAssistantText = "";
  let usage = { ...EMPTY_USAGE, model: request.model };
  const stderrTail: string[] = [];

  try {
  for await (const msg of query({
    prompt: toClaudePrompt(request.prompt),
    options: {
      systemPrompt: request.systemPrompt,
      model: request.model,
      mcpServers,
      allowedTools: request.allowedTools,
      disallowedTools: request.disallowedTools,
      ...(request.mode === "execution" ? { settingSources: ["project"] as const } : {}),
      permissionMode: "bypassPermissions",
      abortController: request.abortController,
      stderr: (data: string) => {
        stderrTail.push(...data.split("\n").filter((line) => line.trim()));
        if (stderrTail.length > CLAUDE_STDERR_TAIL_LINES) {
          stderrTail.splice(0, stderrTail.length - CLAUDE_STDERR_TAIL_LINES);
        }
      },
    },
  })) {
    if (msg.type === "assistant") {
      let assistantText = "";
      for (const block of msg.message.content) {
        if (block.type === "text") {
          text += block.text;
          assistantText += block.text;
          await request.onText?.(block.text);
        } else if (block.type === "tool_use") {
          await request.onToolUse?.(block.name, block.input);
        }
      }
      if (assistantText.trim()) lastAssistantText = assistantText;
    } else if (msg.type === "user") {
      for (const block of msg.message.content) {
        if (typeof block !== "string" && block.type === "tool_result") {
          const resultText = Array.isArray(block.content)
            ? block.content
                .map((c: string | { type: string; text?: string }) =>
                  typeof c === "string" ? c : c.type === "text" ? (c.text ?? "") : "",
                )
                .join("")
            : String(block.content ?? "");
          await request.onToolResult?.("tool_result", resultText);
        }
      }
    } else if (msg.type === "result") {
      usage = aggregateUsageFromResult(msg, request.model);
      await request.onUsage?.(usage);
    }
  }
  } catch (err) {
    throw withClaudeStderr(err, stderrTail);
  }

  return { text: lastAssistantText || text, usage };
}
