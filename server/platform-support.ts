/**
 * Which host-specific features this machine can offer.
 *
 * Apple data (iMessage history, Calendar, Notes, Reminders) reads macOS
 * databases and drives macOS apps, so it only works on darwin. The local
 * Patchright browser is built around a visible Chrome window on the owner's
 * machine (login handoff, show UI), so it is also treated as Mac-only: on a
 * headless Linux server there is no screen to hand a login to.
 *
 * On any other platform these features are reported as unsupported, never
 * registered as integrations, and forced off in settings, so a VPS deploy
 * neither crashes on them nor advertises them.
 */
export interface PlatformSupport {
  platform: NodeJS.Platform;
  appleData: boolean;
  localBrowser: boolean;
}

export function getPlatformSupport(
  platform: NodeJS.Platform = process.platform,
): PlatformSupport {
  const mac = platform === "darwin";
  return { platform, appleData: mac, localBrowser: mac };
}

export function isAppleDataSupported(platform: NodeJS.Platform = process.platform): boolean {
  return getPlatformSupport(platform).appleData;
}

export function isLocalBrowserSupported(platform: NodeJS.Platform = process.platform): boolean {
  return getPlatformSupport(platform).localBrowser;
}

export const APPLE_DATA_UNSUPPORTED_MESSAGE =
  "Apple data (iMessage history, Calendar, Notes, Reminders) is only available when Boop runs on macOS.";

export const LOCAL_BROWSER_UNSUPPORTED_MESSAGE =
  "Local browser use is only available when Boop runs on macOS.";

/**
 * A line for the interaction agent's system prompt on hosts without the
 * Mac-only features, so it does not tell the owner to "turn them on in
 * Settings" when they cannot exist here. Empty on macOS.
 */
export function hostPlatformPromptNote(platform: NodeJS.Platform = process.platform): string {
  const support = getPlatformSupport(platform);
  const missing: string[] = [];
  if (!support.appleData) missing.push('Apple data ("apple": iMessage history, Calendar, Notes, Reminders)');
  if (!support.localBrowser) missing.push('the local browser ("browser")');
  if (missing.length === 0) return "";
  return `\n\nHost note: Boop is running on a ${platform} server, not the owner's Mac, so ${missing.join(" and ")} cannot be used here and will not appear in the integration list. If the owner asks for them, say they only work when Boop runs on their Mac; do not tell them to enable it in Settings. Use Composio integrations (e.g. Gmail, Google Calendar) instead where they fit.`;
}
