/** Runs that ended without an answer; the dashboard offers Retry on these. */
export function canRetry(status: string): boolean {
  return status === "failed" || status === "cancelled";
}

/** Asks the server to re-run an agent. Resolves with the new run's id. */
export async function requestAgentRetry(agentId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/retry`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { agentId?: string; error?: string };
  if (!res.ok || !body.agentId) throw new Error(body.error || `Retry failed (${res.status})`);
  return body.agentId;
}
