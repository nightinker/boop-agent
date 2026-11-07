// Which copy of Boop a self-build belongs to. Pure, so convex/selfBuilds.ts
// and server/self-build/run.ts share one rule.

/**
 * Whether `runner` (an instances.instanceId) is the copy running this build.
 * Builds from before runners were recorded have none; they ran on the Mac,
 * so only a copy that may claim them (`claimsUnowned`) counts them as its own.
 */
export function runsOn(build: { runner?: string }, runner: string, claimsUnowned: boolean): boolean {
  return build.runner ? build.runner === runner : claimsUnowned;
}
