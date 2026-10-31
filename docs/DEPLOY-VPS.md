# Running Boop on a Linux VPS

This guide runs Boop **headless on a Linux server** (for example a DigitalOcean
droplet) instead of on your Mac. Boop runs as a `systemd` service behind a
reverse proxy with TLS, and Sendblue sends your iMessages to the server.

> **One instance at a time.** Only one Boop should receive the Sendblue
> webhook. If your Mac and the server both run, every text is answered twice and
> every automation fires twice. See [Run only one Boop](#run-only-one-boop).

## What works on the server and what doesn't

| Keeps working | Lost on the server |
| --- | --- |
| Texting Boop over iMessage via Sendblue | Apple data: iMessage history, Apple Calendar, Notes, Reminders (they read your Mac's databases and apps) |
| Memory, recall and consolidation (stored in Convex) | Local browser use (Patchright Chrome; it needs a screen for login handoff) |
| Automations and heartbeats | The desktop app and its "ship it" self-build restart (Mac only) |
| Composio integrations (Gmail, Google Calendar, Slack, …) and proactive email/Slack | Dashboard over the internet (it stays private; use an SSH tunnel, below) |
| Claude or Codex runtime, sub-agents, skills | |

On Linux, Boop turns the Mac-only features off by itself: the `apple` and
`browser` integrations are not registered, their settings read as off even if
you switched them on from your Mac (settings are shared through Convex), their
control routes answer `409`, and the dashboard hides their settings and
connection cards. Nothing needs to be configured for this.

For calendar and email on the server, connect **Google Calendar** / **Gmail**
(or another provider) through Composio in the dashboard's Connections tab.

## Requirements

- Ubuntu 22.04 or 24.04, **at least 2 GB RAM** (the free local embedding model
  needs roughly 1 GB while loading; the setup script adds a 2 GB swap file).
- A domain or subdomain whose DNS `A` record points at the server, e.g.
  `boop.example.com`. Sendblue and Composio need a public **HTTPS** URL.
- Your Sendblue, Convex and (optionally) Composio accounts, the same ones you
  use on your Mac.

## Quick start (setup script)

On a fresh droplet, as root:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/<you>/boop-agent.git /opt/boop-agent
cd /opt/boop-agent
bash scripts/vps-setup.sh --domain boop.example.com
```

The script ([`scripts/vps-setup.sh`](../scripts/vps-setup.sh)) is safe to
re-run. It:

1. installs Node.js 22 (NodeSource), git and build tools,
2. adds a 2 GB swap file if the server has no swap,
3. creates a `boop` system user and copies the checkout to `/home/boop/boop-agent` (it runs from there),
4. runs `npm ci --omit=dev` (skips Electron and test tooling),
5. installs the Claude Code CLI (for the one-time `claude` login),
6. creates `.env.local` from `.env.example` (mode `600`) with `PUBLIC_URL` set,
   if it does not exist yet — it never prints or overwrites your values,
7. installs **Caddy** with automatic HTTPS (or nginx + certbot with `--proxy nginx`),
8. opens only SSH, 80 and 443 in `ufw`,
9. installs and enables the `boop` systemd service, and starts it once the
   configuration is complete.

Run `bash scripts/vps-setup.sh --help` for every option (`--user`, `--dir`,
`--repo`, `--branch`, `--proxy caddy|nginx|none`, `--email`, `--no-swap`,
`--no-firewall`, `--no-claude-cli`). Then finish the manual steps below
(environment, login, Convex, Sendblue) and start the service.

## Manual setup, step by step

Everything the script does, by hand. Commands that need root are prefixed with `sudo`.

### 1. Install Node.js

Boop needs Node.js 20 or newer; 22 LTS is recommended.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential
node --version
```

### 2. Create a user and clone the repo

```bash
sudo adduser --system --group --home /home/boop --shell /bin/bash boop
sudo -iu boop
git clone https://github.com/<you>/boop-agent.git ~/boop-agent
cd ~/boop-agent
npm ci --omit=dev
```

`--omit=dev` skips Electron and the test tools; the server runs with `tsx`,
which is a regular dependency. (Use plain `npm ci` if you want to run
`npm test` on the server.)

### 3. Environment variables

The server reads `.env.local` (then `.env`) from the checkout. The easiest
route is to copy the values from your Mac's `.env.local` over SSH (e.g.
`scp`), then change what differs on the server:

```bash
cp .env.example .env.local
chmod 600 .env.local
nano .env.local
```

| Variable | On the server |
| --- | --- |
| `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL` | Same as your Mac to keep the same memory and settings (see step 5). |
| `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER` | Same as your Mac. |
| `PUBLIC_URL` | `https://boop.example.com` — the HTTPS URL of the reverse proxy. A non-localhost value also makes Boop register the Composio webhook at boot. |
| `PORT` | `3456` (default). Only the reverse proxy talks to it. |
| `BOOP_USER_PHONE` | Your number, for proactive notices. |
| `COMPOSIO_API_KEY` | Same as your Mac. |
| `BOOP_RUNTIME`, `BOOP_MODEL` | As on your Mac. |
| `ANTHROPIC_API_KEY` | Optional; only if you use an API key instead of a Claude login (step 4). |
| `BOOP_APPLE_*`, `BOOP_BROWSER_*` | Leave out; they are ignored on Linux. |
| `BOOP_SOURCE_DIR`, `BOOP_OWNER_NUMBERS` | Leave out; self-build's restart is Mac-only. |

Keep `.env.local` readable only by the `boop` user and never commit it.

### 4. Sign in to Claude (once)

Boop uses the Claude Agent SDK, which reads the login stored in the `boop`
user's `~/.claude`. Pick one:

- **Claude subscription** — install the CLI and log in. On a headless server
  the CLI prints a URL; open it on any device, approve, and paste the code back.

  ```bash
  sudo npm install -g @anthropic-ai/claude-code
  sudo -iu boop
  claude          # then run /login inside it, finish, and /exit
  ```

  Alternatively run `claude setup-token` on any machine and put the token in
  `.env.local` as `CLAUDE_CODE_OAUTH_TOKEN=...`.

- **API key** — set `ANTHROPIC_API_KEY=...` in `.env.local` instead.

If you use the Codex runtime (`BOOP_RUNTIME=codex`), install the Codex CLI and
run `codex login --device-auth` as the `boop` user.

### 5. Convex

Boop's data (memory, conversations, automations, settings) lives in Convex.
**Point the server at the same deployment as your Mac** so it keeps your memory.

The server needs the generated Convex client in `convex/_generated/` (it is
not committed). As the `boop` user, in the checkout:

```bash
npx convex login          # prints a URL + code; works without a browser on the server
npx convex dev --once     # uses CONVEX_DEPLOYMENT from .env.local, pushes functions, writes convex/_generated
```

Don't leave `npx convex dev` running on the server: it watches files and is
meant for development. Run `npx convex dev --once` again after each update.

If you'd rather not log in to Convex on the server, create a deploy key in the
Convex dashboard (Settings → Deploy keys) and run
`CONVEX_DEPLOY_KEY=... npx convex deploy` instead (for a production
deployment, set `VITE_CONVEX_URL` to that deployment's URL).

### 6. Reverse proxy with TLS

Boop listens on port `3456` (`PORT`). Put a TLS proxy in front of it and keep
that port closed to the internet. Boop only answers three routes to non-local callers
(`GET /health`, `POST /sendblue/webhook`, `POST /composio/webhook`); the
configs below also expose only those.

**Caddy** (automatic Let's Encrypt certificates) — `/etc/caddy/Caddyfile`:

```caddy
boop.example.com {
	@boop path /health /sendblue/webhook /composio/webhook
	handle @boop {
		reverse_proxy 127.0.0.1:3456
	}
	handle {
		respond 404
	}
}
```

```bash
sudo apt-get install -y caddy   # after adding Caddy's apt repo: https://caddyserver.com/docs/install#debian-ubuntu-raspbian
sudo systemctl reload caddy
```

**nginx + certbot** — `/etc/nginx/sites-available/boop`:

```nginx
server {
    listen 80;
    server_name boop.example.com;

    location ~ ^/(health|sendblue/webhook|composio/webhook)$ {
        proxy_pass http://127.0.0.1:3456;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 5m;
    }

    location / {
        return 404;
    }
}
```

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo ln -s /etc/nginx/sites-available/boop /etc/nginx/sites-enabled/boop
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d boop.example.com --redirect -m you@example.com --agree-tos
```

Firewall: allow only SSH and the web ports; keep `3456` closed.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

### 7. systemd service

`/etc/systemd/system/boop.service`:

```ini
[Unit]
Description=Boop personal agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=boop
Group=boop
WorkingDirectory=/home/boop/boop-agent
Environment=HOME=/home/boop
ExecStartPre=/usr/bin/node scripts/preflight.mjs
ExecStart=/usr/bin/node node_modules/tsx/dist/cli.mjs server/index.ts
Restart=always
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now boop
systemctl status boop
journalctl -u boop -f          # live logs
curl -s https://boop.example.com/health
```

`Restart=always` brings Boop back after a crash, an out-of-memory kill or a
reboot; `systemctl stop boop` still stops it.

### 8. Point Sendblue at the server

With the service running and `https://boop.example.com/health` answering:

```bash
sudo -iu boop
cd ~/boop-agent
npm run sendblue:webhook -- https://boop.example.com/sendblue/webhook
npm run sendblue:webhook:check -- https://boop.example.com/sendblue/webhook
```

This registers the URL as Sendblue's receive webhook with the signing secret
Boop verifies, and removes stale ngrok / Cloudflare quick-tunnel webhooks (for
example the one your Mac registered). Then remove any other receive webhook
that points at your Mac in the Sendblue dashboard. Text Boop to test.

The Composio webhook (proactive Gmail/Slack) is pointed at
`PUBLIC_URL/composio/webhook` automatically when the server starts.

## Run only one Boop

Sendblue delivers each text to **every** registered receive webhook, and every
running Boop runs the automations and heartbeats it finds in the shared Convex
deployment. Two running instances therefore mean double replies and
automations that fire twice. Composio also keeps a single webhook URL, so
whichever instance started last receives proactive email/Slack events.

While the server is live:

- Quit Boop on your Mac (desktop app and `npm run dev`). If you do start it
  locally for development, set `SENDBLUE_AUTO_WEBHOOK=false` and
  `COMPOSIO_AUTO_WEBHOOK=false` and keep `PUBLIC_URL` at `http://localhost:3456`
  in the Mac's `.env.local` first, so starting it does not take the webhooks
  back from the server — and still stop the server
  (`sudo systemctl stop boop`) if the local copy uses the same Convex
  deployment, because automations would otherwise run in both places.
- Keep exactly one receive webhook in Sendblue: the server's.

To move back to the Mac: `sudo systemctl disable --now boop`, then start Boop
on the Mac (its `npm run dev` re-registers its own webhooks unless you turned
that off).

## Using the dashboard

The dashboard is not exposed publicly. To use it, run the Vite dashboard on the
server and reach it through an SSH tunnel:

```bash
# on the server, as boop, in the checkout
npx vite --config debug/vite.config.ts --host 127.0.0.1
# on your laptop
ssh -L 5173:127.0.0.1:5173 you@your-server
# then open http://localhost:5173
```

Settings show no Local browser or Apple data sections on the server; that's expected.

## Updating

```bash
sudo -iu boop
cd ~/boop-agent
git pull
npm ci --omit=dev
npx convex dev --once      # if Convex functions changed
exit
sudo systemctl restart boop
```

## Docker (optional)

A `Dockerfile` and `docker-compose.yml` are included for those who prefer
containers. They run the same server; you still provide `.env.local`, the
Claude login (or `ANTHROPIC_API_KEY`), Convex codegen and a TLS proxy.

```bash
# once: generate convex/_generated on the host (step 5), then
docker compose build
docker compose run --rm boop claude    # optional: /login once; stored in the boop-claude volume
docker compose up -d
docker compose logs -f
```

The compose file publishes the port on `127.0.0.1:3456` only, so put Caddy or
nginx on the host in front of it as in step 6. Use either Docker or the
systemd service, not both.

## Troubleshooting

- **`Convex types haven't been generated yet`** — run `npx convex dev --once` (step 5).
- **Service restarts in a loop** — `journalctl -u boop -n 100`. Usually a
  missing `.env.local` value or no Claude login for the `boop` user.
- **Killed / out of memory** — check `free -h`; make sure swap exists, or set
  `VOYAGE_API_KEY` / `OPENAI_API_KEY` so Boop does not load the local
  embedding model.
- **No replies** — `npm run sendblue:webhook:check -- https://boop.example.com/sendblue/webhook`,
  and `curl https://boop.example.com/health` from outside the server.
- **Double replies** — another instance (usually the Mac) is still receiving
  the webhook. See [Run only one Boop](#run-only-one-boop).
