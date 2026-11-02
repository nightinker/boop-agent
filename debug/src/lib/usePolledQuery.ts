import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

/**
 * Runs a Convex query now and then every `intervalMs` while the page is
 * visible, instead of keeping a live subscription.
 *
 * Use it for heavy summary queries (counts, dashboard stats) that scan many
 * documents. A live `useQuery` re-runs on every write to the tables it reads,
 * which for these means every message or memory saved; Convex bills each
 * re-run's reads, so a dashboard left open could read gigabytes a day.
 */
export function usePolledQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
  intervalMs: number,
): FunctionReturnType<Query> | undefined {
  const convex = useConvex();
  const [data, setData] = useState<FunctionReturnType<Query> | undefined>(undefined);
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.visibilityState === "hidden") return;
      convex
        .query(query, JSON.parse(argsKey) as FunctionArgs<Query>)
        .then((result) => {
          if (!cancelled) setData(result);
        })
        .catch(() => {
          // Keep the last value; the next tick tries again.
        });
    };
    load();
    const timer = window.setInterval(load, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [convex, query, argsKey, intervalMs]);

  return data;
}
