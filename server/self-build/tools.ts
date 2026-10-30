import { z } from "zod";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { cancelSelfBuild, listSelfBuilds, shipSelfBuild, startSelfBuild } from "./run.js";

export const SELF_BUILD_NAMESPACE = "boop-self-build";

export const SELF_BUILD_ALLOWED_TOOLS = [
  `mcp__${SELF_BUILD_NAMESPACE}__start_self_build`,
  `mcp__${SELF_BUILD_NAMESPACE}__list_self_builds`,
  `mcp__${SELF_BUILD_NAMESPACE}__ship_self_build`,
  `mcp__${SELF_BUILD_NAMESPACE}__cancel_self_build`,
];

export const SELF_BUILD_PROMPT = `
Building features into yourself:
When the user asks you to add a feature to Boop, change how Boop itself works, or fix a bug in Boop (not a task in the world), call start_self_build with a clear, complete description of what to build. Confirm in one line that you've started; the build takes a while and you'll text the PR when it's ready. Only the owner can do this; if the tool refuses, say so plainly.
When the user approves a finished build (any phrasing, like "ship it", "install it", "go ahead"), call ship_self_build. If it reports failing checks, ask before calling it again with allowFailingChecks.
"cancel build" or similar → cancel_self_build. "How's the build going?" → list_self_builds.
Never claim a build shipped until you're back up and have said so.`;

export function createSelfBuildTools(conversationId: string): RuntimeTool[] {
  return [
    defineRuntimeTool(
      SELF_BUILD_NAMESPACE,
      "start_self_build",
      "Start building a feature or fix into Boop's own code: a coding agent works on a branch, runs the checks, opens a PR and texts the owner.",
      {
        request: z
          .string()
          .describe("What to build, written out fully: behaviour, where it shows up, edge cases the user mentioned."),
      },
      async ({ request }) => runtimeText(await startSelfBuild({ conversationId, request })),
    ),
    defineRuntimeTool(
      SELF_BUILD_NAMESPACE,
      "list_self_builds",
      "Show recent self-builds and their status.",
      {},
      async () => runtimeText(await listSelfBuilds()),
    ),
    defineRuntimeTool(
      SELF_BUILD_NAMESPACE,
      "ship_self_build",
      "Ship a finished self-build: merge its PR, rebuild Boop and restart. Only when the owner approved it.",
      {
        buildId: z.string().optional().describe("Defaults to the latest build waiting to ship."),
        allowFailingChecks: z
          .boolean()
          .optional()
          .describe("Only true after the owner confirmed shipping despite failing checks."),
      },
      async (args) => runtimeText(await shipSelfBuild({ conversationId, ...args })),
    ),
    defineRuntimeTool(
      SELF_BUILD_NAMESPACE,
      "cancel_self_build",
      "Stop a self-build in progress, or close one that's waiting to ship.",
      { buildId: z.string().optional() },
      async (args) => runtimeText(await cancelSelfBuild({ conversationId, ...args })),
    ),
  ];
}
