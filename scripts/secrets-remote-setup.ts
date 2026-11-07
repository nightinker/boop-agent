/**
 * Sets up remote secret entry outside Boop.app, so it survives restarts:
 *
 *   1. writes ~/.config/boop/secrets-remote.json (public base URL + port);
 *   2. with --tunnel, writes a cloudflared config for just that hostname and a
 *      launchd LaunchAgent that keeps the tunnel running (starts at login,
 *      restarted if it dies), and with --load starts it now.
 *
 * It never touches the passcode: set SECRETS_PORTAL_PASSCODE through
 * request_secret on the Mac. No secret values are read or printed.
 *
 *   npm run secrets:remote-setup -- --url https://secret.example.com
 *   npm run secrets:remote-setup -- --url https://secret.example.com --tunnel boop-secrets --load
 *
 * Options: --port <n> (default 3457), --cloudflared <path>,
 * --credentials-file <path> (default: looked up via `cloudflared tunnel list`),
 * --dry-run (print what would be written).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SECRETS_REMOTE_PORT,
  parseSecretsPublicConfig,
  secretsRemoteConfigPath,
} from "../server/secrets/remote-config.js";
import {
  cloudflaredLaunchAgentPlist,
  cloudflaredSecretsConfig,
  SECRETS_TUNNEL_LABEL,
} from "../server/secrets/tunnel-launchd.js";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function findCloudflared(explicit: string | undefined): string | null {
  if (explicit) return existsSync(explicit) ? path.resolve(explicit) : null;
  for (const p of ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]) if (existsSync(p)) return p;
  try {
    const found = execFileSync("/usr/bin/which", ["cloudflared"], { encoding: "utf8" }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function tunnelId(cloudflared: string, name: string): string | null {
  try {
    const out = execFileSync(cloudflared, ["tunnel", "list", "--output", "json", "--name", name], { encoding: "utf8" });
    const list = JSON.parse(out) as Array<{ id?: string; name?: string }>;
    return list.find((t) => t.name === name)?.id ?? null;
  } catch {
    return null;
  }
}

function write(file: string, content: string, mode: number, dryRun: boolean): void {
  if (dryRun) {
    console.log(`\n--- ${file} ---\n${content}`);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode });
  console.log(`Wrote ${file}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const url = arg(args, "--url");
  const portRaw = arg(args, "--port") ?? String(DEFAULT_SECRETS_REMOTE_PORT);
  if (!url) {
    console.error("Usage: npm run secrets:remote-setup -- --url https://secret.example.com [--port 3457] [--tunnel <name> [--load]]");
    process.exit(2);
  }
  const parsed = parseSecretsPublicConfig({ baseUrl: url, port: portRaw }, { baseUrl: "--url", port: "--port" });
  if (!parsed.ok) {
    console.error(parsed.reason ?? "--url is empty");
    process.exit(2);
  }
  const { config } = parsed;
  const port = config.port ?? DEFAULT_SECRETS_REMOTE_PORT;
  const configPath = secretsRemoteConfigPath(process.env);
  if (!configPath) {
    console.error("HOME isn't set; set BOOP_SECRETS_REMOTE_CONFIG to the config file path.");
    process.exit(1);
  }
  write(configPath, `${JSON.stringify({ publicBaseUrl: config.baseUrl, port }, null, 2)}\n`, 0o600, dryRun);

  const tunnel = arg(args, "--tunnel");
  if (tunnel) {
    const cloudflared = findCloudflared(arg(args, "--cloudflared"));
    if (!cloudflared) {
      console.error("cloudflared not found. Install it (brew install cloudflared) or pass --cloudflared <path>.");
      process.exit(1);
    }
    const home = os.homedir();
    let credentialsFile = arg(args, "--credentials-file");
    let tunnelRef = tunnel;
    if (!credentialsFile) {
      const id = tunnelId(cloudflared, tunnel);
      if (!id) {
        console.error(
          `No Cloudflare tunnel named ${tunnel}. Create it first:\n  cloudflared tunnel login\n  cloudflared tunnel create ${tunnel}\n  cloudflared tunnel route dns ${tunnel} ${config.host}\nthen run this again (or pass --credentials-file).`,
        );
        process.exit(1);
      }
      tunnelRef = id;
      credentialsFile = path.join(home, ".cloudflared", `${id}.json`);
    }
    if (!existsSync(credentialsFile)) console.warn(`Warning: ${credentialsFile} doesn't exist yet; the tunnel won't start without it.`);
    const cfConfigPath = path.join(home, ".cloudflared", "boop-secrets.yml");
    const plistPath = path.join(home, "Library", "LaunchAgents", `${SECRETS_TUNNEL_LABEL}.plist`);
    const logPath = path.join(home, "Library", "Logs", "boop-secrets-tunnel.log");
    write(cfConfigPath, cloudflaredSecretsConfig({ tunnel: tunnelRef, credentialsFile, hostname: config.host, port }), 0o600, dryRun);
    write(plistPath, cloudflaredLaunchAgentPlist({ cloudflaredPath: cloudflared, configPath: cfConfigPath, logPath }), 0o644, dryRun);
    const domain = `gui/${process.getuid?.() ?? "$(id -u)"}`;
    if (args.includes("--load") && !dryRun) {
      try {
        execFileSync("/bin/launchctl", ["bootout", `${domain}/${SECRETS_TUNNEL_LABEL}`], { stdio: "ignore" });
      } catch {
        // Not loaded yet.
      }
      execFileSync("/bin/launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
      console.log(`Started ${SECRETS_TUNNEL_LABEL} (logs: ${logPath}).`);
    } else {
      console.log(`\nStart the tunnel (and on every login after that):\n  launchctl bootstrap ${domain} ${plistPath}`);
    }
  }

  console.log(
    `\nNext:\n  - Restart Boop once so it reads ${configPath}.\n  - If the passcode isn't set yet, ask Boop to "request the secret SECRETS_PORTAL_PASSCODE" and open the LOCAL link on the Mac.\n  - Ask Boop for get_config: remoteSecretEntry shows the listener and tunnel state.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
