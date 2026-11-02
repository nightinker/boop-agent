import { useEffect, useRef, useState, type ReactNode } from "react";
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
  HEALTH_META,
  NODE_H,
  NODE_W,
  STEP_META,
  countsLine,
  detailPollMs,
  formatAgo,
  formatMs,
  layoutGraph,
  overviewPollMs,
  runMeta,
  timelineBars,
  type OrchestratorOverview,
  type RunDetail,
  type RunSummary,
  type StepView,
  type Tone,
} from "../lib/orchestrator.js";

// The Orchestrator tab. Everything comes from Boop's own server
// (/api/orchestrator/dashboard), which reads the Go sidecar on the page's
// behalf; the browser never talks to the sidecar. It polls: every 2s while a
// run is going, every 5s otherwise, and not at all while the tab is hidden.

const TONE: Record<Tone, { dot: string; text: string; stroke: string; bar: string }> = {
  waiting: { dot: "bg-amber-400", text: "text-amber-400", stroke: "#fbbf24", bar: "bg-amber-400/80" },
  active: { dot: "bg-sky-400", text: "text-sky-400", stroke: "#38bdf8", bar: "bg-sky-400/80" },
  done: { dot: "bg-emerald-400", text: "text-emerald-500", stroke: "#34d399", bar: "bg-emerald-400/80" },
  failed: { dot: "bg-rose-400", text: "text-rose-400", stroke: "#fb7185", bar: "bg-rose-400/80" },
  muted: { dot: "bg-zinc-500", text: "text-zinc-500", stroke: "#71717a", bar: "bg-zinc-500/60" },
};

const OVERVIEW_URL = "/api/orchestrator/dashboard";

/** Calls `tick` now and then again after whatever delay it returns (null stops). Skips while the tab is hidden. */
function usePoll(tick: () => Promise<number | null>, deps: unknown[]): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const run = async () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = window.setTimeout(run, 2_000);
        return;
      }
      const next = await tickRef.current().catch(() => 5_000);
      if (!stopped && next !== null) timer = window.setTimeout(run, next);
    };
    void run();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

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

export function OrchestratorPanel({ isDark }: { isDark: boolean }) {
  const [overview, setOverview] = useState<OrchestratorOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  usePoll(async () => {
    try {
      const res = await fetch(OVERVIEW_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`Boop answered HTTP ${res.status}`);
      const body = (await res.json()) as OrchestratorOverview;
      setOverview(body);
      setLoadError(null);
      return overviewPollMs(body);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      return 5_000;
    }
  }, []);

  // Pick a run to show: the one going now, else the newest. Keep the owner's pick.
  const runs = overview?.runs ?? [];
  const selectedId =
    selected && runs.some((r) => r.id === selected) ? selected : (runs.find((r) => !r.done) ?? runs[0])?.id ?? null;

  return (
    <OrchestratorView
      isDark={isDark}
      overview={overview}
      loadError={loadError}
      selectedId={selectedId}
      onSelect={setSelected}
      detail={selectedId ? <RunDetailLoader key={selectedId} id={selectedId} isDark={isDark} /> : null}
    />
  );
}

