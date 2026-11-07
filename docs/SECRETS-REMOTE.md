# Entering secrets away from the Mac

`request_secret` gives you a one-time link where you type an API key or
password; the value goes straight into the Mac's Keychain and never through
chat. By default that link only opens on the Mac itself
(`http://localhost:3456/secrets/enter/<token>`). Opening it through a tunnel
to the dashboard used to fail with `{"error":"not found"}`, because everything
but `/health` and the webhooks is local-only.

A **secrets host** fixes that without exposing anything else: a dedicated
public hostname (e.g. `https://secret.example.com`) that serves only the entry
pages. On that host, everything else (the dashboard, the API, `/health`, the
webhooks, websockets) is a plain 404.

## What protects it

- **Links**: single-use, expire after 10 minutes, 256-bit random, compared in
  constant time. Opening the page or logging in also needs a live link.
- **Passcode**: before the form is shown you log in with a passcode kept in
  the secret store as `SECRETS_PORTAL_PASSCODE` (8+ characters). It's set
  like any other secret, never in chat, and can only be set from the Mac
  (the secrets host refuses links for it). Until it's set, the host only
  says "not set up".
- **Session**: logging in sets a fresh `__Host-` cookie (`Secure`, `HttpOnly`,
  `SameSite=Strict`) that lasts 15 minutes.
- **CSRF**: every form carries a per-session token, and a POST from another
  origin is refused.
- **Rate limits**: 60 requests/minute per client; 10 failures (wrong
  passcode, unknown or dead link, bad form token) per client and 30 overall
  per 15 minutes, then 429.
- **HTTPS only**: the base URL must be `https://`, plain-HTTP requests
  get 403 (every `X-Forwarded-Proto` / `Forwarded: proto=` value must be
  `https`, so a client can't prepend a fake one), and responses send HSTS.
- **Health probe**: `/secrets/probe/<token>` answers 204 only for a random
  token that lives in the running Boop's memory; it unlocks nothing, and any
  other token is the usual 404.
- **No caching or logging**: every response is `Cache-Control: no-store`, and
  nothing logs values, passcodes or tokens.

## Setup

Everything lives **outside Boop.app**, so it survives app restarts,
reinstalls and updates:

| What | Where |
| --- | --- |
| Public base URL + listener port | `~/.config/boop/secrets-remote.json` (or the path in `BOOP_SECRETS_REMOTE_CONFIG`) |
| Passcode | Keychain, as `SECRETS_PORTAL_PASSCODE` |
| Tunnel | a launchd LaunchAgent (`~/Library/LaunchAgents/dev.boop.secrets-tunnel.plist`) running `cloudflared` |

1. **Create the tunnel once** (domain on Cloudflare):

   ```sh
   brew install cloudflared
   cloudflared tunnel login
   cloudflared tunnel create boop-secrets
   cloudflared tunnel route dns boop-secrets secret.example.com
   ```

2. **Write the config and install the tunnel service:**

   ```sh
   npm run secrets:remote-setup -- --url https://secret.example.com --tunnel boop-secrets --load
   ```

   This writes `~/.config/boop/secrets-remote.json`:

   ```json
   { "publicBaseUrl": "https://secret.example.com", "port": 3457 }
   ```

   plus `~/.cloudflared/boop-secrets.yml` (routes only that hostname to
   `127.0.0.1:3457`, 404 for anything else) and the LaunchAgent, which starts
   the tunnel at login and restarts it if it dies. Add `--dry-run` to see the
   files first, or leave out `--tunnel` to write only the Boop config.

3. **Restart Boop once.** On every boot it reads the file, starts the
   secrets-only listener on `127.0.0.1:3457` (retrying for ~20 s if a previous
   Boop still holds the port) and logs one line saying where its config came
   from. If something's missing it logs `[secrets] remote entry OFF: …
   Missing: …` instead of silently going local-only.

4. **Set the passcode on the Mac.** Ask Boop to "request the secret
   SECRETS_PORTAL_PASSCODE", open the **local** link on the Mac, and type a
   passphrase of 8+ characters. It's only ever read from the Keychain; a
   `SECRETS_PORTAL_PASSCODE` env var is ignored (with a warning).

From then on `request_secret` returns the local link plus
`https://secret.example.com/secrets/enter/<token>`. When remote entry isn't
configured it says exactly what's missing instead.

### Legacy env vars

`SECRETS_PUBLIC_BASE_URL` / `SECRETS_PUBLIC_PORT` in `.env.local` still work
when there's no config file, with a startup warning to move them. When the
file exists it wins and the env vars are ignored.

## Checking it

Ask Boop for `get_config`. `remoteSecretEntry` shows:

- `baseUrl`, `port`, `source` (`file`, `env` or `none`) and `configPath`;
- `passcodeSet` (never the value);
- `listener`: `listening`, `starting`, `failed` (with the error) or `off`;
- `tunnel`: Boop fetches `<baseUrl>/secrets/probe/<random per-process token>`
  over the internet; `reachable: true` means the tunnel reaches this very Boop;
- `missing`: exactly what to add or fix, and a one-line `status`.

From a shell:

```sh
launchctl print gui/$(id -u)/dev.boop.secrets-tunnel | head   # tunnel service state
tail ~/Library/Logs/boop-secrets-tunnel.log
curl -sI https://secret.example.com/                 # 404
curl -sI https://secret.example.com/runtime-config   # 404
```

## Other tunnels

Point the tunnel at the listener port (3457 by default; only the secrets app
listens there), or at Boop's main port (3456): there, requests whose `Host`
(or `X-Forwarded-Host`) is the secrets host are handed to the secrets-only
app before anything else runs. To survive restarts, run it as a LaunchAgent
like the one above (`KeepAlive`, `RunAtLoad`), not from Boop.

### ngrok (reserved domain)

Reserve the domain (or add a custom domain with a CNAME) in the ngrok
dashboard, then run a second endpoint:

```sh
ngrok http 3457 --url https://secret.example.com
# or, via the main port:
ngrok http 3456 --url https://secret.example.com
```

ngrok keeps the original `Host` header by default, which is what the main-port
routing matches. (`--host-header=rewrite` also works: ngrok then sends
`X-Forwarded-Host`, which is matched too.) With an ngrok config file, add a
second tunnel/endpoint instead of changing the one Sendblue uses.
