import { z } from "zod";
import { accessConfigFromEnv } from "../cloudflare-access.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { redactSecrets } from "./redact.js";
import { secretRequests, SECRET_REQUEST_TTL_MS, type SecretRequestRegistry } from "./requests.js";
import { DEFAULT_TIMEOUT_MS, formatRunResult, runCommandWithSecrets } from "./run.js";
import {
  secretStore,
  secretsSupported,
  SECRETS_UNSUPPORTED_MESSAGE,
  validateSecretName,
  type SecretStore,
} from "./store.js";

export const SECRETS_NAMESPACE = "boop-secrets";

export const SECRETS_DISPATCHER_ALLOWED_TOOLS = [
  `mcp__${SECRETS_NAMESPACE}__request_secret`,
  `mcp__${SECRETS_NAMESPACE}__list_secrets`,
  `mcp__${SECRETS_NAMESPACE}__delete_secret`,
  `mcp__${SECRETS_NAMESPACE}__import_secrets_from_file`,
];

export const SECRETS_DISPATCHER_PROMPT = `
Secrets (API keys, tokens, passwords, env variables):
- Secret VALUES never pass through chat, you, sub-agents, memory or logs. Boop keeps them in the Mac's Keychain.
- When a task needs a credential or env var that isn't stored yet (list_secrets shows what is), call request_secret(name, description) and send the user the link it returns. They open it on the Mac (or through the private dashboard login) and type the value there. NEVER ask the user to paste a secret into chat, and never have a sub-agent derive, write, echo or save one to a file.
- To change a stored secret, call request_secret again for the same name; the user enters the new value on a fresh link.
- Sub-agents use secrets with their run_with_secrets tool: tell them the secret NAMES to use (e.g. "run the upload with run_with_secrets, secrets R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY"). Names only.
- An env file of credentials (e.g. ~/.config/boop/r2.env): import_secrets_from_file moves it into the store; pass removeFile: true when the user agrees to delete the plaintext file. Afterwards, have a sub-agent update any skill that sourced that file to use run_with_secrets with those names instead.
- delete_secret only after the user explicitly confirmed deleting that exact name in this conversation.
- If the user pastes something that looks like a key, tell them to rotate it and use request_secret instead. Never repeat it, store it, or pass it to a sub-agent.`;

export const SECRETS_EXECUTION_PROMPT = `

Secrets:
- Never print, echo, write to a file, log, encode or return a secret value. You only ever get secret NAMES.
- To run something that needs credentials, call run_with_secrets(command, secretNames): the named secrets are set as environment variables for that one command (reference them as "$NAME" in the command) and the output comes back with their values redacted. list_secrets shows which names exist.
- Don't source env files of credentials (e.g. ~/.config/boop/*.env) or read them with cat/grep; if a skill says to, use run_with_secrets with the same variable names instead.
- If a secret you need isn't stored, stop and say which NAME is missing so Boop can ask the user for it securely. Never ask the user to paste it.`;

/** Where the owner can open an entry link: the Mac itself, plus the Access-protected URL if there is one. */
export function secretEntryUrls(token: string, env: NodeJS.ProcessEnv = process.env): { local: string; remote: string | null } {
  const port = Number(env.PORT ?? 3456);
  const local = `http://localhost:${port}/secrets/enter/${token}`;
  let remote: string | null = null;
  const publicUrl = env.PUBLIC_URL?.trim();
  if (publicUrl && !/localhost|127\.0\.0\.1/.test(publicUrl) && accessConfigFromEnv(env)) {
    remote = `${publicUrl.replace(/\/+$/, "")}/secrets/enter/${token}`;
  }
  return { local, remote };
}

