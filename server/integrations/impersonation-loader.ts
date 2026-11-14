import {
  IMPERSONATION_INTEGRATION,
  createImpersonationMcp,
  createImpersonationTools,
  liveImpersonationDeps,
} from "../impersonation/tools.js";
import { getBrowserSettings } from "../runtime-config.js";
import { isLocalBrowserSupported } from "../platform-support.js";
import { registerIntegration } from "./registry.js";

/**
 * Nova MCP + local browser: impersonate a named certificates.dev user and
 * screenshot pages as them. Needs the local browser (Mac, enabled in
 * Settings) and a Boop-connected MCP server exposing nova_run_action; the
 * tool says which one is missing.
 */
export function registerImpersonationIntegration(
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isLocalBrowserSupported(platform)) return false;
  registerIntegration({
    name: IMPERSONATION_INTEGRATION,
    description:
      "Impersonate a named certificates.dev user via Nova's allowlisted Impersonate User action and screenshot logged-in pages as them, read-only, in a throwaway local browser session (the link never reaches the agent).",
    isEnabled: async () => (await getBrowserSettings()).enabled,
    createServer: async () => createImpersonationMcp(),
    createTools: async () => createImpersonationTools(liveImpersonationDeps),
  });
  return true;
}
