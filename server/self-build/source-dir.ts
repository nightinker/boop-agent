import { existsSync } from "node:fs";
import { join } from "node:path";

/** Boop's git checkout for self-builds (BOOP_SOURCE_DIR), when it really is one. */
export function sourceDir(): string | null {
  const dir = process.env.BOOP_SOURCE_DIR;
  return dir && existsSync(join(dir, ".git")) ? dir : null;
}
