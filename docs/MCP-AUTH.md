# Signing Boop in to OAuth-protected MCP servers

Boop's sessions run without a person at the keyboard, so they can't click through an OAuth sign-in. Remote MCP servers that need one (for example a Banner Studio server, a Stripe plugin's server, or any `https://…/mcp` endpoint that answers 401) used to sit in "needs authentication" with their tools unavailable. Now the owner signs in once from a link, and Boop keeps the server connected after that.

## Using it

- **"authenticate bannerstudio"**: Boop calls `start_mcp_auth` and texts back a one-time link. It works once and expires after about 10 minutes.
  - On the Mac: `http://localhost:<PORT>/mcp-auth/start/<token>`
  - Away from the Mac: the same path on the secrets host, behind the secrets passcode (see [SECRETS-REMOTE.md](SECRETS-REMOTE.md)), or on the Cloudflare Access-protected `PUBLIC_URL`.
- Open the link and sign in on the service's own page. Boop handles the redirect back, stores the tokens and texts "🔌 bannerstudio is connected".
- Boop takes the server's URL from what you said, or else looks it up in your Claude Code config (`~/.claude.json`, the repo's `.mcp.json`, installed plugins' `.mcp.json`). If it can't find the URL, it asks you for it.
- **"which MCP servers need auth?"**: `list_mcp_servers` shows each server Boop manages: connected, needs auth, or needs re-auth with the reason. It also lists servers that Claude sessions reported as `needs-auth` but that aren't set up in Boop yet.
- **Static tokens** (for example a per-server Snailmark token): Boop calls `start_mcp_auth(name, url, auth: "bearer")`. You get a normal secret-entry link for `MCP_<NAME>_TOKEN`, or for an existing secret name if you give one. Boop sends that token as `Authorization: Bearer`.
- Once connected, the server becomes an integration with the same name (for example `bannerstudio`). Boop can pass it to `spawn_agent`.

Only the owner can use this: local conversations, or iMessage numbers listed in `BOOP_OWNER_NUMBERS`. It only works on the Mac, because that's where the Keychain is.

## How it works

1. **Discovery.** Boop sends an unauthenticated `initialize` to the server and expects a 401 with `WWW-Authenticate: Bearer resource_metadata=…`. It then reads the protected-resource metadata (RFC 9728) and the authorization server's metadata (RFC 8414 / OpenID discovery). If the server publishes no metadata, Boop falls back to the 2025-03-26 defaults (`/authorize`, `/token`, `/register`).
2. **Client.** Boop uses dynamic client registration (RFC 7591) as a public client where the server supports it. Otherwise, register an OAuth app with the provider yourself, using the redirect URI from the error message. Then have Boop `request_secret` `MCP_<NAME>_CLIENT_ID`, plus `MCP_<NAME>_CLIENT_SECRET` if the app has one.
3. **Authorization.** PKCE uses S256; Boop refuses servers that don't offer it. Boop also sends a random single-use `state` and the RFC 8707 `resource`. The verifier and state stay in Boop's memory for 10 minutes.
4. **Callback.** `/mcp-auth/callback` exchanges the code. The access and refresh tokens go into the secret store (Keychain) as `MCP_<NAME>_ACCESS_TOKEN` and `MCP_<NAME>_REFRESH_TOKEN`. They're also loaded into the redactor, so they're scrubbed if they ever appear in output.
5. **Use.** Claude sub-agents connect to `http://127.0.0.1:<PORT>/mcp-proxy/<name>`. The proxy only answers loopback requests that carry a random key generated when Boop starts. It adds `Authorization: Bearer …` inside Boop and streams the response back. The Claude process never sees a token: not in its MCP config, its command line or its environment.
6. **Refresh.** The token is refreshed shortly before it expires, and once more after a 401. Rotated refresh tokens replace the old ones.
7. **Re-auth.** If the refresh is rejected (`invalid_grant`, revoked) or a static token gets a 401, the server is marked **needs re-auth** and drops out of the integrations. Boop texts the owner once, with a fresh link. A network error or 5xx just keeps the tokens and tries again next time.

`~/.config/boop/mcp-servers.json` (chmod 600) holds only names, URLs, endpoints, client ids, expiry times and status. It never holds a token.

## Limits

- Only Claude sub-agents get these servers. Codex sub-agents don't, because Boop has no bridge from MCP tools to Codex runtime tools yet.
- Only Streamable HTTP servers are proxied, not the older HTTP+SSE transport.
- Boop authenticates its own copy of the connection. Claude Code's own "needs authentication" entries for the same server (claude.ai connectors, plugins) are left as they are; Boop's sub-agents use the Boop-managed server with the same name.
- The proxy key appears in the Claude process's MCP config, which the Agent SDK passes on the command line. It only works on loopback, only reaches the proxy, and changes on every restart.
