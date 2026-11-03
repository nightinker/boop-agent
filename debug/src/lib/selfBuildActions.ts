/** Builds that ended without shipping; the dashboard offers Retry on these. */
export function canRetryBuild(status: string): boolean {
  return status === "failed" || status === "cancelled" || status === "rolled_back";
}

/** Builds still in progress or waiting to ship; the dashboard offers Cancel on these. */
export function canCancelBuild(status: string): boolean {
  return status === "queued" || status === "coding" || status === "testing" || status === "pr_open";
}

/** Asks the server to retry or cancel a build. Resolves with Boop's answer. */
export async function requestBuildAction(
  buildId: string,
  action: "retry" | "cancel",
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`/api/self-builds/${encodeURIComponent(buildId)}/${action}`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok || !body.message) throw new Error(body.error || `${action} failed (${res.status})`);
  return body.message;
}
