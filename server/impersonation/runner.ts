import {
  READ_ONLY_METHODS,
  checkTargets,
  describeActionResult,
  extractImpersonationLink,
  findImpersonateAction,
  findUserIdsByEmail,
  looksSignedOut,
  parseAccount,
  parseNovaActions,
  removeLink,
  safeDisplayUrl,
  scrubLinks,
  type McpCallResult,
} from "./links.js";

/**
 * "Impersonate a Nova user and screenshot pages as them", run entirely inside
 * Boop's server process:
 *
 *   1. nova_run_action (the allowlisted "Impersonate User" action) through the
 *      owner's authenticated Nova MCP server
 *   2. the returned link is opened in a throwaway Patchright context
 *   3. each target page is captured, then the context is closed
 *
 * The link is a credential, so it never leaves this module: the agent, its
 * logs and the chat only see the account, the target pages and the
 * screenshot paths.
 */

export interface NovaCaller {
  /** Which Boop MCP server name this is (for messages). */
  readonly server: string;
  call(tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface CapturedPage {
  target: string;
  finalUrl: string;
  path: string | null;
  error?: string;
}

export interface ImpersonatedBrowserResult {
  landedUrl: string;
  pages: CapturedPage[];
  blockedWrites: number;
}

/** Opens `link` in an isolated, read-only browser session, captures targets, and closes it. */
export type ImpersonatedBrowser = (
  link: string,
  targets: string[],
  opts: { fullPage: boolean },
) => Promise<ImpersonatedBrowserResult>;

export interface ImpersonationRequest {
  account: string;
  namedByUser: boolean;
  targets: string[];
  resource?: string;
  action?: string;
  baseUrl?: string;
  fullPage?: boolean;
}

export interface ImpersonationDeps {
  connectNova: () => Promise<NovaCaller>;
  browser: ImpersonatedBrowser;
}

export interface ImpersonationOutcome {
  ok: boolean;
  /** Safe to show the agent, log and relay: never contains the link. */
  text: string;
  screenshots: string[];
}

export const DEFAULT_BASE_URL = "https://certificates.dev";
export const DEFAULT_RESOURCE = "users";
export const MAX_TARGETS = 6;

function fail(text: string): ImpersonationOutcome {
  return { ok: false, text, screenshots: [] };
}

export async function runImpersonationCapture(
  req: ImpersonationRequest,
  deps: ImpersonationDeps,
): Promise<ImpersonationOutcome> {
  if (!req.namedByUser) {
    return fail(
      "Refused: only impersonate an account the user named explicitly in this conversation (prefer an internal/test account). Ask the user which account to use.",
    );
  }
  const account = parseAccount(req.account);
  if (!account) {
    return fail("Refused: pass the account as a numeric Nova user id or an exact email address the user gave you.");
  }
  if (req.targets.length === 0) return fail("Pass at least one target page to capture.");
  if (req.targets.length > MAX_TARGETS) return fail(`Pass at most ${MAX_TARGETS} target pages per run.`);

  const baseUrl = req.baseUrl?.trim() || DEFAULT_BASE_URL;
  try {
    new URL(baseUrl);
  } catch {
    return fail(`base_url "${baseUrl}" is not a valid URL.`);
  }
  const preCheck = checkTargets(req.targets, baseUrl);
  if (preCheck.allowed.length === 0) {
    return fail(
      `None of the target pages can be captured: ${preCheck.rejected.map((r) => `${r.url} (${r.reason})`).join("; ")}.`,
    );
  }
  const resource = req.resource?.trim() || DEFAULT_RESOURCE;

  let nova: NovaCaller;
  try {
    nova = await deps.connectNova();
  } catch (err) {
    return fail(`Couldn't reach the Nova MCP server: ${scrubLinks(err instanceof Error ? err.message : String(err))}`);
  }

  let link: string | null = null;
  try {
    // 1. Resolve the user.
    let userId: string;
    if (account.kind === "id") {
      userId = account.id;
    } else {
      const found = await nova.call("nova_list_records", { resource, search: account.email, per_page: 25 });
      if (found.isError) {
        return fail(`Looking up ${account.email} in Nova failed: ${describeActionResult(found)}`);
      }
      const ids = findUserIdsByEmail(found, account.email);
      if (ids.length === 0) return fail(`No Nova ${resource} record has the email ${account.email}. Check the address with the user.`);
      if (ids.length > 1) return fail(`More than one Nova ${resource} record matches ${account.email} (ids ${ids.join(", ")}). Ask the user which id to use.`);
      userId = ids[0];
    }

    // 2. Find the Impersonate User action and check it is allowlisted.
    let actionKey = req.action?.trim();
    if (!actionKey) {
      const listed = await nova.call("nova_list_actions", { resource, id: userId });
      if (listed.isError) {
        return fail(`Listing Nova actions on ${resource} failed: ${describeActionResult(listed)}`);
      }
      const actions = parseNovaActions(listed);
      const impersonate = findImpersonateAction(actions);
      if (!impersonate) {
        const names = actions.map((a) => a.name).join(", ") || "none";
        return fail(`Nova has no Impersonate User action on "${resource}" (actions listed: ${names}). A human can impersonate from the user's Nova page instead.`);
      }
      if (impersonate.allowlisted === false) {
        return fail(`Nova's "${impersonate.name}" action is not allowlisted for the MCP, so Boop can't run it. Adding it is a reviewed change on the Nova side; until then a human has to use the Impersonate button on the user's Nova page.`);
      }
      actionKey = impersonate.uriKey;
    }

    // 3. Run it.
    const ran = await nova.call("nova_run_action", { resource, action: actionKey, ids: [userId], fields: {} });
    link = extractImpersonationLink(ran, baseUrl);
    if (!link) {
      return fail(
        [
          `Nova's "${actionKey}" action on ${resource} #${userId} returned no usable impersonation link${ran.isError ? " (it reported an error)" : ""}, so no page was opened.`,
          `It returned: ${describeActionResult(ran)}`,
          "Fallback: a human can open the user's Nova page, press Impersonate, and look at the pages themselves.",
        ].join("\n"),
      );
    }
    const scrub = (text: string) => removeLink(text, link);

    // 4. Targets must be on the link's site.
    const targets = checkTargets(req.targets, link);
    if (targets.allowed.length === 0) {
      return fail(scrub(`None of the target pages are on the impersonation link's site: ${targets.rejected.map((r) => `${r.url} (${r.reason})`).join("; ")}.`));
    }

    // 5. Open it, capture, close.
    let browsed: ImpersonatedBrowserResult;
    try {
      browsed = await deps.browser(link, targets.allowed, { fullPage: req.fullPage ?? false });
    } catch (err) {
      return fail(scrub(`The impersonation link came back, but the browser run failed: ${scrubLinks(err instanceof Error ? err.message : String(err))}`));
    }

    const lines: string[] = [
      `Impersonated ${resource} #${userId} (${req.account.trim()}) via Nova "${actionKey}" in a throwaway read-only browser session; the session is closed and its cookies are gone.`,
    ];
    if (looksSignedOut(browsed.landedUrl)) {
      lines.push(`Warning: opening the link landed on a sign-in page (${safeDisplayUrl(browsed.landedUrl)}), so the impersonation may not have taken; the screenshots may show a signed-out view.`);
    }
    const screenshots: string[] = [];
    browsed.pages.forEach((page, i) => {
      const where = safeDisplayUrl(page.finalUrl);
      if (page.path) {
        screenshots.push(page.path);
        const signedOut = looksSignedOut(page.finalUrl) ? " — WARNING: this looks like a sign-in page" : "";
        lines.push(`${i + 1}. ${safeDisplayUrl(page.target)} → screenshot ${page.path} (ended on ${where})${signedOut}`);
      } else {
        lines.push(`${i + 1}. ${safeDisplayUrl(page.target)} → not captured: ${scrubLinks(page.error ?? "unknown error")}`);
      }
    });
    for (const r of [...preCheck.rejected, ...targets.rejected.filter((r) => !preCheck.rejected.some((p) => p.url === r.url))]) {
      lines.push(`Skipped ${r.url}: ${r.reason}.`);
    }
    if (browsed.blockedWrites > 0) {
      lines.push(`Blocked ${browsed.blockedWrites} non-GET request(s) the pages tried to send, to keep the session read-only.`);
    }
    if (screenshots.length) {
      lines.push("Attach the screenshot paths above with attach_image. Never ask for, print or store the impersonation link.");
    }
    return { ok: screenshots.length > 0, text: scrub(lines.join("\n")), screenshots };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(removeLink(`Nova impersonation failed: ${scrubLinks(message)}`, link));
  } finally {
    await nova.close().catch(() => undefined);
  }
}

/** True when a request may go through in the impersonated (read-only) session. */
export function allowedInReadOnlySession(method: string): boolean {
  return READ_ONLY_METHODS.has(method.toUpperCase());
}
