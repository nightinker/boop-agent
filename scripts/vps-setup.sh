#!/usr/bin/env bash
# Sets up Boop to run headless on a fresh Ubuntu server (22.04 / 24.04, 2 GB+ RAM).
#
#   sudo bash scripts/vps-setup.sh --domain boop.example.com
#
# Installs Node.js, creates a `boop` user, installs dependencies, sets up a
# TLS reverse proxy (Caddy by default), a firewall and a systemd service.
# Safe to re-run. It never prints or overwrites values in .env.local; it only
# creates the file from .env.example when missing and sets PUBLIC_URL.
#
# Some steps stay manual (they need your accounts): filling in .env.local, the
# one-time Claude login, Convex codegen and pointing Sendblue at the server.
# The script prints them at the end. Full guide: docs/DEPLOY-VPS.md
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sudo bash scripts/vps-setup.sh --domain <domain> [options]

  --domain <name>       Public domain pointing at this server (needed for HTTPS).
  --user <name>         System user that runs Boop (default: boop).
  --dir <path>          Checkout location (default: /home/<user>/boop-agent).
  --repo <url>          Git URL to clone when the checkout does not exist yet
                        (default: the origin of the checkout this script is in).
  --branch <name>       Branch to clone (default: the remote's default branch).
  --proxy <kind>        caddy (default), nginx, or none.
  --email <address>     Contact email for Let's Encrypt (used by certbot with nginx).
  --node-major <n>      Node.js major version to install (default: 22).
  --no-swap             Do not create a swap file.
  --no-firewall         Do not configure ufw.
  --no-claude-cli       Do not install the Claude Code CLI.
  -h, --help            Show this help.
USAGE
}