/** The page without the polling, so it can be rendered from fixed data. */
export function OrchestratorView({
  isDark,
  overview,
  loadError,
  selectedId,
  onSelect,
  detail,
  now: fixedNow,
}: {
  isDark: boolean;
  overview: OrchestratorOverview | null;
  loadError?: string | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  detail?: ReactNode;
  now?: number;
}) {
  const liveNow = useNow(fixedNow === undefined && !!overview?.runs.some((r) => !r.done));
  const now = fixedNow ?? liveNow;
  const sidecar = overview?.sidecar ?? null;
  const health = sidecar ? HEALTH_META[sidecar.health] : null;

  return (
    <PanelPage
      eyebrow="Orchestrator"
      title="Orchestrator"
      description="The Go orchestrator sidecar on port 3460: its health, and the plans it runs. Updates live."
      stat={
        health && (
          <HeaderPill isDark={isDark}>
            <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${TONE[health.tone].dot}`} />
            {health.label}
            {overview?.available ? ` · ${overview.totalRuns} run${overview.totalRuns === 1 ? "" : "s"}` : ""}
          </HeaderPill>
        )
      }
    >
      {overview === null ? (
        loadError ? (
          <EmptyState isDark={isDark}>
            <span data-orchestrator-state="boop-unreachable">
              Couldn’t reach Boop’s server to read the orchestrator ({loadError}). Retrying…
            </span>
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className={panelCardClass(isDark, "h-32 shimmer")} />
            ))}
          </div>
        )
      ) : (
        <div className="space-y-4">
          {sidecar && <SidecarCard overview={overview} isDark={isDark} now={now} />}
          {!overview.available ? (
            <EmptyState isDark={isDark}>
              <div data-orchestrator-state="not-running">
                <div className={`font-medium ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>Orchestrator not running</div>
                <div className="mt-1 break-words">
                  {overview.error ?? "The sidecar isn’t answering."} Boop keeps working without it; runs show up here once
                  it’s back.
                </div>
              </div>
            </EmptyState>
          ) : overview.runs.length === 0 ? (
            <EmptyState isDark={isDark}>
              No runs yet. Runs are kept in the sidecar’s memory, so they clear when it restarts. Ask Boop to orchestrate
              something with a few parallel steps to start one.
            </EmptyState>
          ) : (
            <>
              <RunList runs={overview.runs} isDark={isDark} now={now} selectedId={selectedId ?? null} onSelect={onSelect} />
              {detail}
            </>
          )}
          {loadError && (
            <p className="text-xs text-amber-500">Last refresh failed ({loadError}); showing what came back before.</p>
          )}
        </div>
      )}
    </PanelPage>
  );
}

function StatusDot({ tone, pulsing }: { tone: Tone; pulsing?: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      {pulsing && <span className={`absolute inline-flex h-full w-full rounded-full pulse-ring ${TONE[tone].dot}`} />}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${TONE[tone].dot}`} />
    </span>
  );
}

function SidecarCard({ overview, isDark, now }: { overview: OrchestratorOverview; isDark: boolean; now: number }) {
  const s = overview.sidecar;
  const meta = HEALTH_META[s.health];
  const muted = mutedTextClass(isDark);
  const backingOff = s.nextRestartInMs !== null;
  return (
    <section className={panelCardClass(isDark, "min-w-0 p-4")} data-sidecar-health={s.health}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={`flex items-center gap-1.5 text-sm font-medium ${TONE[meta.tone].text}`}>
          <StatusDot tone={meta.tone} pulsing={s.health === "starting" || s.health === "restarting"} />
          Sidecar {meta.label.toLowerCase()}
        </span>
        <span className={`text-xs ${muted}`}>
          {s.managed ? "supervised by Boop" : s.state === "external" ? "started outside Boop" : s.state === "disabled" ? "ORCHESTRATOR_SIDECAR=off" : ""}
        </span>
        <span className={`mono text-[11px] ${muted} sm:ml-auto`}>
          127.0.0.1:{s.port}
          {s.pid ? ` · pid ${s.pid}` : ""}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <Field label="Uptime" isDark={isDark}>
          <span className="mono">{s.uptimeMs !== null ? formatMs(s.uptimeMs) : "—"}</span>
        </Field>
        <Field label="Restarts" isDark={isDark}>
          <span className="mono">{s.restarts}</span>
          {backingOff && <span className="ml-1 text-amber-500">· next in {formatMs(s.nextRestartInMs)}</span>}
        </Field>
        <Field label="Anthropic key" isDark={isDark}>
          {s.keyPresent ? (
            <span className="text-emerald-500" data-key-present="true">
              Stored{s.managed && !s.keyPassed && s.health === "running" ? " (used on next restart)" : ""}
            </span>
          ) : (
            <span className="text-amber-500" data-key-present="false">
              Not stored
            </span>
          )}
        </Field>
        <Field label="Planner" isDark={isDark}>
          {s.planner === null ? <span className={muted}>—</span> : s.planner ? "On" : "Off (hand-written plans only)"}
        </Field>
        <Field label="Last health check" isDark={isDark}>
          {s.lastHealth ? (
            <span className={s.lastHealth.ok ? "" : "text-rose-400"}>
              {s.lastHealth.ok ? "ok" : "failed"}, {formatAgo(s.lastHealth.at, now)}
            </span>
          ) : (
            <span className={muted}>none yet</span>
          )}
        </Field>
        <Field label="Last exit" isDark={isDark}>
          {s.lastExit ? (
            <span>
              {s.lastExit.signal ? `signal ${s.lastExit.signal}` : `code ${s.lastExit.code}`}, {formatAgo(s.lastExit.at, now)}
            </span>
          ) : (
            <span className={muted}>—</span>
          )}
        </Field>
        <Field label="Self-test" isDark={isDark} wide>
          {s.lastSelfTest ? (
            <span className={s.lastSelfTest.ok ? "" : "text-rose-400"}>
              {s.lastSelfTest.ok ? "passed" : "failed"} {formatAgo(s.lastSelfTest.at, now)} — {s.lastSelfTest.detail}
            </span>
          ) : (
            <span className={muted}>not run yet (ask Boop “is the orchestrator working?”)</span>
          )}
        </Field>
      </dl>

      {s.problem && (
        <div
          className={`mt-3 rounded-xl border px-3 py-2 text-xs ${
            isDark ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          <span className="font-medium">Problem: </span>
          <span className="whitespace-pre-wrap break-words">{s.problem}</span>
        </div>
      )}

      <LogBlock
        label={`Last ${overview.log.length} log line${overview.log.length === 1 ? "" : "s"} · ${s.logFile.split("/").slice(-3).join("/")}`}
        lines={overview.log.length ? overview.log.join("\n") : "(log is empty)"}
        isDark={isDark}
        collapsible
      />
    </section>
  );
}

