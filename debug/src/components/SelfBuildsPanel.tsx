import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { BrailleIndicator } from "../lib/branding.js";
import {
  EmptyState,
  HeaderPill,
  PanelPage,
  mutedTextClass,
  panelCardClass,
  subtlePanelClass,
} from "./PanelPrimitives.js";
import {
  STATUS_META,
  activityTail,
  currentBuildId,
  dashboardBuilds,
  elapsedMs,
  failureDetails,
  formatAgo,
  formatDuration,
  isActive,
  isOngoing,
  prNumber,
  type SelfBuildRow,
  type StatusTone,
} from "../lib/selfBuilds.js";

type Build = SelfBuildRow & { queuePosition?: number };

const TONE_CLASSES: Record<StatusTone, { dot: string; text: string }> = {
  waiting: { dot: "bg-amber-400", text: "text-amber-400" },
  active: { dot: "bg-sky-400", text: "text-sky-400" },
  ready: { dot: "bg-violet-400", text: "text-violet-400" },
  done: { dot: "bg-emerald-400", text: "text-emerald-500" },
  failed: { dot: "bg-rose-400", text: "text-rose-400" },
  muted: { dot: "bg-zinc-500", text: "text-zinc-500" },
};

/** Re-renders every second while something is ticking, so elapsed times stay live. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  return now;
}

export function SelfBuildsPanel({ isDark }: { isDark: boolean }) {
  // Convex queries are live: rows update here as soon as the build writes them.
  const data = useQuery(api.selfBuilds.forDashboard, { limit: 25 }) as
    | { recent: SelfBuildRow[]; queued: SelfBuildRow[] }
    | undefined;
  const builds: Build[] = data ? dashboardBuilds(data.recent, data.queued) : [];
  const now = useNow(builds.some((b) => isOngoing(b.status)));
  const current = currentBuildId(builds);
  const activeCount = builds.filter((b) => isActive(b.status)).length;
  const queuedCount = builds.filter((b) => b.status === "queued").length;

  return (
    <PanelPage
      eyebrow="Self-builds"
      title="Self-builds"
      description="Features Boop is building into itself. Updates live."
      stat={
        data && (
          <HeaderPill isDark={isDark}>
            {activeCount} active · {queuedCount} queued
          </HeaderPill>
        )
      }
    >
      {data === undefined ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className={panelCardClass(isDark, "h-28 shimmer")} />
          ))}
        </div>
      ) : builds.length === 0 ? (
        <EmptyState isDark={isDark}>
          No self-builds yet. Text Boop something like “add a feature that…” to start one.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {builds.map((build) => (
            <BuildCard
              key={build.buildId}
              build={build}
              isDark={isDark}
              now={now}
              highlighted={build.buildId === current}
            />
          ))}
        </div>
      )}
    </PanelPage>
  );
}

function BuildCard({
  build,
  isDark,
  now,
  highlighted,
}: {
  build: Build;
  isDark: boolean;
  now: number;
  highlighted: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[build.status] ?? { label: build.status, tone: "muted" as StatusTone };
  const tone = TONE_CLASSES[meta.tone];
  const failure = failureDetails(build);
  const running = isActive(build.status);
  const activity = running ? activityTail(build.activity) : [];
  const muted = mutedTextClass(isDark);
  const ongoing = isOngoing(build.status);
  const pr = build.prUrl ? prNumber(build.prUrl) : null;

  return (
    <article
      data-current={highlighted || undefined}
      className={panelCardClass(
        isDark,
        `min-w-0 p-4 fade-in ${highlighted ? (isDark ? "ring-1 ring-sky-400/60" : "ring-1 ring-sky-500/50") : ""}`,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={`flex items-center gap-1.5 text-xs font-medium ${tone.text}`}>
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {running && (
              <span className={`absolute inline-flex h-full w-full rounded-full pulse-ring ${tone.dot}`} />
            )}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${tone.dot}`} />
          </span>
          {meta.label}
          {running && <BrailleIndicator className="ml-1" />}
          {build.status === "queued" && build.queuePosition !== undefined && (
            <span className={muted}>
              · {build.queuePosition === 1 ? "next up" : `#${build.queuePosition} in line`}
            </span>
          )}
        </span>
        {highlighted && (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] ${
              isDark ? "bg-sky-400/15 text-sky-300" : "bg-sky-100 text-sky-700"
            }`}
          >
            Building now
          </span>
        )}
        {build.testsPassed === false && (
          <span className="text-[11px] text-amber-500">checks failing</span>
        )}
        <span className={`mono text-[11px] ${muted} sm:ml-auto max-md:break-all`}>{build.buildId}</span>
      </div>

      <p
        className={`mt-2 break-words text-sm ${isDark ? "text-zinc-100" : "text-zinc-900"} ${
          expanded ? "whitespace-pre-wrap" : "line-clamp-2"
        }`}
        title={expanded ? undefined : build.request}
      >
        {build.request}
      </p>
      {build.request.length > 140 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`mt-1 text-[11px] ${muted} hover:underline max-md:min-h-10 max-md:text-xs`}
        >
          {expanded ? "Show less" : "Show full request"}
        </button>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <Field label={build.status === "queued" ? "Queued" : "Started"} isDark={isDark}>
          <span title={new Date(build.createdAt).toLocaleString()}>
            {new Date(build.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </Field>
        <Field label={ongoing ? (build.status === "queued" ? "Waiting" : "Elapsed") : "Took"} isDark={isDark}>
          <span className="mono">{formatDuration(elapsedMs(build, now))}</span>
        </Field>
        <Field label="Last activity" isDark={isDark}>
          {formatAgo(Math.max(0, now - build.updatedAt))}
        </Field>
        <Field label="Pull request" isDark={isDark}>
          {build.prUrl ? (
            <a
              href={build.prUrl}
              target="_blank"
              rel="noreferrer"
              className={`${isDark ? "text-sky-300 hover:underline" : "text-sky-700 hover:underline"} max-md:-my-2 max-md:inline-block max-md:py-2`}
            >
              {pr ? `#${pr}` : "Open PR"}
            </a>
          ) : (
            <span className={muted}>None yet</span>
          )}
        </Field>
        {build.branch && (
          <Field label="Branch" isDark={isDark} wide>
            <span className="mono block truncate" title={build.branch}>
              {build.branch}
            </span>
          </Field>
        )}
      </dl>

      {activity.length > 0 ? (
        <LogBlock label="Latest activity" lines={activity.join("\n")} isDark={isDark} />
      ) : (
        running && (
          <div className="mt-3 flex items-center gap-3">
            <BrailleIndicator />
            <span className={`text-xs ${muted}`}>Waiting for activity…</span>
          </div>
        )
      )}

      {failure && (
        <div className="mt-3 space-y-2">
          <div
            className={`rounded-xl border px-3 py-2 text-xs ${
              isDark ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : "border-rose-200 bg-rose-50 text-rose-800"
            }`}
          >
            <span className="font-medium">Why it failed: </span>
            <span className="whitespace-pre-wrap break-words">{failure.reason}</span>
          </div>
          {failure.log && <LogBlock label={failure.logLabel ?? "Log"} lines={failure.log} isDark={isDark} collapsible />}
        </div>
      )}
    </article>
  );
}

function Field({
  label,
  isDark,
  wide,
  children,
}: {
  label: string;
  isDark: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2 sm:col-span-4" : ""}`}>
      <dt className={mutedTextClass(isDark)}>{label}</dt>
      <dd className={`mt-0.5 min-w-0 ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>{children}</dd>
    </div>
  );
}

function LogBlock({
  label,
  lines,
  isDark,
  collapsible,
}: {
  label: string;
  lines: string;
  isDark: boolean;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  return (
    <div className="mt-3 min-w-0">
      <button
        type="button"
        onClick={() => collapsible && setOpen((v) => !v)}
        className={`mb-1 block max-w-full truncate text-left text-[11px] ${mutedTextClass(isDark)} ${
          collapsible ? "hover:underline max-md:min-h-10 max-md:text-xs" : "cursor-default"
        }`}
      >
        {collapsible ? (open ? "▾ " : "▸ ") : ""}
        {label}
      </button>
      {open && (
        <pre
          className={subtlePanelClass(
            isDark,
            `debug-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-[11px] leading-relaxed mono max-md:max-h-80 max-md:text-xs ${
              isDark ? "text-zinc-300" : "text-zinc-700"
            }`,
          )}
        >
          {lines}
        </pre>
      )}
    </div>
  );
}
