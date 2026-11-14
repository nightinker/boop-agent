# Seeing certificates.dev pages as a user (Nova impersonation)

The `nova-impersonation` integration lets a Boop sub-agent verify logged-in pages
(for example the TypeScript Level 1, 2 and 3 trainings) the way a specific user
sees them, and send the screenshots back as images.

## What it needs

- **Local browser use** turned on in Settings (macOS). The integration is
  enabled whenever the local browser is.
- The certificates.dev **Nova MCP server connected in Boop** (`start_mcp_auth`),
  with the **Impersonate User** action on the `users` resource allowlisted on
  the Nova side. Nobody has to log in to Nova in the browser.

## How it works

The one tool, `impersonate_and_screenshot`, does everything inside Boop's
server process:

1. Resolves the account (a Nova user id, or an exact email via
   `nova_list_records`).
2. Finds the Impersonate User action with `nova_list_actions` and checks it is
   allowlisted, then runs it with `nova_run_action`, through Boop's
   authenticated MCP proxy.
3. Pulls the impersonation link out of the result (`openInNewTab`, `redirect`,
   `visit.path`, or a URL in the text).
4. Opens it in a **throwaway Patchright context** launched with the local
   browser settings, never the owner's own profile, and **blocks every
   non-GET request** so the session stays read-only.
5. Navigates to each target page (same site only, up to 6) and screenshots it.
6. Closes the context and clears its cookies, whatever happened.

It returns the screenshot paths; the agent attaches them with `attach_image`.

## Safety rules

- **Named accounts only.** The tool refuses unless `named_by_user: true` and
  the account is an id or exact email. The agent is told to ask when the user
  didn't name one, and to suggest an internal/test account.
- **The link is a credential.** It never leaves the tool: it isn't returned to
  the agent, so it can't land in agent logs, Convex or the chat. Error messages
  are scrubbed of it.
- **Read-only.** Only GET/HEAD/OPTIONS requests are allowed in the session; the
  tool only navigates and screenshots.
- **No usable link?** No browser opens. The tool reports what Nova returned
  (with anything link- or token-shaped removed) and gives the fallback: a
  human presses Impersonate on the user's Nova page.

## Example request

> Check the TypeScript Level 1, 2 and 3 trainings on certificates.dev as
> qa-test@example.com and send me screenshots.

## Text for the certificates.dev duplicate-verification skill

The duplicate-verification skill lives in Boop's saved skills (Convex), not in
this repo. Sub-agents with this integration are told to add the step below to
it the first time they use the tool; you can also paste it in yourself:

```markdown
## Verify what the user actually sees (impersonation screenshots)
- When the check needs the logged-in view (e.g. are the TypeScript Level 1/2/3
  trainings duplicated on a user's dashboard), use the `nova-impersonation`
  integration: call `impersonate_and_screenshot` with the account the user
  named (id or email; prefer an internal/test account), `named_by_user: true`,
  and the training page URLs. Attach every returned screenshot.
- Never run Nova's Impersonate User action directly and never print, save or
  forward the impersonation link — it is a credential.
- Read-only: don't change anything on the impersonated account.
- If the tool reports no usable link, relay exactly what Nova returned and the
  fallback (a human impersonates from the user's Nova page).
```