DOMAIN=""
BOOP_USER="boop"
APP_DIR=""
REPO_URL=""
BRANCH=""
PROXY="caddy"
EMAIL=""
NODE_MAJOR="22"
WITH_SWAP=1
WITH_FIREWALL=1
WITH_CLAUDE_CLI=1
PORT_NUM="3456"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --user) BOOP_USER="${2:-}"; shift 2 ;;
    --dir) APP_DIR="${2:-}"; shift 2 ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --proxy) PROXY="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --node-major) NODE_MAJOR="${2:-}"; shift 2 ;;
    --no-swap) WITH_SWAP=0; shift ;;
    --no-firewall) WITH_FIREWALL=0; shift ;;
    --no-claude-cli) WITH_CLAUDE_CLI=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || die "This script is for Linux servers. On a Mac, use npm run setup."
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash scripts/vps-setup.sh ..."
case "$PROXY" in caddy|nginx|none) ;; *) die "--proxy must be caddy, nginx or none" ;; esac
[[ "$BOOP_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "Invalid --user: $BOOP_USER"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || die "Invalid --node-major: $NODE_MAJOR"
if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then die "Invalid --domain: $DOMAIN"; fi
if [[ "$PROXY" != "none" && -z "$DOMAIN" ]]; then
  die "--domain is required for HTTPS (or pass --proxy none to set up the proxy yourself)."
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" ]] || warn "Tested on Ubuntu; detected ${PRETTY_NAME:-unknown}. Continuing."
fi

MEM_MB=$(awk '/MemTotal/ { printf "%d", $2 / 1024 }' /proc/meminfo)
if (( MEM_MB < 1800 )); then
  warn "Only ${MEM_MB} MB RAM. Boop needs about 2 GB; expect swapping or out-of-memory restarts."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_CHECKOUT=""
if [[ -f "$SCRIPT_DIR/../package.json" ]] && git -C "$SCRIPT_DIR/.." rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SOURCE_CHECKOUT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
BOOP_HOME="/home/$BOOP_USER"
APP_DIR="${APP_DIR:-$BOOP_HOME/boop-agent}"

export DEBIAN_FRONTEND=noninteractive

step "Installing system packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git build-essential ufw debian-keyring debian-archive-keyring apt-transport-https

step "Installing Node.js $NODE_MAJOR"
CURRENT_NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
fi
if (( CURRENT_NODE_MAJOR < 20 )); then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  note "Node.js $(node --version) already installed"
fi
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"

if (( WITH_SWAP )); then
  step "Checking swap"
  if [[ -z "$(swapon --show --noheadings 2>/dev/null)" ]]; then
    if [[ ! -f /swapfile ]]; then
      fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
      chmod 600 /swapfile
      mkswap /swapfile
    fi
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    note "Added a 2 GB swap file"
  else
    note "Swap already enabled"
  fi
fi

step "Creating user $BOOP_USER"
if id "$BOOP_USER" >/dev/null 2>&1; then
  note "User exists"
else
  adduser --system --group --home "$BOOP_HOME" --shell /bin/bash "$BOOP_USER"
fi
mkdir -p "$BOOP_HOME"
chown "$BOOP_USER:$BOOP_USER" "$BOOP_HOME"

as_boop() { sudo -u "$BOOP_USER" -H bash -lc "$1"; }

step "Preparing the checkout at $APP_DIR"
if [[ -f "$APP_DIR/package.json" ]]; then
  note "Checkout exists"
elif [[ -n "$SOURCE_CHECKOUT" && -z "$REPO_URL" ]]; then
  mkdir -p "$(dirname "$APP_DIR")"
  cp -a "$SOURCE_CHECKOUT" "$APP_DIR"
  note "Copied $SOURCE_CHECKOUT"
else
  if [[ -z "$REPO_URL" && -n "$SOURCE_CHECKOUT" ]]; then
    REPO_URL="$(git -C "$SOURCE_CHECKOUT" remote get-url origin 2>/dev/null || true)"
  fi
  [[ -n "$REPO_URL" ]] || die "No checkout at $APP_DIR. Pass --repo <git url>."
  mkdir -p "$(dirname "$APP_DIR")"
  if [[ -n "$BRANCH" ]]; then
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  else
    git clone "$REPO_URL" "$APP_DIR"
  fi
fi
chown -R "$BOOP_USER:$BOOP_USER" "$APP_DIR"
git config --system --add safe.directory "$APP_DIR" 2>/dev/null || true
APP_DIR_Q=$(printf '%q' "$APP_DIR")

step "Installing npm dependencies (production only)"
as_boop "cd $APP_DIR_Q && $NPM_BIN ci --omit=dev --no-audit --no-fund"

if (( WITH_CLAUDE_CLI )); then
  step "Installing the Claude Code CLI (for the one-time login)"
  if command -v claude >/dev/null 2>&1; then
    note "claude already installed"
  else
    "$NPM_BIN" install -g @anthropic-ai/claude-code --no-audit --no-fund
  fi
fi

step "Preparing .env.local"
ENV_FILE="$APP_DIR/.env.local"
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 600 -o "$BOOP_USER" -g "$BOOP_USER" "$APP_DIR/.env.example" "$ENV_FILE"
  note "Created .env.local from .env.example; fill in your values."
else
  chmod 600 "$ENV_FILE"
  chown "$BOOP_USER:$BOOP_USER" "$ENV_FILE"
  note ".env.local exists; leaving your values alone."
fi
if [[ -n "$DOMAIN" ]]; then
  if grep -q '^PUBLIC_URL=' "$ENV_FILE"; then
    sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$ENV_FILE"
  else
    printf '\nPUBLIC_URL=https://%s\n' "$DOMAIN" >> "$ENV_FILE"
  fi
  note "PUBLIC_URL=https://$DOMAIN"
fi
CONFIGURED_PORT=$(grep -E '^PORT=[0-9]+' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true)
PORT_NUM="${CONFIGURED_PORT:-$PORT_NUM}"

case "$PROXY" in
  caddy)
    step "Setting up Caddy (automatic HTTPS) for $DOMAIN"
    if ! command -v caddy >/dev/null 2>&1; then
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list
      apt-get update -y
      apt-get install -y caddy
    fi
    CADDYFILE=/etc/caddy/Caddyfile
    if [[ -f "$CADDYFILE" ]] && ! grep -q 'Managed by boop vps-setup' "$CADDYFILE"; then
      cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)"
    fi
    cat > "$CADDYFILE" <<CADDY
