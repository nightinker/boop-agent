import { createAppleMcp, createAppleTools } from "../apple/tools.js";
import { getAppleSettings } from "../runtime-config.js";
import { isAppleDataSupported } from "../platform-support.js";
import { registerIntegration } from "./registry.js";

export function registerAppleIntegration(
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isAppleDataSupported(platform)) {
    console.log(`[apple] skipped Apple data integration (macOS only; running on ${platform})`);
    return false;
  }
  registerIntegration({
    name: "apple",
    description:
      "Read-only Apple data from the user's Mac: iMessage history, Apple Notes, and Apple Reminders via the local server, plus Apple Calendar events via the optional Apple bridge.",
    isEnabled: async () => (await getAppleSettings()).enabled,
    createServer: async () => createAppleMcp(),
    createTools: async () => createAppleTools(),
  });
  console.log("[apple] registered Apple data integration");
  return true;
}