function formatWhen(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function describeSecrets(store: SecretStore, requests: SecretRequestRegistry): Promise<string> {
  const stored = await store.list();
  const pending = requests.pending().filter((p) => !stored.some((s) => s.name === p.name));
  if (stored.length === 0 && pending.length === 0) return "No secrets stored yet.";
  const lines = stored.map((s) => `- ${s.name}: set (updated ${formatWhen(s.updatedAt)}, ${s.backend === "keychain" ? "Keychain" : "private file"})`);
  for (const p of pending) lines.push(`- ${p.name}: not set (entry link open until ${formatWhen(p.expiresAt)})`);
  return `Secrets (names only; values are never shown):\n${lines.join("\n")}`;
}

interface SecretToolDeps {
  store?: () => SecretStore;
  requests?: SecretRequestRegistry;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

function listTool(deps: Required<Omit<SecretToolDeps, "env">>): RuntimeTool {
  return defineRuntimeTool(
    SECRETS_NAMESPACE,
    "list_secrets",
    "List stored secret NAMES with set/unset status and when each was last updated. Never returns values.",
    {},
    async () => {
      if (!secretsSupported(deps.platform)) return runtimeText(SECRETS_UNSUPPORTED_MESSAGE, false);
      return runtimeText(await describeSecrets(deps.store(), deps.requests));
    },
  );
}

/** The dispatcher's tools: ask for a secret, list, delete, import. */
export function createSecretDispatcherTools(conversationId: string, deps: SecretToolDeps = {}): RuntimeTool[] {
  const d = {
    store: deps.store ?? secretStore,
    requests: deps.requests ?? secretRequests,
    platform: deps.platform ?? process.platform,
  };
  const env = deps.env ?? process.env;
  return [
    defineRuntimeTool(
      SECRETS_NAMESPACE,
      "request_secret",
      "Ask the owner for a secret (API key, token, password, env var) WITHOUT it passing through chat. Returns a one-time link (valid ~10 minutes, single use) to a page on the owner's Mac where they type the value; it goes straight into the Keychain. Send the link to the user. Also the only way to change an existing secret.",
      {
        name: z.string().describe("Env-var style name, UPPER_SNAKE_CASE, e.g. R2_SECRET_ACCESS_KEY."),
        description: z
          .string()
          .max(300)
          .describe("One line shown on the entry page: what it is and where to find it, e.g. 'Cloudflare R2 secret access key (R2 → Manage API tokens)'."),
      },
      async (args) => {
        if (!secretsSupported(d.platform)) return runtimeText(SECRETS_UNSUPPORTED_MESSAGE, false);
        const nameError = validateSecretName(args.name);
        if (nameError) return runtimeText(nameError, false);
        const exists = await d.store().has(args.name);
        const { token } = d.requests.create({
          name: args.name,
          description: redactSecrets(args.description.trim()),
          conversationId,
        });
        const urls = secretEntryUrls(token, env);
        const minutes = Math.round(SECRET_REQUEST_TTL_MS / 60_000);
        return runtimeText(
          [
            `Entry link for ${args.name}${exists ? " (replaces the stored value)" : ""}:`,
            urls.local,
            urls.remote ? `Away from the Mac (behind the dashboard login): ${urls.remote}` : null,
            `It works once, for ${minutes} minutes. The local link only opens on the Mac itself${urls.remote ? "" : " (there's no private remote link configured)"}.`,
            "Send the user the link and tell them to type the value on that page, not in chat. You'll get a message in this conversation when it's saved.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      },
    ),
    listTool(d),
    defineRuntimeTool(
      SECRETS_NAMESPACE,
      "delete_secret",
      "Delete a stored secret. Only call after the user explicitly confirmed deleting this exact name in this conversation; set confirmed: true only then.",
      {
        name: z.string(),
        confirmed: z.boolean().describe("True only if the user explicitly confirmed this deletion."),
      },
      async (args) => {
        if (!secretsSupported(d.platform)) return runtimeText(SECRETS_UNSUPPORTED_MESSAGE, false);
        const nameError = validateSecretName(args.name);
        if (nameError) return runtimeText(nameError, false);
        if (!(await d.store().has(args.name))) return runtimeText(`No secret named ${args.name}.`, false);
        if (!args.confirmed) {
          return runtimeText(`Ask the user to confirm deleting ${args.name} first, then call again with confirmed: true.`, false);
        }
        await d.store().delete(args.name);
        return runtimeText(`Deleted ${args.name}.`);
      },
    ),
    defineRuntimeTool(
      SECRETS_NAMESPACE,
      "import_secrets_from_file",
      "Move KEY=value lines from an env file on the Mac (e.g. ~/.config/boop/r2.env) into the secret store. Values are never shown. removeFile: true deletes the plaintext file after a complete import (ask the user first).",
      {
        path: z.string().describe("Path to the env file, e.g. ~/.config/boop/r2.env. Must be in the home folder."),
        names: z.array(z.string()).optional().describe("Only import these names. Omit to import all."),
        removeFile: z.boolean().optional().default(false),
      },
      async (args) => {
        if (!secretsSupported(d.platform)) return runtimeText(SECRETS_UNSUPPORTED_MESSAGE, false);
        try {
          const r = await d.store().importEnvFile(args.path, { names: args.names, removeFile: args.removeFile });
          const lines = [
            r.imported.length ? `Imported: ${r.imported.join(", ")}.` : "Nothing imported.",
            r.invalid.length ? `Skipped (name not UPPER_SNAKE_CASE): ${r.invalid.join(", ")}.` : null,
            r.empty.length ? `Skipped (empty value): ${r.empty.join(", ")}.` : null,
            r.removedFile
              ? "The plaintext file was deleted."
              : args.removeFile
                ? "The file was NOT deleted (import was partial or filtered)."
                : "The plaintext file is still there; offer to delete it (call again with removeFile: true).",
            r.imported.length
              ? `Next: have a sub-agent update any skill that sources ${args.path} to use run_with_secrets with ${r.imported.join(", ")} instead.`
              : null,
          ];
          return runtimeText(lines.filter(Boolean).join("\n"));
        } catch (err) {
          return runtimeText(`Import failed: ${err instanceof Error ? err.message : String(err)}`, false);
        }
      },
    ),
  ];
}

/** Sub-agents' tools: names in, redacted output out. */
export function createSecretExecutionTools(deps: SecretToolDeps = {}): RuntimeTool[] {
  const d = {
    store: deps.store ?? secretStore,
    requests: deps.requests ?? secretRequests,
    platform: deps.platform ?? process.platform,
  };
  return [
    defineRuntimeTool(
      SECRETS_NAMESPACE,
      "run_with_secrets",
      "Run a shell command (bash) with the named secrets set as environment variables, e.g. command 'aws s3 ls --endpoint-url \"$R2_ENDPOINT\"' with secretNames ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','R2_ENDPOINT']. Output comes back with secret values (and base64/URL-encoded forms) redacted. Never echo the variables.",
      {
        command: z.string().min(1).describe('Shell command. Reference secrets as "$NAME"; never inline values.'),
        secretNames: z.array(z.string()).describe("Names of stored secrets to inject (see list_secrets)."),
        cwd: z.string().optional().describe("Working directory. Default: home folder."),
        timeoutSeconds: z.number().int().positive().max(600).optional().describe("Default 120, max 600."),
      },
      async (args) => {
        if (!secretsSupported(d.platform)) return runtimeText(SECRETS_UNSUPPORTED_MESSAGE, false);
        const names = [...new Set(args.secretNames)];
        for (const name of names) {
          const nameError = validateSecretName(name);
          if (nameError) return runtimeText(`${name}: ${nameError}`, false);
        }
        const { values, missing } = await d.store().getMany(names);
        if (missing.length > 0) {
          return runtimeText(
            `Not stored: ${missing.join(", ")}. Stop and report that Boop needs to request ${missing.length === 1 ? "this secret" : "these secrets"} from the user (request_secret). Don't ask for the value in chat.`,
            false,
          );
        }
        const result = await runCommandWithSecrets({
          command: args.command,
          secrets: values,
          cwd: args.cwd,
          timeoutMs: args.timeoutSeconds ? args.timeoutSeconds * 1000 : DEFAULT_TIMEOUT_MS,
        });
        // Also scrub any other stored secret the command may have printed.
        const text = redactSecrets(formatRunResult(result));
        return runtimeText(text, result.exitCode === 0 && !result.timedOut);
      },
    ),
    listTool(d),
  ];
}
