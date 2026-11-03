/**
 * Imports claude-mem history (observations, session summaries, prompts) into
 * Convex's archiveRecords table, so Boop's search_history tool can search it.
 *
 * Dry run by default: reads and maps everything, prints counts, writes nothing.
 *
 *   npm run import:claude-mem                                   # dry run
 *   npm run import:claude-mem -- --apply --target <convex-url>  # import
 *
 * Options:
 *   --db <path>            claude-mem database (default ~/.claude-mem/claude-mem.db)
 *   --apply                write to Convex; needs --target
 *   --target <url>         Convex deployment URL to write to. Never read from env,
 *                          so an import cannot land on whatever .env.local points at.
 *   --kinds a,b            observation,summary,prompt (default all three)
 *   --batch <n>            records per mutation (default 100, max 200)
 *   --limit <n>            stop after n records per kind (for trial runs)
 *   --include-sensitive    also import observations claude-mem marked "sensitive"
 *   --checkpoint <file>    resume file (default data/claude-mem-import.json)
 *   --restart              ignore the checkpoint and start from the first row
 *
 * Safe to re-run: records upsert by claude-mem id and unchanged ones are
 * skipped, and the checkpoint lets an interrupted run carry on where it stopped.
 * Credentials are scrubbed before anything is written (server/memory/claude-mem-import.ts).
 * Needs the sqlite3 command-line tool (preinstalled on macOS).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import {
  SENSITIVE_OBSERVATION_TYPES,
  isEmpty,
  mapObservation,
  mapPrompt,
  mapSummary,
  type ArchiveKind,
  type ArchiveRecordInput,
  type ObservationRow,
  type PromptRow,
  type SummaryRow,
} from "../server/memory/claude-mem-import.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = 500;
const ALL_KINDS: ArchiveKind[] = ["observation", "summary", "prompt"];

interface Options {
  db: string;
  apply: boolean;
  target?: string;
  kinds: ArchiveKind[];
  batch: number;
  limit?: number;
  includeSensitive: boolean;
  checkpoint: string;
  restart: boolean;
}

interface Checkpoint {
  db: string;
  target: string;
  lastId: Partial<Record<ArchiveKind, number>>;
}

export interface KindReport {
  read: number;
  skippedSensitive: number;
  skippedEmpty: number;
  withSecretsRemoved: number;
  secretsRemoved: number;
  toImport: number;
  inserted: number;
  updated: number;
  unchanged: number;
  projects: Map<string, number>;
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const kinds = (value("--kinds") ?? ALL_KINDS.join(","))
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean) as ArchiveKind[];
  for (const k of kinds) if (!ALL_KINDS.includes(k)) throw new Error(`Unknown kind "${k}"`);
  const batch = Number(value("--batch") ?? 100);
  if (!Number.isInteger(batch) || batch < 1 || batch > 200) throw new Error("--batch must be 1-200");
  const limitRaw = value("--limit");
  const opts: Options = {
    db: resolve(value("--db") ?? `${homedir()}/.claude-mem/claude-mem.db`),
    apply: argv.includes("--apply"),
    target: value("--target"),
    kinds,
    batch,
    limit: limitRaw ? Number(limitRaw) : undefined,
    includeSensitive: argv.includes("--include-sensitive"),
    checkpoint: resolve(value("--checkpoint") ?? `${ROOT}/data/claude-mem-import.json`),
    restart: argv.includes("--restart"),
  };
  if (opts.apply && !opts.target) throw new Error("--apply needs --target <convex-url>");
  return opts;
}

function sqliteJson<T>(db: string, sql: string): T[] {
  const out = execFileSync("sqlite3", ["-readonly", "-json", db, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.trim() ? (JSON.parse(out) as T[]) : [];
}

function pageSql(kind: ArchiveKind, afterId: number): string {
  const after = Math.max(0, Math.floor(afterId));
  switch (kind) {
    case "observation":
      return `select id, memory_session_id, project, merged_into_project, type, title, subtitle, text,
                facts, narrative, concepts, files_read, files_modified, created_at_epoch
              from observations where id > ${after} order by id limit ${PAGE}`;
    case "summary":
      return `select id, memory_session_id, project, merged_into_project, request, investigated, learned,
                completed, next_steps, notes, files_edited, created_at_epoch
              from session_summaries where id > ${after} order by id limit ${PAGE}`;
    case "prompt":
      return `select u.id, u.content_session_id, u.prompt_number, u.prompt_text, u.created_at_epoch,
                (select s.project from sdk_sessions s where s.content_session_id = u.content_session_id
                  order by s.id limit 1) as project
              from user_prompts u where u.id > ${after} order by u.id limit ${PAGE}`;
  }
}

function mapRow(kind: ArchiveKind, row: unknown) {
  if (kind === "observation") return mapObservation(row as ObservationRow);
  if (kind === "summary") return mapSummary(row as SummaryRow);
  return mapPrompt(row as PromptRow);
}

function loadCheckpoint(opts: Options): Checkpoint | null {
  if (opts.restart || !existsSync(opts.checkpoint)) return null;
  const cp = JSON.parse(readFileSync(opts.checkpoint, "utf8")) as Checkpoint;
  return cp.db === opts.db && cp.target === opts.target ? cp : null;
}

function saveCheckpoint(opts: Options, cp: Checkpoint) {
  mkdirSync(dirname(opts.checkpoint), { recursive: true });
  writeFileSync(opts.checkpoint, JSON.stringify(cp, null, 2));
}

async function withRetry<T>(fn: () => Promise<T>, what: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 4) throw err;
      const wait = 1000 * 2 ** attempt;
      console.warn(`  ${what} failed (attempt ${attempt}), retrying in ${wait / 1000}s: ${String(err)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function emptyReport(): KindReport {
  return {
    read: 0,
    skippedSensitive: 0,
    skippedEmpty: 0,
    withSecretsRemoved: 0,
    secretsRemoved: 0,
    toImport: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    projects: new Map(),
  };
}

async function importKind(
  kind: ArchiveKind,
  opts: Options,
  client: ConvexHttpClient | null,
  cp: Checkpoint,
): Promise<KindReport> {
  const report = emptyReport();
  let afterId = cp.lastId[kind] ?? 0;
  let pending: ArchiveRecordInput[] = [];
  let pendingLastId = afterId;

  const flush = async () => {
    if (client && pending.length) {
      const batch = pending;
      const res = await withRetry(
        () => client.mutation(api.archiveRecords.importBatch, { records: batch }),
        `${kind} batch ending at id ${pendingLastId}`,
      );
      report.inserted += res.inserted;
      report.updated += res.updated;
      report.unchanged += res.unchanged;
    }
    pending = [];
    if (client) {
      cp.lastId[kind] = pendingLastId;
      saveCheckpoint(opts, cp);
    }
  };

  while (opts.limit === undefined || report.read < opts.limit) {
    const rows = sqliteJson<{ id: number; type?: string | null }>(opts.db, pageSql(kind, afterId));
    if (rows.length === 0) break;
    for (const row of rows) {
      if (opts.limit !== undefined && report.read >= opts.limit) break;
      afterId = row.id;
      report.read++;
      if (kind === "observation" && !opts.includeSensitive && SENSITIVE_OBSERVATION_TYPES.has(String(row.type))) {
        report.skippedSensitive++;
      } else {
        const { record, secretsRemoved } = mapRow(kind, row);
        if (isEmpty(record)) {
          report.skippedEmpty++;
        } else {
          if (secretsRemoved > 0) {
            report.withSecretsRemoved++;
            report.secretsRemoved += secretsRemoved;
          }
          report.toImport++;
          report.projects.set(record.project, (report.projects.get(record.project) ?? 0) + 1);
          pending.push(record);
        }
      }
      pendingLastId = row.id;
      if (pending.length >= opts.batch) await flush();
    }
    if (client) process.stdout.write(`\r  ${kind}: ${report.read} read, ${report.inserted} new`);
  }
  await flush();
  if (client) process.stdout.write("\n");
  return report;
}

function printReport(reports: Map<ArchiveKind, KindReport>, opts: Options, resumedFrom: Checkpoint | null) {
  console.log(`\n${opts.apply ? "Import" : "Dry run"} — ${opts.db}`);
  if (resumedFrom) console.log(`Resumed after ids ${JSON.stringify(resumedFrom.lastId)}`);
  const rows = [...reports].map(([kind, r]) => ({
    kind,
    read: r.read,
    "skipped (sensitive)": r.skippedSensitive,
    "skipped (empty)": r.skippedEmpty,
    "had secrets scrubbed": r.withSecretsRemoved,
    "to import": r.toImport,
    ...(opts.apply ? { inserted: r.inserted, updated: r.updated, unchanged: r.unchanged } : {}),
  }));
  console.table(rows);
  const projects = new Map<string, number>();
  for (const r of reports.values()) for (const [p, n] of r.projects) projects.set(p, (projects.get(p) ?? 0) + n);
  console.log(`Projects: ${projects.size}`);
  for (const [p, n] of [...projects].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n.toString().padStart(6)}  ${p}`);
  if (!opts.apply) console.log("\nNothing was written. Re-run with --apply --target <convex-url> to import.");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.db)) throw new Error(`No claude-mem database at ${opts.db}`);
  const resumed = opts.apply ? loadCheckpoint(opts) : null;
  const cp: Checkpoint = resumed ?? { db: opts.db, target: opts.target ?? "", lastId: {} };
  const client = opts.apply ? new ConvexHttpClient(opts.target!) : null;
  if (client) console.log(`Writing to ${opts.target}`);

  const reports = new Map<ArchiveKind, KindReport>();
  for (const kind of opts.kinds) reports.set(kind, await importKind(kind, opts, client, cp));
  printReport(reports, opts, resumed);
  if (client) {
    const counts = await client.query(api.archiveRecords.counts, {});
    console.log("\nStored in Convex now:", counts);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