function RunList({
  runs,
  isDark,
  now,
  selectedId,
  onSelect,
}: {
  runs: RunSummary[];
  isDark: boolean;
  now: number;
  selectedId: string | null;
  onSelect?: (id: string) => void;
}) {
  const muted = mutedTextClass(isDark);
  return (
    <section className={panelCardClass(isDark, "min-w-0 overflow-hidden")}>
      <div className={`px-4 pt-3 pb-2 text-[11px] font-medium uppercase tracking-[0.08em] ${muted}`}>Recent runs</div>
      <ul className={`divide-y ${isDark ? "divide-white/5" : "divide-zinc-100"}`}>
        {runs.map((r) => {
          const meta = runMeta(r.state);
          const active = r.id === selectedId;
          const live = !r.done ? (r.createdAt ? now - r.createdAt : r.durationMs) : r.durationMs;
          return (
            <li key={r.id}>
              <button
                type="button"
                data-run-id={r.id}
                aria-pressed={active}
                onClick={() => onSelect?.(r.id)}
                className={`flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left max-md:min-h-12 ${
                  active ? (isDark ? "bg-white/5" : "bg-zinc-50") : isDark ? "hover:bg-white/[0.03]" : "hover:bg-zinc-50/60"
                }`}
              >
                <span className={`flex w-24 shrink-0 items-center gap-1.5 text-xs font-medium ${TONE[meta.tone].text}`}>
                  <StatusDot tone={meta.tone} pulsing={!r.done} />
                  {meta.label}
                </span>
                <span className={`min-w-0 flex-1 truncate text-sm ${isDark ? "text-zinc-100" : "text-zinc-900"}`} title={r.title}>
                  {r.title}
                </span>
                <span className={`text-[11px] ${muted} max-md:w-full max-md:pl-[6.75rem]`}>
                  {countsLine(r.counts)} · <span className="mono">{formatMs(live)}</span> · {formatAgo(r.createdAt, now)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RunDetailLoader({ id, isDark }: { id: string; isDark: boolean }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePoll(async () => {
    try {
      const res = await fetch(`/api/orchestrator/dashboard/runs/${encodeURIComponent(id)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { run?: RunDetail; error?: string };
      if (!res.ok || !body.run) throw new Error(body.error ?? `HTTP ${res.status}`);
      setRun(body.run);
      setError(null);
      return detailPollMs(body.run);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return 5_000;
    }
  }, [id]);
  const now = useNow(!!run && !run.done);
  if (!run) {
    return error ? (
      <EmptyState isDark={isDark}>Couldn’t load this run: {error}</EmptyState>
    ) : (
      <div className={panelCardClass(isDark, "h-64 shimmer")} />
    );
  }
  return <RunDetailBody run={run} isDark={isDark} now={now} error={error} />;
}

/** One run: header, plan graph, timeline, steps and the merged answer. */
export function RunDetailBody({
  run,
  isDark,
  now,
  error,
}: {
  run: RunDetail;
  isDark: boolean;
  now: number;
  error?: string | null;
}) {
  const [openStep, setOpenStep] = useState<string | null>(null);
  const meta = runMeta(run.state);
  const muted = mutedTextClass(isDark);
  const took = run.done ? run.durationMs : run.createdAt ? now - run.createdAt : run.durationMs;
  const toggle = (id: string) => setOpenStep((cur) => (cur === id ? null : id));

  return (
    <section className={panelCardClass(isDark, "min-w-0 p-4 fade-in")} data-run-detail={run.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={`flex items-center gap-1.5 text-xs font-medium ${TONE[meta.tone].text}`}>
          <StatusDot tone={meta.tone} pulsing={!run.done} />
          {meta.label}
          {!run.done && <BrailleIndicator className="ml-1" />}
        </span>
        <span className={`mono text-[11px] ${muted} sm:ml-auto max-md:break-all`}>{run.id}</span>
      </div>
      <h3 className={`mt-2 break-words text-sm font-medium ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>{run.title}</h3>
      {run.task && run.task !== run.title && (
        <p className={`mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs ${muted}`} title={run.task}>
          {run.task}
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <Field label={run.done ? "Took" : "Elapsed"} isDark={isDark}>
          <span className="mono">{formatMs(took)}</span>
        </Field>
        <Field label="Steps" isDark={isDark}>
          {countsLine(run.counts)}
        </Field>
        <Field label="Tokens" isDark={isDark}>
          <span className="mono">
            {run.tokensUsed.toLocaleString()}
            {run.tokenBudget ? ` / ${run.tokenBudget.toLocaleString()}` : ""}
          </span>
        </Field>
        <Field label="Started" isDark={isDark}>
          {run.createdAt ? new Date(run.createdAt).toLocaleTimeString() : "—"}
        </Field>
      </dl>

      {run.error && (
        <div
          className={`mt-3 rounded-xl border px-3 py-2 text-xs ${
            isDark ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          <span className="font-medium">Error: </span>
          <span className="whitespace-pre-wrap break-words">{run.error}</span>
        </div>
      )}

      {run.stepsDetail.length === 0 ? (
        <div className="mt-4 flex items-center gap-3">
          {!run.done && <BrailleIndicator />}
          <span className={`text-xs ${muted}`}>{run.done ? "This run never got a plan." : "Planning…"}</span>
        </div>
      ) : (
        <>
          <SubHeading isDark={isDark}>Plan</SubHeading>
          <PlanGraph steps={run.stepsDetail} isDark={isDark} openStep={openStep} onToggle={toggle} />
          <SubHeading isDark={isDark}>Timeline</SubHeading>
          <Timeline run={run} isDark={isDark} now={now} />
          <SubHeading isDark={isDark}>Steps</SubHeading>
          <StepList steps={run.stepsDetail} isDark={isDark} openStep={openStep} onToggle={toggle} now={now} />
        </>
      )}

      {run.result && (
        <>
          <SubHeading isDark={isDark}>
            Merged result <span className="normal-case tracking-normal">· {mergeLabel(run.result.method)}</span>
          </SubHeading>
          {run.result.mergeError && <p className="mb-1 text-[11px] text-amber-500">Merger: {run.result.mergeError}</p>}
          <pre
            data-merged-result
            className={subtlePanelClass(
              isDark,
              `debug-scroll max-h-96 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-xs leading-relaxed ${
                isDark ? "text-zinc-200" : "text-zinc-800"
              }`,
            )}
          >
            {run.result.answer || "(no answer)"}
          </pre>
          {run.result.incomplete.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-amber-500">
              {run.result.incomplete.map((n) => (
                <li key={n.id}>
                  {n.title || n.id}: {n.state.toLowerCase()}
                  {n.note ? ` — ${n.note}` : ""}
                </li>
              ))}
            </ul>
          )}
          {run.result.sources.length > 0 && (
            <div className={`mt-2 text-[11px] ${muted}`}>
              {run.result.sources.length} source{run.result.sources.length === 1 ? "" : "s"} kept in the answer
            </div>
          )}
        </>
      )}
      {error && <p className="mt-3 text-xs text-amber-500">Last refresh failed ({error}).</p>}
    </section>
  );
}

function mergeLabel(method: string): string {
  switch (method) {
    case "llm":
      return "merged by the model";
    case "single":
      return "one-step plan";
    case "fallback":
      return "joined without the model";
    case "none":
      return "no output";
    default:
      return method;
  }
}

function SubHeading({ isDark, children }: { isDark: boolean; children: ReactNode }) {
  return (
    <div className={`mt-4 mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] ${mutedTextClass(isDark)}`}>
      {children}
    </div>
  );
}

function PlanGraph({
  steps,
  isDark,
  openStep,
  onToggle,
}: {
  steps: StepView[];
  isDark: boolean;
  openStep: string | null;
  onToggle: (id: string) => void;
}) {
  const g = layoutGraph(steps);
  return (
    <div className={subtlePanelClass(isDark, "debug-scroll overflow-x-auto p-2")}>
      <div className="relative" style={{ width: g.width, height: g.height }} data-plan-graph>
        <svg className="pointer-events-none absolute inset-0" width={g.width} height={g.height} aria-hidden="true">
          <defs>
            <marker id="orch-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill={isDark ? "#71717a" : "#a1a1aa"} />
            </marker>
          </defs>
          {g.edges.map((e) => (
            <path
              key={`${e.from}->${e.to}`}
              data-edge={`${e.from}->${e.to}`}
              d={e.d}
              fill="none"
              stroke={TONE[STEP_META[e.status].tone].stroke}
              strokeOpacity={e.status === "pending" ? 0.45 : 0.85}
              strokeWidth={1.5}
              strokeDasharray={e.status === "pending" || e.status === "running" ? "4 3" : undefined}
              markerEnd="url(#orch-arrow)"
            />
          ))}
        </svg>
        {g.nodes.map(({ step, x, y }) => {
          const meta = STEP_META[step.status];
          const open = openStep === step.id;
          return (
            <button
              key={step.id}
              type="button"
              data-step={step.id}
              data-step-status={step.status}
              onClick={() => onToggle(step.id)}
              aria-pressed={open}
              title={`${step.title} (${meta.label})`}
              className={`absolute flex flex-col justify-between rounded-xl border px-2.5 py-1.5 text-left ${
                isDark ? "border-white/10 bg-[#202024]" : "border-zinc-200 bg-white"
              } ${open ? (isDark ? "ring-1 ring-sky-400/60" : "ring-1 ring-sky-500/50") : ""}`}
              style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
            >
              <span className={`flex items-center gap-1.5 text-[11px] font-medium ${TONE[meta.tone].text}`}>
                <StatusDot tone={meta.tone} pulsing={step.status === "running"} />
                {meta.label}
                <span className={`ml-auto mono font-normal ${mutedTextClass(isDark)}`}>{formatMs(step.durationMs)}</span>
              </span>
              <span className={`truncate text-xs ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>{step.title}</span>
              <span className={`truncate mono text-[10px] ${mutedTextClass(isDark)}`}>{step.agent}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Timeline({ run, isDark, now }: { run: RunDetail; isDark: boolean; now: number }) {
  const { spanMs, bars } = timelineBars(run, now);
  const muted = mutedTextClass(isDark);
  return (
    <div className={subtlePanelClass(isDark, "space-y-1.5 px-3 py-2.5")} data-timeline>
      {bars.map((b) => {
        const tone = TONE[STEP_META[b.step.status].tone];
        return (
          <div key={b.step.id} className="flex items-center gap-2 text-[11px]">
            <span className={`w-28 shrink-0 truncate ${isDark ? "text-zinc-300" : "text-zinc-700"}`} title={b.step.title}>
              {b.step.title}
            </span>
            <span className={`relative h-3 min-w-0 flex-1 rounded-full ${isDark ? "bg-white/5" : "bg-zinc-200/60"}`}>
              {b.started && (
                <span
                  className={`absolute inset-y-0 rounded-full ${tone.bar} ${b.step.status === "running" ? "shimmer" : ""}`}
                  style={{ left: `${b.left}%`, width: `${b.width}%` }}
                />
              )}
            </span>
            <span className={`mono w-14 shrink-0 text-right ${muted}`}>{b.started ? formatMs(b.step.durationMs) : "—"}</span>
          </div>
        );
      })}
      <div className={`flex justify-between pl-[7.5rem] pr-16 text-[10px] ${muted}`}>
        <span>0s</span>
        <span>{formatMs(spanMs)}</span>
      </div>
    </div>
  );
}

function StepList({
  steps,
  isDark,
  openStep,
  onToggle,
  now,
}: {
  steps: StepView[];
  isDark: boolean;
  openStep: string | null;
  onToggle: (id: string) => void;
  now: number;
}) {
  const muted = mutedTextClass(isDark);
  const titles = new Map(steps.map((s) => [s.id, s.title]));
  return (
    <ul className={subtlePanelClass(isDark, `divide-y ${isDark ? "divide-white/5" : "divide-zinc-200/70"}`)}>
      {steps.map((s) => {
        const meta = STEP_META[s.status];
        const open = openStep === s.id;
        const dur = s.status === "running" && s.startedAt ? now - s.startedAt : s.durationMs;
        return (
          <li key={s.id} data-step-row={s.id}>
            <button
              type="button"
              onClick={() => onToggle(s.id)}
              aria-expanded={open}
              className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left max-md:min-h-11"
            >
              <span className={`flex w-24 shrink-0 items-center gap-1.5 text-[11px] font-medium ${TONE[meta.tone].text}`}>
                <StatusDot tone={meta.tone} pulsing={s.status === "running"} />
                {meta.label}
              </span>
              <span className={`min-w-0 flex-1 truncate text-xs ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>{s.title}</span>
              <span className={`mono text-[10px] ${muted}`}>
                {s.agent} · {formatMs(dur)}
                {s.attempts > 1 ? ` · ${s.attempts} tries` : ""}
              </span>
            </button>
            {open && (
              <div className="space-y-2 px-3 pb-3 text-xs">
                <div className={muted}>
                  <span className="mono">{s.id}</span>
                  {s.dependsOn.length > 0 && <> · after {s.dependsOn.map((d) => titles.get(d) ?? d).join(", ")}</>}
                  {s.costHint && <> · cost {s.costHint}</>}
                  {s.integrations.length > 0 && <> · uses {s.integrations.join(", ")}</>}
                  {s.tokens > 0 && <> · {s.tokens.toLocaleString()} tokens</>}
                </div>
                {(s.error || s.reason) && (
                  <div className="whitespace-pre-wrap break-words text-rose-400">{s.error || s.reason}</div>
                )}
                {s.input && <LogBlock label="Input" lines={s.input} isDark={isDark} collapsible defaultOpen={false} />}
                {s.output && <LogBlock label="Output" lines={s.output} isDark={isDark} />}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Field({ label, isDark, wide, children }: { label: string; isDark: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${wide ? "col-span-2 sm:col-span-4" : ""}`}>
      <dt className={mutedTextClass(isDark)}>{label}</dt>
      <dd className={`mt-0.5 min-w-0 break-words ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>{children}</dd>
    </div>
  );
}

function LogBlock({
  label,
  lines,
  isDark,
  collapsible,
  defaultOpen = true,
}: {
  label: string;
  lines: string;
  isDark: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible || defaultOpen);
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
