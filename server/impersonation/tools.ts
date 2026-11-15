import { z } from "zod";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_RESOURCE,
  MAX_TARGETS,
  runImpersonationCapture,
  type ImpersonationDeps,
} from "./runner.js";

export const IMPERSONATION_INTEGRATION = "nova-impersonation";
export const IMPERSONATION_NAMESPACE = "nova_impersonation";
export const IMPERSONATION_TOOL = "impersonate_and_screenshot";

export const IMPERSONATION_EXECUTION_PROMPT = `

Logged-in page checks as a customer ("${IMPERSONATION_INTEGRATION}" integration):
- To see a certificates.dev page as a specific user (e.g. "verify the TypeScript Level 1, 2 and 3 trainings for user X"), call ${IMPERSONATION_TOOL} with the account, the target page URLs and named_by_user: true. It runs Nova's allowlisted Impersonate User action, opens the returned link in a throwaway read-only local browser session, screenshots each page, then closes the session. No Nova login in the browser is needed.
- Only impersonate an account the user explicitly named (an id or email). If they didn't name one, stop and ask; suggest an internal/test account. Never pick a customer yourself.
- The impersonation link is a credential. Never call nova_run_action for Impersonate User yourself, never ask for, print, save or forward the link; the tool keeps it out of your context.
- Read-only: don't change anything on the impersonated account. The tool blocks non-GET requests; don't use other tools to act as that user.
- Attach every screenshot path it returns with attach_image. If it reports no usable link, relay exactly what it says Nova returned and its fallback; don't improvise another way in.
- If a saved skill about certificates.dev duplicate verification exists and doesn't mention ${IMPERSONATION_TOOL} yet, add a short step about it with skill_manage (view it first).`;

export const IMPERSONATION_DISPATCHER_PROMPT = `
Seeing a page as a customer (Nova impersonation):
The "${IMPERSONATION_INTEGRATION}" integration lets a sub-agent impersonate a certificates.dev user through Nova's allowlisted Impersonate User action and screenshot logged-in pages as them (e.g. the TypeScript Level 1/2/3 trainings), read-only, in a throwaway local browser session. Use it only when the user names the account (id or email; prefer an internal/test account) — if they didn't, ask first. Spawn with ["${IMPERSONATION_INTEGRATION}"], put the account and the page URLs in the task, and ask for the screenshots to be attached. Never put an impersonation link in a task or reply.`;

export function createImpersonationTools(
  deps: (server?: string) => ImpersonationDeps,
  namespace = IMPERSONATION_NAMESPACE,
): RuntimeTool[] {
  return [
    defineRuntimeTool(
      namespace,
      IMPERSONATION_TOOL,
      [
        "Verify logged-in pages as a certificates.dev user: runs Nova's allowlisted Impersonate User action for the named account, opens the returned impersonation link in a throwaway read-only local Patchright session, screenshots each target page, then closes the session.",
        "Returns screenshot paths to attach with attach_image. The impersonation link is never returned (it is a credential).",
        "Only for an account the user explicitly named; prefer internal/test accounts.",
      ].join(" "),
      {
        account: z.string().describe("Nova user id (digits) or the exact email the user gave."),
        named_by_user: z
          .boolean()
          .describe("True only if the user explicitly named this account in the conversation. Never guess an account."),
        targets: z
          .array(z.string())
          .describe(`Up to ${MAX_TARGETS} page URLs (or paths) on the same site to screenshot as that user.`),
        full_page: z.boolean().optional().describe("Capture the full scrollable page. Default false."),
        base_url: z.string().optional().describe(`Site the link and relative paths belong to. Default ${DEFAULT_BASE_URL}.`),
        resource: z.string().optional().describe(`Nova resource uri key for users. Default "${DEFAULT_RESOURCE}".`),
        action: z
          .string()
          .optional()
          .describe("Nova action uri key. Omit to find the Impersonate User action with nova_list_actions."),
        nova_server: z
          .string()
          .optional()
          .describe("Boop MCP server name for Nova. Omit to use the connected server that has nova_run_action."),
      },
      async (args) => {
        const outcome = await runImpersonationCapture(
          {
            account: args.account,
            namedByUser: args.named_by_user,
            targets: args.targets,
            fullPage: args.full_page,
            baseUrl: args.base_url,
            resource: args.resource,
            action: args.action,
          },
          deps(args.nova_server),
        );
        return runtimeText(outcome.text, outcome.ok);
      },
    ),
  ];
}

async function defaultDeps(server?: string): Promise<ImpersonationDeps> {
  const [{ connectNova }, { patchrightImpersonatedBrowser }] = await Promise.all([
    import("./nova.js"),
    import("./browser.js"),
  ]);
  return { connectNova: () => connectNova(server), browser: patchrightImpersonatedBrowser };
}

/** Real deps, loaded lazily so tests and non-Mac hosts never import Patchright for this. */
export function liveImpersonationDeps(server?: string): ImpersonationDeps {
  const loaded = defaultDeps(server);
  return {
    connectNova: async () => (await loaded).connectNova(),
    browser: async (link, targets, opts) => (await loaded).browser(link, targets, opts),
  };
}

export function createImpersonationMcp() {
  return createClaudeMcpServer(IMPERSONATION_NAMESPACE, createImpersonationTools(liveImpersonationDeps));
}