# Managed by boop vps-setup.sh. Only Boop's public routes are exposed.
$DOMAIN {
	@boop path /health /sendblue/webhook /composio/webhook
	handle @boop {
		reverse_proxy 127.0.0.1:$PORT_NUM
	}
	handle {
		respond 404
	}
}
CADDY
    caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
    systemctl enable caddy >/dev/null
    systemctl reload caddy || systemctl restart caddy
    ;;
  nginx)
    step "Setting up nginx + certbot for $DOMAIN"
    apt-get install -y nginx certbot python3-certbot-nginx
    cat > /etc/nginx/sites-available/boop <<NGINX
# Managed by boop vps-setup.sh. Only Boop's public routes are exposed.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location ~ ^/(health|sendblue/webhook|composio/webhook)\$ {
        proxy_pass http://127.0.0.1:$PORT_NUM;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        client_max_body_size 5m;
    }

    location / {
        return 404;
    }
}
NGINX
    ln -sf /etc/nginx/sites-available/boop /etc/nginx/sites-enabled/boop
    rm -f /etc/nginx/sites-enabled/default
    nginx -t
    systemctl enable nginx >/dev/null
    systemctl reload nginx || systemctl restart nginx
    if [[ -n "$EMAIL" ]]; then
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
        || warn "certbot failed. Check that $DOMAIN points at this server, then re-run certbot."
    else
      warn "No --email given; get a certificate with: certbot --nginx -d $DOMAIN --redirect"
    fi
    ;;
  none)
    step "Skipping the reverse proxy (--proxy none)"
    note "Put a TLS proxy in front of 127.0.0.1:$PORT_NUM yourself (see docs/DEPLOY-VPS.md)."
    ;;
esac

if (( WITH_FIREWALL )); then
  step "Configuring the firewall (SSH, 80, 443 only)"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  note "Port $PORT_NUM stays closed; the proxy reaches Boop on localhost."
fi

step "Installing the systemd service"
cat > /etc/systemd/system/boop.service <<UNIT
# Managed by boop vps-setup.sh
[Unit]
Description=Boop personal agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=$BOOP_USER
Group=$BOOP_USER
WorkingDirectory=$APP_DIR
Environment=HOME=$BOOP_HOME
Environment=PATH=$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin
ExecStartPre=$NODE_BIN scripts/preflight.mjs
ExecStart=$NODE_BIN node_modules/tsx/dist/cli.mjs server/index.ts
Restart=always
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable boop >/dev/null

# Start only once the pieces Boop cannot boot without are in place.
READY=1
[[ -f "$APP_DIR/convex/_generated/api.js" ]] || READY=0
grep -Eq '^(VITE_CONVEX_URL|CONVEX_URL)=.+' "$ENV_FILE" || READY=0
grep -Eq '^SENDBLUE_API_KEY=.+' "$ENV_FILE" || READY=0

if (( READY )); then
  systemctl restart boop
  step "Boop is running"
  note "Logs: journalctl -u boop -f"
else
  step "Almost done: finish these steps, then start Boop"
fi

cat <<NEXT

  1. Fill in $ENV_FILE (Convex, Sendblue, Composio, BOOP_USER_PHONE).
     Copying the values from your Mac's .env.local keeps the same memory.
       sudo -iu $BOOP_USER nano $ENV_FILE

  2. Sign in to Claude once as $BOOP_USER (or set ANTHROPIC_API_KEY in .env.local):
       sudo -iu $BOOP_USER claude        # run /login, then /exit

  3. Generate the Convex client (uses CONVEX_DEPLOYMENT from .env.local):
       sudo -iu $BOOP_USER bash -lc 'cd $APP_DIR_Q && npx convex login && npx convex dev --once'

  4. Start Boop and check it:
       sudo systemctl restart boop && journalctl -u boop -f
       curl -s https://${DOMAIN:-<your-domain>}/health

  5. Point Sendblue at this server (then stop Boop on your Mac):
       sudo -iu $BOOP_USER bash -lc 'cd $APP_DIR_Q && npm run sendblue:webhook -- https://${DOMAIN:-<your-domain>}/sendblue/webhook'

  Only one Boop may receive the Sendblue webhook at a time, or replies and
  automations happen twice. On this server Apple data and the local browser are
  off; Composio integrations, memory and iMessage chat keep working.
  Guide: $APP_DIR/docs/DEPLOY-VPS.md
NEXT
