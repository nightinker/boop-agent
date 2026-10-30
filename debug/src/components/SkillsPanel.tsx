import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import { lineDiff, trimDiff } from "../lib/lineDiff.js";
import {
  EmptyState,
  HeaderPill,
  PanelPage,
  mutedTextClass,
  panelCardClass,
  subtlePanelClass,
} from "./PanelPrimitives.js";

const SETTING_REVIEW = "skills_review_enabled";
const SETTING_APPROVAL = "skills_write_approval";

const ORIGIN_LABELS: Record<string, string> = {
  execution: "while working",
  review: "background review",
  correction: "from your feedback",
  user: "you",
};

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function timeAgo(ts?: number): string {
  if (!ts) return "never";
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Toggle({
  label,
  hint,
  on,
  onChange,
  isDark,
}: {
  label: string;
  hint: string;
  on: boolean;
  onChange: (next: boolean) => void;
  isDark: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={hint}
      onClick={() => onChange(!on)}
      className={`flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs ${
        isDark ? "border-white/10 bg-white/5 text-zinc-300" : "border-zinc-200 bg-white text-zinc-700"
      }`}
    >
      <span
        className={`toggle-switch relative inline-flex h-4 w-7 shrink-0 items-center rounded-full ${
          on ? "bg-emerald-500" : isDark ? "bg-zinc-700" : "bg-zinc-300"
        }`}
      >
        <span
          className={`toggle-thumb inline-block h-3 w-3 rounded-full bg-white shadow-sm ${
            on ? "translate-x-[14px]" : "translate-x-[2px]"
          }`}
        />
      </span>
      {label}
    </button>
  );
}

function DiffView({ before, after, isDark }: { before: string; after: string; isDark: boolean }) {
  const lines = useMemo(() => trimDiff(lineDiff(before, after)), [before, after]);
  if (lines.length === 0) {
    return <div className={`text-xs ${mutedTextClass(isDark)}`}>No changes to the text.</div>;
  }
  return (
    <pre
      className={`max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border p-3 text-[11px] leading-relaxed mono debug-scroll ${
        isDark ? "border-white/10 bg-[#17171a]" : "border-zinc-200 bg-zinc-50"
      }`}
    >
      {lines.map((line, index) => (
        <div
          key={index}
          className={
            line.kind === "add"
              ? isDark
                ? "bg-emerald-500/10 text-emerald-300"
                : "bg-emerald-50 text-emerald-800"
              : line.kind === "remove"
                ? isDark
                  ? "bg-rose-500/10 text-rose-300"
                  : "bg-rose-50 text-rose-800"
                : line.kind === "gap"
                  ? `italic ${mutedTextClass(isDark)}`
                  : isDark
                    ? "text-zinc-400"
                    : "text-zinc-600"
          }
        >
          {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : line.kind === "gap" ? "  ⋯ " : "  "}
          {line.text || " "}
        </div>
      ))}
    </pre>
  );
}

function PendingChanges({ isDark }: { isDark: boolean }) {
  const pending = useQuery(api.skills.listPending, {});
  const resolve = useMutation(api.skills.resolvePending);
  const [error, setError] = useState<string | null>(null);
  if (!pending || pending.length === 0) return null;

  async function decide(id: Id<"skillPendingChanges">, approve: boolean) {
    setError(null);
    try {
      await resolve({ id, approve });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-amber-500">
        Waiting for your approval · {pending.length}
      </h3>
      {pending.map((change) => (
        <div key={change._id} className={panelCardClass(isDark, "space-y-2 px-4 py-3")}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-sm font-medium ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>
              {change.name}
            </span>
            <span className={`text-xs ${mutedTextClass(isDark)}`}>
              {change.action === "create" ? "new skill" : "edit"} · {ORIGIN_LABELS[change.origin] ?? change.origin} ·{" "}
              {timeAgo(change.createdAt)}
            </span>
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={() => decide(change._id, false)}
                className={`rounded-xl px-3 py-1.5 text-xs ${
                  isDark ? "text-zinc-300 hover:bg-white/5" : "text-zinc-600 hover:bg-zinc-100"
                }`}
              >
                Reject
              </button>
              <button
                type="button"
                onClick={() => decide(change._id, true)}
                className={`rounded-xl px-3 py-1.5 text-xs font-medium ${
                  isDark ? "bg-zinc-100 text-zinc-950 hover:bg-white" : "bg-zinc-900 text-white hover:bg-zinc-800"
                }`}
              >
                Approve
              </button>
            </div>
          </div>
          {change.reason && <div className={`text-xs ${mutedTextClass(isDark)}`}>{change.reason}</div>}
          <DiffView before={change.previousBody ?? ""} after={change.body} isDark={isDark} />
        </div>
      ))}
      {error && <div className="text-xs text-rose-400">{error}</div>}
    </div>
  );
}

function SkillEditor({
  initial,
  isNew,
  onDone,
  isDark,
}: {
  initial: { name: string; description: string; body: string };
  isNew: boolean;
  onDone: (name?: string) => void;
  isDark: boolean;
}) {
  const create = useMutation(api.skills.create);
  const update = useMutation(api.skills.update);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [body, setBody] = useState(initial.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = isDark
    ? "border-white/10 bg-[#17171a] text-zinc-100"
    : "border-zinc-200 bg-zinc-50 text-zinc-900";

  async function save() {
    setError(null);
    if (isNew && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      setError("Use lowercase words joined by hyphens, like send-weekly-invoices.");
      return;
    }
    if (!description.trim()) {
      setError("Add a one-line description of when to use it.");
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        await create({ name, description: description.trim(), body, origin: "user", reason: "Written in the dashboard" });
      } else {
        await update({
          name,
          description: description.trim(),
          body,
          action: "rewrite",
          origin: "user",
          reason: "Edited in the dashboard",
        });
      }
      onDone(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={panelCardClass(isDark, "space-y-3 p-4")}>
      {isNew && (
        <label className="block space-y-1">
          <span className={`text-[11px] ${mutedTextClass(isDark)}`}>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
            placeholder="send-weekly-invoices"
            className={`w-full rounded-xl border px-3 py-2 text-sm mono outline-none ${input}`}
          />
        </label>
      )}
      <label className="block space-y-1">
        <span className={`text-[11px] ${mutedTextClass(isDark)}`}>When to use it (one line)</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Use when the user asks to send this week's invoices."
          className={`w-full rounded-xl border px-3 py-2 text-sm outline-none ${input}`}
        />
      </label>
      <label className="block space-y-1">
        <span className={`text-[11px] ${mutedTextClass(isDark)}`}>Instructions (markdown)</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={16}
          placeholder={"## When to use\n\n## Steps\n1.\n\n## Pitfalls\n\n## Check it worked"}
          className={`w-full rounded-xl border px-3 py-2 text-xs leading-relaxed mono outline-none debug-scroll ${input}`}
        />
      </label>
      {error && <div className="text-xs text-rose-400">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onDone()}
          className={`rounded-xl px-3 py-1.5 text-xs ${isDark ? "text-zinc-300 hover:bg-white/5" : "text-zinc-600 hover:bg-zinc-100"}`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className={`rounded-xl px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
            isDark ? "bg-zinc-100 text-zinc-950 hover:bg-white" : "bg-zinc-900 text-white hover:bg-zinc-800"
          }`}
        >
          {saving ? "Saving…" : isNew ? "Create skill" : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function SkillDetail({ name, onBack, isDark }: { name: string; onBack: () => void; isDark: boolean }) {
  const skill = useQuery(api.skills.get, { name });
  const revisions = useQuery(api.skills.revisions, { name, limit: 30 });
  const setPinned = useMutation(api.skills.setPinned);
  const setArchived = useMutation(api.skills.setArchived);
  const [editing, setEditing] = useState(false);
  const [openRevision, setOpenRevision] = useState<string | null>(null);
  const muted = mutedTextClass(isDark);
  const ghost = `rounded-xl border px-3 py-1.5 text-xs ${
    isDark ? "border-white/10 text-zinc-300 hover:bg-white/5" : "border-zinc-200 text-zinc-700 hover:bg-zinc-50"
  }`;

  const back = (
    <button type="button" onClick={onBack} className={`text-xs ${muted} hover:underline`}>
      ← All skills
    </button>
  );

  if (skill === undefined) return <div className={panelCardClass(isDark, "h-40 shimmer")} />;
  if (skill === null) {
    return (
      <div className="space-y-3">
        {back}
        <EmptyState isDark={isDark}>This skill no longer exists.</EmptyState>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1040px] space-y-4 pb-10">
      {back}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold mono">{skill.name}</h2>
          <p className={`mt-1 text-sm ${isDark ? "text-zinc-400" : "text-zinc-500"}`}>{skill.description}</p>
          <div className={`mt-2 flex flex-wrap gap-3 text-[11px] mono ${muted}`}>
            <span>{skill.status === "archived" ? "archived" : "active"}</span>
            {skill.pinned && <span>pinned</span>}
            <span>by {skill.createdBy === "user" ? "you" : "Boop"}</span>
            <span>{plural(skill.viewCount, "use")}</span>
            <span>{plural(skill.patchCount, "edit")}</span>
            <span>last used {timeAgo(skill.lastUsedAt)}</span>
          </div>
        </div>
        {!editing && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" className={ghost} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className={ghost}
              title="Pinned skills are never changed by Boop"
              onClick={() => setPinned({ name, pinned: !skill.pinned })}
            >
              {skill.pinned ? "Unpin" : "Pin"}
            </button>
            <button
              type="button"
              className={ghost}
              title={skill.status === "archived" ? "Show it to Boop again" : "Hide it from Boop; nothing is deleted"}
              onClick={() => setArchived({ name, archived: skill.status !== "archived" })}
            >
              {skill.status === "archived" ? "Restore" : "Archive"}
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <SkillEditor
          initial={{ name: skill.name, description: skill.description, body: skill.body }}
          isNew={false}
          onDone={() => setEditing(false)}
          isDark={isDark}
        />
      ) : (
        <pre
          className={panelCardClass(
            isDark,
            `whitespace-pre-wrap break-words p-4 text-xs leading-relaxed mono ${isDark ? "text-zinc-200" : "text-zinc-800"}`,
          )}
        >
          {skill.body}
        </pre>
      )}

      <div className="space-y-2">
        <h3 className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${muted}`}>History</h3>
        {(revisions ?? []).map((revision, index) => {
          const previous = revisions?.[index + 1];
          const open = openRevision === revision._id;
          return (
            <div key={revision._id} className={subtlePanelClass(isDark, "px-3 py-2")}>
              <button
                type="button"
                onClick={() => setOpenRevision(open ? null : revision._id)}
                className="flex w-full flex-wrap items-center gap-2 text-left text-xs"
              >
                <span className={isDark ? "text-zinc-200" : "text-zinc-800"}>{revision.action}</span>
                <span className={muted}>
                  {ORIGIN_LABELS[revision.origin] ?? revision.origin} · {timeAgo(revision.createdAt)}
                </span>
                {revision.reason && <span className={`truncate ${muted}`}>· {revision.reason}</span>}
                <span className={`ml-auto ${muted}`}>{open ? "Hide" : "Show"} changes</span>
              </button>
              {open && (
                <div className="mt-2">
                  <DiffView before={previous?.body ?? ""} after={revision.body} isDark={isDark} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SkillsPanel({ isDark }: { isDark: boolean }) {
  const skills = useQuery(api.skills.list, { includeArchived: true });
  const pending = useQuery(api.skills.listPending, {});
  const reviewSetting = useQuery(api.settings.get, { key: SETTING_REVIEW });
  const approvalSetting = useQuery(api.settings.get, { key: SETTING_APPROVAL });
  const setSetting = useMutation(api.settings.set);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");

  if (selected) {
    return <SkillDetail name={selected} onBack={() => setSelected(null)} isDark={isDark} />;
  }

  const all = skills ?? [];
  const activeCount = all.filter((s) => s.status === "active").length;
  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    (s) =>
      s.status === filter &&
      (!needle || s.name.includes(needle) || s.description.toLowerCase().includes(needle)),
  );
  const muted = mutedTextClass(isDark);
  const control = isDark ? "border-white/10 bg-[#17171a] text-zinc-200" : "border-zinc-200 bg-white text-zinc-800";

  return (
    <PanelPage
      eyebrow="Procedural memory"
      title="Skills"
      description="How Boop does each kind of task for you. Boop writes and improves these from its own work and your feedback."
      stat={
        <HeaderPill isDark={isDark}>
          {activeCount} active{pending?.length ? ` · ${pending.length} pending` : ""}
        </HeaderPill>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Toggle
          label="Learn from tasks"
          hint="After bigger tasks and when you correct Boop, a background review saves what it learned."
          on={reviewSetting !== "false"}
          onChange={(next) => setSetting({ key: SETTING_REVIEW, value: next ? "true" : "false" })}
          isDark={isDark}
        />
        <Toggle
          label="Approve changes"
          hint="Boop's skill edits wait here for your approval instead of applying straight away."
          on={approvalSetting === "true"}
          onChange={(next) => setSetting({ key: SETTING_APPROVAL, value: next ? "true" : "false" })}
          isDark={isDark}
        />
      </div>

      <PendingChanges isDark={isDark} />

      {creating ? (
        <SkillEditor
          initial={{ name: "", description: "", body: "" }}
          isNew
          onDone={(name) => {
            setCreating(false);
            if (name) setSelected(name);
          }}
          isDark={isDark}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {(["active", "archived"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setFilter(tab)}
                  className={`rounded-xl px-2.5 py-1.5 text-xs font-medium ${
                    filter === tab
                      ? isDark
                        ? "bg-white/10 text-zinc-100"
                        : "bg-zinc-900 text-white"
                      : `${muted} ${isDark ? "hover:bg-white/5" : "hover:bg-zinc-100"}`
                  }`}
                >
                  {tab === "active" ? "Active" : "Archived"}
                  <span className="ml-1 opacity-60">{all.filter((s) => s.status === tab).length}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills"
                aria-label="Search skills"
                className={`h-8 w-48 rounded-xl border px-2.5 text-xs outline-none ${control}`}
              />
              <button
                type="button"
                onClick={() => setCreating(true)}
                className={`h-8 rounded-xl px-3 text-xs font-medium ${
                  isDark ? "bg-zinc-100 text-zinc-950 hover:bg-white" : "bg-zinc-900 text-white hover:bg-zinc-800"
                }`}
              >
                New skill
              </button>
            </div>
          </div>

          {skills === undefined ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <div key={i} className={panelCardClass(isDark, "h-16 shimmer")} />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <EmptyState isDark={isDark}>
              {all.length === 0
                ? "No skills yet. They appear after bigger tasks or when you tell Boop how you want something done."
                : "No skills match."}
            </EmptyState>
          ) : (
            <div className="space-y-2">
              {shown.map((skill) => (
                <button
                  key={skill._id}
                  type="button"
                  onClick={() => setSelected(skill.name)}
                  className={panelCardClass(
                    isDark,
                    `block w-full px-4 py-3 text-left transition-colors ${isDark ? "hover:bg-white/5" : "hover:bg-zinc-50"}`,
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm font-medium mono ${isDark ? "text-zinc-100" : "text-zinc-900"}`}>
                      {skill.name}
                    </span>
                    {skill.pinned && <HeaderPill isDark={isDark}>pinned</HeaderPill>}
                    <span className={`ml-auto text-[11px] mono ${muted}`}>
                      {plural(skill.viewCount, "use")} · {plural(skill.patchCount, "edit")} · used{" "}
                      {timeAgo(skill.lastUsedAt)}
                    </span>
                  </div>
                  <p className={`mt-1 truncate text-xs ${muted}`}>{skill.description}</p>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </PanelPage>
  );
}
