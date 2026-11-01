import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import {
  EmptyState,
  HeaderPill,
  PanelPage,
  mutedTextClass,
  panelCardClass,
} from "./PanelPrimitives.js";

const EVENT_COLOR: Record<string, string> = {
  "memory.written": "bg-emerald-500/20 text-emerald-400",
  "memory.recalled": "bg-sky-500/20 text-sky-400",
  "memory.extracted": "bg-violet-500/20 text-violet-400",
  "memory.consolidated": "bg-amber-500/20 text-amber-400",
  "memory.promoted": "bg-emerald-500/20 text-emerald-400",
  "memory.merged": "bg-cyan-500/20 text-cyan-400",
  "memory.pruned": "bg-rose-500/20 text-rose-400",
  "memory.cleaned": "bg-zinc-500/20 text-zinc-400",
  "consolidation.proposed": "bg-amber-500/20 text-amber-400",
  "consolidation.applied": "bg-lime-500/20 text-lime-500",
};

export function EventsPanel({ isDark }: { isDark: boolean }) {
  const events = useQuery(api.memoryEvents.recentForDashboard, { limit: 200 });
  const muted = mutedTextClass(isDark);
  const list = events ?? [];

  return (
    <PanelPage
      eyebrow="Memory stream"
      title="Events"
      description="Recent memory writes, recalls, extraction, cleanup, and consolidation activity."
      stat={<HeaderPill isDark={isDark}>{list.length} events</HeaderPill>}
    >
      {!events ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className={panelCardClass(isDark, "h-12 shimmer")} />
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState isDark={isDark}>
          No events yet. Chat with the agent to see memory events stream in.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {events.map((e) => (
            <div key={e._id} className={panelCardClass(isDark, "px-3 py-2.5")}>
              <div className="flex items-center gap-2 text-[10px] mono max-md:flex-wrap max-md:gap-y-1">
                <span
                  className={`rounded-full px-1.5 py-0.5 ${EVENT_COLOR[e.eventType] ?? "bg-zinc-500/10 text-zinc-400"}`}
                >
                  {e.eventType}
                </span>
                {e.conversationId && <span className={`${muted} max-md:min-w-0 max-md:break-all`}>{e.conversationId}</span>}
                {e.memoryId && <span className={muted}>mem:{e.memoryId.slice(-6)}</span>}
                {e.agentId && <span className={muted}>agent:{e.agentId.slice(-6)}</span>}
                <span className={`${muted} ml-auto`}>
                  {new Date(e.createdAt).toLocaleTimeString()}
                </span>
              </div>
              {e.data && (
                <div
                  className={`mt-1 break-all text-[11px] mono ${isDark ? "text-zinc-400" : "text-zinc-600"}`}
                >
                  {e.data}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PanelPage>
  );
}
