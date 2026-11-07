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
- **No caching or logging**: every response is `Cache-Control: no-store`, and
  nothing logs values, passcodes or tokens.

## Setup

1. **Pick a hostname** and add it to `.env.local` on the Mac:

   ```sh
   SECRETS_PUBLIC_BASE_URL=https://secret.example.com
   # Optional: also serve the secrets-only app on its own loopback port, so
   # the tunnel never points at Boop's main port at all.
   # SECRETS_PUBLIC_PORT=3457
   ```

   Restart Boop. `get_config` now shows a `remoteSecretEntry` status line.

2. **Set the passcode on the Mac.** Ask Boop to "request the secret
   SECRETS_PORTAL_PASSCODE", open the **local** link on the Mac, and type a
   passphrase of 8+ characters. `get_config` then says
   `Remote secret entry: enabled at https://secret.example.com`.

3. **Point a tunnel at it** (below). Keep your existing tunnels as they are;
   this is an extra one.

From then on `request_secret` returns the local link plus
`https://secret.example.com/secrets/enter/<token>`.

## Tunnels

Point the tunnel at `SECRETS_PUBLIC_PORT` if you set one (only the secrets
app listens there), or at Boop's main port (3456): there, requests whose
`Host` (or `X-Forwarded-Host`) is the secrets host are handed to the
secrets-only app before anything else runs.

### ngrok (reserved domain)

Reserve the domain (or add a custom domain with a CNAME) in the ngrok
dashboard, then run a second endpoint:

```sh
ngrok http 3457 --url https://secret.example.com
# or, without SECRETS_PUBLIC_PORT:
ngrok http 3456 --url https://secret.example.com
```

ngrok keeps the original `Host` header by default, which is what the main-port
routing matches. (`--host-header=rewrite` also works: ngrok then sends
`X-Forwarded-Host`, which is matched too.) With an ngrok config file, add a
second tunnel/endpoint instead of changing the one Sendblue uses.

### cloudflared (Cloudflare Tunnel)

With the domain on Cloudflare:

```sh
cloudflared tunnel create boop-secrets
cloudflared tunnel route dns boop-secrets secret.example.com
```

`~/.cloudflared/config.yml` (or add the hostname to an existing tunnel's
ingress list, above its catch-all):

```yaml
tunnel: boop-secrets
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: secret.example.com
    service: http://127.0.0.1:3457   # or http://127.0.0.1:3456
  - service: http_status:404
```

```sh
cloudflared tunnel run boop-secrets
```

Leave `httpHostHeader` unset so the public host reaches Boop. You can put
Cloudflare Access in front of this hostname too, as an extra login.

## Checking it

```sh
curl -sI https://secret.example.com/                 # 404
curl -sI https://secret.example.com/runtime-config   # 404
```

A fresh `request_secret` link should show the passcode page.
