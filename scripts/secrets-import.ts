/**
 * Moves an env file of credentials into Boop's secret store (macOS Keychain,
 * or a chmod 600 file under ~/.config/boop/ when the Keychain is unavailable).
 * Prints names only, never values.
 *
 *   npm run secrets:import -- ~/.config/boop/r2.env            # import, keep the file
 *   npm run secrets:import -- ~/.config/boop/r2.env --remove   # import, then delete it
 */
import { secretStore, secretsSupported, SECRETS_UNSUPPORTED_MESSAGE } from "../server/secrets/store.js";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: npm run secrets:import -- <path/to/file.env> [--remove]");
    process.exit(2);
  }
  if (!secretsSupported()) {
    console.error(SECRETS_UNSUPPORTED_MESSAGE);
    process.exit(1);
  }
  const result = await secretStore().importEnvFile(file, { removeFile: args.includes("--remove") });
  console.log(result.imported.length ? `Imported: ${result.imported.join(", ")}` : "Nothing imported.");
  if (result.invalid.length) console.log(`Skipped (name not UPPER_SNAKE_CASE): ${result.invalid.join(", ")}`);
  if (result.empty.length) console.log(`Skipped (empty value): ${result.empty.join(", ")}`);
  console.log(result.removedFile ? "Deleted the plaintext file." : "The plaintext file was left in place.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
