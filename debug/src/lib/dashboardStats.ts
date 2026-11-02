import { useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";

const REFRESH_EVERY_MS = 5 * 60_000;

/**
 * The dashboard's numbers (memory counts, agents, cost per day) from the
 * cached dashboardStats record. Subscribing to that one small record is
 * cheap; the expensive scan behind it runs at most every 10 minutes, on the
 * server, and only while some dashboard is open and asking (`refresh`).
 *
 * Pass refresh: false from components rendered inside the app shell, which
 * already keeps the record fresh.
 */
export function useDashboardStats({ refresh = true }: { refresh?: boolean } = {}) {
  const stats = useQuery(api.dashboard.cachedMetrics, {});
  const refreshMetrics = useMutation(api.dashboard.refreshMetrics);

  useEffect(() => {
    if (!refresh) return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void refreshMetrics({}).catch(() => {
        // Keep showing the cached numbers; the next tick tries again.
      });
    };
    tick();
    const timer = window.setInterval(tick, REFRESH_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, refreshMetrics]);

  return stats;
}
