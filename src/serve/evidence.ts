/**
 * Deterministic, metadata-only evidence planning over one SQLite snapshot.
 *
 * This module belongs entirely to the serving layer: it reads the mirror and
 * knows nothing about Day One, ingestion, crypto, or models. Snapshot status
 * and bounded metadata are materialized in one short SQLite read transaction;
 * deterministic sampling and coverage aggregation happen after it is released.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readSyncStatus, type SyncStatus } from "../sync-status.ts";
import {
  ENTRY_UUID_MAX_CHARS,
  entryFilterClauses,
  GET_ENTRIES_MAX,
  type GetEntriesOptions,
  type GetEntriesResult,
  getEntries,
  type ListFilters,
} from "./queries.ts";

export const SAMPLE_TARGET_DEFAULT = 48;
export const SAMPLE_TARGET_MIN = 8;
export const SAMPLE_TARGET_MAX = 96;
export const SNAPSHOT_TOKEN_MAX_CHARS = 64;
export const COVERAGE_JOURNAL_MAX = 64;
export const COVERAGE_YEAR_MAX = 32;
export const COVERAGE_QUARTER_MAX = 64;
export const COVERAGE_MONTH_MAX = 120;
export const JOURNAL_NAME_MAX_CHARS = 256;
const CREATION_DATE_MAX_CHARS = 64;
const SQLITE_UNICODE_WHITESPACE =
  "\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680" +
  "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A" +
  "\u2028\u2029\u202F\u205F\u3000\uFEFF";
const MEANINGFUL_TEXT_GLOB = `*[^${SQLITE_UNICODE_WHITESPACE}]*`;

export type SnapshotMode = "complete_only" | "best_effort";
export type CoverageStatus = "represented" | "unsampled_budget" | "no_entries" | "no_eligible_text";
export type SnapshotErrorCode =
  | "snapshot_required"
  | "snapshot_stale"
  | "snapshot_unavailable"
  | "snapshot_degraded";

export class SnapshotValidationError extends Error {
  constructor(
    public readonly code: SnapshotErrorCode,
    message: string,
    public readonly current: SyncStatus,
  ) {
    super(message);
    this.name = "SnapshotValidationError";
  }
}

export interface SnapshotDescriptor {
  token: string;
  sync_generation: number;
  status: "complete" | "degraded";
  last_attempt_at: string | null;
  last_complete_at: string | null;
  failed_entries: number;
}

export interface EvidenceEntry {
  evidence_ref: string;
  uuid: string;
  creation_date: string;
  journal: string;
  journal_ref: string;
  text_length: number;
  starred: boolean;
  pinned: boolean;
  year: string | null;
  quarter: string | null;
  month: string | null;
  selection_reason: "marked" | "journal" | "year" | "quarter" | "month" | "fill";
}

export interface CoverageBucket {
  key: string;
  status: CoverageStatus;
  entries: number;
  eligible_text_entries: number;
  sampled_entries: number;
}

export interface JournalCoverageBucket extends CoverageBucket {
  journal_id: number;
  journal_ref: string;
}

export interface CoverageDimension<T extends CoverageBucket = CoverageBucket> {
  cap: number;
  total: number;
  returned: number;
  omitted: number;
  truncated: boolean;
  buckets: T[];
}

export interface EvidenceWarning {
  code:
    | "degraded_snapshot"
    | "invalid_dates"
    | "coverage_truncated"
    | "unreadable_identifiers"
    | "metadata_truncated";
  severity: "warning" | "critical";
  message: string;
  failed_entries?: number;
  affected_entries?: number;
  affected_journals?: number;
}

export interface EvidenceReadBatch {
  batch: number;
  snapshot_token: string;
  uuids: string[];
  evidence_refs: string[];
}

export interface SampleEntriesResult {
  synced_at: string | null;
  sync_status: SyncStatus;
  snapshot: SnapshotDescriptor;
  mode: SnapshotMode;
  target: number;
  returned: number;
  population: {
    matched_entries: number;
    eligible_text_entries: number;
    sample_eligible_entries: number;
    no_eligible_text_entries: number;
    unreadable_identifier_entries: number;
    total_text_chars: number;
    first_date: string | null;
    last_date: string | null;
  };
  strategy: {
    deterministic: true;
    tie_breaker: "sha256(uuid), creation_date, uuid";
    quota_plan: {
      marked: number;
      journal: number;
      year: number;
      quarter: number;
      month: number;
    };
    selected_by_reason: Record<EvidenceEntry["selection_reason"], number>;
  };
  warnings: EvidenceWarning[];
  known_biases: string[];
  entries: EvidenceEntry[];
  coverage: {
    time: {
      year: CoverageDimension;
      quarter: CoverageDimension;
      month: CoverageDimension;
    };
    journals: CoverageDimension<JournalCoverageBucket>;
    marked: CoverageBucket[];
  };
  read_plan: {
    tool: "get_entries";
    snapshot_token_required: true;
    instructions: string;
    batches: EvidenceReadBatch[];
  };
}

export interface GetEntriesAtSnapshotResult extends GetEntriesResult {
  synced_at: string | null;
  sync_status: SyncStatus;
  snapshot: SnapshotDescriptor;
}

interface EvidenceRow {
  uuid: string;
  creation_date: string;
  journal_id: number;
  text_length: number | null;
  eligible_text: number;
  readable_id: number;
  metadata_truncated: number;
  starred: number;
  pinned: number;
}

interface Candidate extends EvidenceRow {
  journal: string;
  journal_ref: string;
  text_length: number;
  year: string | null;
  quarter: string | null;
  month: string | null;
  stable_rank: string;
}

interface JournalCoverageRow {
  key: string;
  journal_id: number;
  journal_ref: string;
  entries: number;
  eligible_text_entries: number;
}

interface MaterializedJournal {
  journal_id: number;
  full_name: string;
  display_name: string;
  metadata_truncated: number;
}

type EvidenceFilters = Pick<ListFilters, "journal" | "tag" | "starred" | "from" | "to" | "place">;

export interface SampleEntriesOptions extends EvidenceFilters {
  target?: number;
  mode?: SnapshotMode;
}

const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function tokenFor(status: SyncStatus): string {
  const canonical = [
    "daytwo-snapshot-v1",
    status.sync_generation,
    status.status,
    status.last_attempt_at ?? "",
    status.last_complete_at ?? "",
    status.failed_entries,
  ].join("\n");
  return `d2s1_${digest(canonical)}`;
}

function descriptorFor(status: SyncStatus): SnapshotDescriptor {
  if (status.status !== "complete" && status.status !== "degraded") {
    throw new SnapshotValidationError(
      "snapshot_unavailable",
      `snapshot unavailable while sync status is ${status.status}`,
      status,
    );
  }
  return {
    token: tokenFor(status),
    sync_generation: status.sync_generation,
    status: status.status,
    last_attempt_at: status.last_attempt_at,
    last_complete_at: status.last_complete_at,
    failed_entries: status.failed_entries,
  };
}

function snapshotForSample(status: SyncStatus, mode: SnapshotMode): SnapshotDescriptor {
  if (status.status === "running" || status.status === "unknown" || status.status === "failed") {
    throw new SnapshotValidationError(
      "snapshot_unavailable",
      `sample_entries requires a complete snapshot${
        mode === "best_effort" ? " or a degraded snapshot" : ""
      }; current status is ${status.status}`,
      status,
    );
  }
  if (status.status === "degraded" && mode === "complete_only") {
    throw new SnapshotValidationError(
      "snapshot_degraded",
      "current snapshot is degraded; retry after a complete sync or explicitly choose best_effort",
      status,
    );
  }
  return descriptorFor(status);
}

function validateToken(status: SyncStatus, token: string): SnapshotDescriptor {
  if (!token) {
    throw new SnapshotValidationError(
      "snapshot_required",
      "snapshot_token is required; call sample_entries first",
      status,
    );
  }
  const expected = tokenFor(status);
  if (token !== expected) {
    throw new SnapshotValidationError(
      "snapshot_stale",
      "snapshot_token is stale because sync generation or status changed; call sample_entries again",
      status,
    );
  }
  return descriptorFor(status);
}

function dateBuckets(value: string): { year: string; quarter: string; month: string } | null {
  const matched = /^(\d{4})-(0[1-9]|1[0-2])(?:-|T|$)/.exec(value);
  if (!matched) return null;
  const year = matched[1]!;
  const monthNumber = Number(matched[2]);
  return {
    year,
    quarter: `${year}-Q${Math.floor((monthNumber - 1) / 3) + 1}`,
    month: `${year}-${matched[2]}`,
  };
}

function stableCandidateCompare(a: Candidate, b: Candidate): number {
  return (
    lexical(a.stable_rank, b.stable_rank) ||
    lexical(a.creation_date, b.creation_date) ||
    lexical(a.uuid, b.uuid)
  );
}

function evenlySpaced<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (items.length <= count) return items;
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]!];
  const picked: T[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(items[Math.floor((i * (items.length - 1)) / (count - 1))]!);
  }
  return picked;
}

function selectBucketPass(
  candidates: Candidate[],
  selected: Map<string, EvidenceEntry["selection_reason"]>,
  key: keyof Pick<Candidate, "journal_ref" | "year" | "quarter" | "month">,
  budget: number,
  reason: EvidenceEntry["selection_reason"],
): void {
  if (budget <= 0 || selected.size >= SAMPLE_TARGET_MAX) return;
  const represented = new Set(
    candidates.filter((candidate) => selected.has(candidate.uuid)).map((candidate) => candidate[key]),
  );
  const keys = [
    ...new Set(
      candidates
        .map((candidate) => candidate[key])
        .filter((value): value is string => value !== null && !represented.has(value)),
    ),
  ].sort(lexical);

  for (const bucket of evenlySpaced(keys, budget)) {
    const candidate = candidates
      .filter((row) => row[key] === bucket && !selected.has(row.uuid))
      .sort(stableCandidateCompare)[0];
    if (candidate) selected.set(candidate.uuid, reason);
  }
}

function plannedQuotas(target: number): SampleEntriesResult["strategy"]["quota_plan"] {
  let remaining = target;
  const marked = Math.min(2, remaining);
  remaining -= marked;
  const journal = Math.min(Math.max(1, Math.floor(target / 6)), remaining);
  remaining -= journal;
  const year = Math.min(Math.max(1, Math.floor(target / 4)), remaining);
  remaining -= year;
  const quarter = Math.min(Math.max(1, Math.floor(target / 4)), remaining);
  remaining -= quarter;
  return { marked, journal, year, quarter, month: remaining };
}

function selectCandidates(candidates: Candidate[], target: number) {
  const quotaPlan = plannedQuotas(target);
  const selected = new Map<string, EvidenceEntry["selection_reason"]>();

  for (const flag of ["starred", "pinned"] as const) {
    if (selected.size >= quotaPlan.marked) break;
    const candidate = candidates
      .filter((row) => !!row[flag] && !selected.has(row.uuid))
      .sort(stableCandidateCompare)[0];
    if (candidate) selected.set(candidate.uuid, "marked");
  }

  selectBucketPass(candidates, selected, "journal_ref", quotaPlan.journal, "journal");
  selectBucketPass(candidates, selected, "year", quotaPlan.year, "year");
  selectBucketPass(candidates, selected, "quarter", quotaPlan.quarter, "quarter");
  // Unused quota from sparse marked/journal/year/quarter passes rolls into month
  // coverage before the final content-independent fill.
  selectBucketPass(candidates, selected, "month", target - selected.size, "month");

  for (const candidate of [...candidates].sort(stableCandidateCompare)) {
    if (selected.size >= target) break;
    if (!selected.has(candidate.uuid)) selected.set(candidate.uuid, "fill");
  }
  return { selected, quotaPlan };
}

function coverageStatus(entries: number, eligible: number, sampled: number): CoverageStatus {
  if (entries === 0) return "no_entries";
  if (eligible === 0) return "no_eligible_text";
  return sampled > 0 ? "represented" : "unsampled_budget";
}

type TimeDimension = keyof Pick<Candidate, "year" | "quarter" | "month">;

function timeIndex(dimension: TimeDimension, key: string): number {
  if (dimension === "year") return Number(key);
  if (dimension === "quarter") {
    const [year, quarter] = key.split("-Q").map(Number);
    return year! * 4 + quarter! - 1;
  }
  const [year, month] = key.split("-").map(Number);
  return year! * 12 + month! - 1;
}

function timeKey(dimension: TimeDimension, index: number): string {
  if (dimension === "year") return String(index).padStart(4, "0");
  const periods = dimension === "quarter" ? 4 : 12;
  const year = Math.floor(index / periods);
  const period = (index % periods) + 1;
  return dimension === "quarter"
    ? `${String(year).padStart(4, "0")}-Q${period}`
    : `${String(year).padStart(4, "0")}-${String(period).padStart(2, "0")}`;
}

function boundedCoverage<T extends CoverageBucket>(
  buckets: T[],
  cap: number,
  identity: (bucket: T) => string,
): CoverageDimension<T> {
  if (buckets.length <= cap) {
    return {
      cap,
      total: buckets.length,
      returned: buckets.length,
      omitted: 0,
      truncated: false,
      buckets,
    };
  }
  const represented = buckets.filter((bucket) => bucket.sampled_entries > 0);
  const chosen = new Set<string>();
  for (const bucket of evenlySpaced(represented, Math.min(cap, represented.length))) {
    chosen.add(identity(bucket));
  }
  const remaining = buckets.filter((bucket) => !chosen.has(identity(bucket)));
  for (const bucket of evenlySpaced(remaining, cap - chosen.size)) {
    chosen.add(identity(bucket));
  }
  const bounded = buckets.filter((bucket) => chosen.has(identity(bucket))).slice(0, cap);
  return {
    cap,
    total: buckets.length,
    returned: bounded.length,
    omitted: buckets.length - bounded.length,
    truncated: true,
    buckets: bounded,
  };
}

function timeCoverage(
  allRows: Candidate[],
  sampled: Set<string>,
  dimension: TimeDimension,
  bounds: Pick<EvidenceFilters, "from" | "to">,
  cap: number,
): CoverageDimension {
  const aggregates = new Map<string | null, { entries: number; eligible: number; sampled: number }>();
  for (const row of allRows) {
    const bucket = row[dimension];
    const aggregate = aggregates.get(bucket) ?? { entries: 0, eligible: 0, sampled: 0 };
    aggregate.entries++;
    if (row.eligible_text) aggregate.eligible++;
    if (sampled.has(row.uuid)) aggregate.sampled++;
    aggregates.set(bucket, aggregate);
  }

  const endpointKeys = [...aggregates.keys()].filter((key): key is string => key !== null);
  for (const bound of [bounds.from, bounds.to]) {
    if (!bound) continue;
    const bucket = dateBuckets(bound)?.[dimension];
    if (bucket) endpointKeys.push(bucket);
  }
  const endpointIndices = endpointKeys.map((key) => timeIndex(dimension, key));
  const first = endpointIndices.length ? Math.min(...endpointIndices) : null;
  const last = endpointIndices.length ? Math.max(...endpointIndices) : null;
  const invalid = aggregates.get(null);
  const validCap = Math.max(0, cap - (invalid ? 1 : 0));
  const represented = [...aggregates.entries()]
    .filter(([key, aggregate]) => key !== null && aggregate.sampled > 0)
    .map(([key]) => timeIndex(dimension, key!))
    .sort((a, b) => a - b);
  const chosen = new Set<number>();
  for (const index of evenlySpaced(represented, Math.min(validCap, represented.length))) {
    chosen.add(index);
  }
  if (first !== null && last !== null && chosen.size < validCap) {
    const candidates: number[] = [];
    for (let index = first; index <= last; index++) {
      if (!chosen.has(index)) candidates.push(index);
    }
    for (const index of evenlySpaced(candidates, validCap - chosen.size)) chosen.add(index);
  }

  const output = [...chosen]
    .sort((a, b) => a - b)
    .map((index): CoverageBucket => {
      const key = timeKey(dimension, index);
      const aggregate = aggregates.get(key) ?? { entries: 0, eligible: 0, sampled: 0 };
      return {
        key,
        status: coverageStatus(aggregate.entries, aggregate.eligible, aggregate.sampled),
        entries: aggregate.entries,
        eligible_text_entries: aggregate.eligible,
        sampled_entries: aggregate.sampled,
      };
    });
  if (invalid) {
    output.push({
      key: "unknown",
      status: coverageStatus(invalid.entries, invalid.eligible, invalid.sampled),
      entries: invalid.entries,
      eligible_text_entries: invalid.eligible,
      sampled_entries: invalid.sampled,
    });
  }
  const validTotal = first === null || last === null ? 0 : last - first + 1;
  const total = validTotal + (invalid ? 1 : 0);
  return {
    cap,
    total,
    returned: output.length,
    omitted: total - output.length,
    truncated: total > output.length,
    buckets: output,
  };
}

function journalCoverage(
  rows: JournalCoverageRow[],
  allRows: Candidate[],
  sampled: Set<string>,
): CoverageDimension<JournalCoverageBucket> {
  const sampledByJournal = new Map<string, number>();
  for (const entry of allRows) {
    if (sampled.has(entry.uuid)) {
      sampledByJournal.set(entry.journal_ref, (sampledByJournal.get(entry.journal_ref) ?? 0) + 1);
    }
  }
  const buckets = rows.map((row): JournalCoverageBucket => {
    const sampledEntries = sampledByJournal.get(row.journal_ref) ?? 0;
    return {
      ...row,
      status: coverageStatus(row.entries, row.eligible_text_entries, sampledEntries),
      sampled_entries: sampledEntries,
    };
  });
  return boundedCoverage(buckets, COVERAGE_JOURNAL_MAX, (bucket) => bucket.journal_ref);
}

function markedCoverage(allRows: Candidate[], sampled: Set<string>): CoverageBucket[] {
  return (["starred", "pinned"] as const).map((flag) => {
    const rows = allRows.filter((row) => !!row[flag]);
    const eligible = rows.filter((row) => !!row.eligible_text).length;
    const sampledEntries = rows.filter((row) => sampled.has(row.uuid)).length;
    return {
      key: flag,
      status: coverageStatus(rows.length, eligible, sampledEntries),
      entries: rows.length,
      eligible_text_entries: eligible,
      sampled_entries: sampledEntries,
    };
  });
}

function selectionCounts(entries: EvidenceEntry[]): Record<EvidenceEntry["selection_reason"], number> {
  const counts: Record<EvidenceEntry["selection_reason"], number> = {
    marked: 0,
    journal: 0,
    year: 0,
    quarter: 0,
    month: 0,
    fill: 0,
  };
  for (const entry of entries) counts[entry.selection_reason]++;
  return counts;
}

/** Metadata-only, deterministic evidence plan plus an exact snapshot token. */
export function sampleEntries(db: Database, opts: SampleEntriesOptions = {}): SampleEntriesResult {
  const target = opts.target ?? SAMPLE_TARGET_DEFAULT;
  const mode = opts.mode ?? "complete_only";
  if (!Number.isInteger(target) || target < SAMPLE_TARGET_MIN || target > SAMPLE_TARGET_MAX) {
    throw new RangeError(`target must be an integer from ${SAMPLE_TARGET_MIN} to ${SAMPLE_TARGET_MAX}`);
  }
  const filters: EvidenceFilters = {
    journal: opts.journal,
    tag: opts.tag,
    starred: opts.starred,
    from: opts.from,
    to: opts.to,
    place: opts.place,
  };
  const activeFilters = Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined),
  ) as EvidenceFilters;
  const { clauses, params } = entryFilterClauses(activeFilters);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  // Keep the SQLite snapshot short: materialize bounded per-entry metadata plus
  // each relevant full journal name once (only to derive its collision-safe
  // hash), then release it before sampling and coverage aggregation.
  const materialized = db.transaction(() => {
    const status = readSyncStatus(db);
    const snapshot = snapshotForSample(status, mode);
    const rows = db
      .query(
        `SELECT substr(e.uuid, 1, ${ENTRY_UUID_MAX_CHARS + 1}) AS uuid,
                substr(e.creation_date, 1, ${CREATION_DATE_MAX_CHARS}) AS creation_date,
                j.id AS journal_id,
                LENGTH(e.text) AS text_length,
                CASE WHEN COALESCE(e.text, '') GLOB $meaningful_text_glob THEN 1 ELSE 0 END
                  AS eligible_text,
                CASE WHEN LENGTH(e.uuid) <= ${ENTRY_UUID_MAX_CHARS} THEN 1 ELSE 0 END AS readable_id,
                CASE WHEN LENGTH(e.creation_date) > ${CREATION_DATE_MAX_CHARS} THEN 1 ELSE 0 END
                  AS metadata_truncated,
                e.starred, e.pinned
         FROM entry e JOIN journal j ON j.id = e.journal_id
         ${where}
         ORDER BY e.uuid`,
      )
      .all({ ...params, $meaningful_text_glob: MEANINGFUL_TEXT_GLOB }) as EvidenceRow[];
    const journalSql =
      Object.keys(activeFilters).length === 0
        ? `SELECT id AS journal_id, name AS full_name,
                  substr(name, 1, ${JOURNAL_NAME_MAX_CHARS}) AS display_name,
                  CASE WHEN LENGTH(name) > ${JOURNAL_NAME_MAX_CHARS} THEN 1 ELSE 0 END
                    AS metadata_truncated
           FROM journal ORDER BY id`
        : activeFilters.journal !== undefined
          ? `SELECT id AS journal_id, name AS full_name,
                    substr(name, 1, ${JOURNAL_NAME_MAX_CHARS}) AS display_name,
                    CASE WHEN LENGTH(name) > ${JOURNAL_NAME_MAX_CHARS} THEN 1 ELSE 0 END
                      AS metadata_truncated
             FROM journal WHERE name = $journal`
          : `SELECT DISTINCT j.id AS journal_id, j.name AS full_name,
                    substr(j.name, 1, ${JOURNAL_NAME_MAX_CHARS}) AS display_name,
                    CASE WHEN LENGTH(j.name) > ${JOURNAL_NAME_MAX_CHARS} THEN 1 ELSE 0 END
                      AS metadata_truncated
             FROM entry e JOIN journal j ON j.id = e.journal_id
             ${where}
             ORDER BY j.id`;
    const journalParams =
      Object.keys(activeFilters).length === 0
        ? {}
        : activeFilters.journal !== undefined
          ? { $journal: activeFilters.journal }
          : params;
    const journals = db.query(journalSql).all(journalParams) as MaterializedJournal[];
    return { status, snapshot, rows, journals };
  })();

  const { status, snapshot, rows } = materialized;
  const journals = materialized.journals.map((journal) => ({
    journal_id: journal.journal_id,
    journal: journal.display_name,
    journal_ref: `d2j1_${digest(`daytwo-journal-v1\0${journal.full_name}`)}`,
    metadata_truncated: journal.metadata_truncated,
  }));
  const journalById = new Map(journals.map((journal) => [journal.journal_id, journal]));
  const allRows: Candidate[] = rows.map((row) => {
    const journal = journalById.get(row.journal_id);
    if (!journal) throw new Error(`journal identity missing for id ${row.journal_id}`);
    const buckets = dateBuckets(row.creation_date);
    return {
      ...row,
      journal: journal.journal,
      journal_ref: journal.journal_ref,
      metadata_truncated: row.metadata_truncated || journal.metadata_truncated,
      text_length: row.text_length ?? 0,
      year: buckets?.year ?? null,
      quarter: buckets?.quarter ?? null,
      month: buckets?.month ?? null,
      stable_rank: digest(`daytwo-sample-v1\0${row.uuid}`),
    };
  });
  const eligible = allRows.filter((row) => !!row.eligible_text && !!row.readable_id);
  const { selected, quotaPlan } = selectCandidates(eligible, target);
  const entries: EvidenceEntry[] = eligible
    .filter((row) => selected.has(row.uuid))
    .map((row) => ({
      evidence_ref: `d2e1_${digest(`daytwo-evidence-v1\0${row.uuid}`)}`,
      uuid: row.uuid,
      creation_date: row.creation_date,
      journal: row.journal,
      journal_ref: row.journal_ref,
      text_length: row.text_length,
      starred: !!row.starred,
      pinned: !!row.pinned,
      year: row.year,
      quarter: row.quarter,
      month: row.month,
      selection_reason: selected.get(row.uuid)!,
    }))
    .sort((a, b) => lexical(a.creation_date, b.creation_date) || lexical(a.uuid, b.uuid));
  const sampled = new Set(entries.map((entry) => entry.uuid));
  const journalAggregates = new Map<string, JournalCoverageRow>();
  for (const journal of journals) {
    journalAggregates.set(journal.journal_ref, {
      key: journal.journal,
      journal_id: journal.journal_id,
      journal_ref: journal.journal_ref,
      entries: 0,
      eligible_text_entries: 0,
    });
  }
  for (const row of allRows) {
    const aggregate = journalAggregates.get(row.journal_ref);
    if (!aggregate) throw new Error(`journal coverage missing for ${row.journal_ref}`);
    aggregate.entries++;
    if (row.eligible_text) aggregate.eligible_text_entries++;
    journalAggregates.set(row.journal_ref, aggregate);
  }
  const journalRows = [...journalAggregates.values()].sort(
    (a, b) => lexical(a.key, b.key) || lexical(a.journal_ref, b.journal_ref),
  );
  const yearCoverage = timeCoverage(allRows, sampled, "year", activeFilters, COVERAGE_YEAR_MAX);
  const quarterCoverage = timeCoverage(allRows, sampled, "quarter", activeFilters, COVERAGE_QUARTER_MAX);
  const monthCoverage = timeCoverage(allRows, sampled, "month", activeFilters, COVERAGE_MONTH_MAX);
  const journalsCoverage = journalCoverage(journalRows, allRows, sampled);
  const invalidDates = allRows.filter((row) => row.month === null).length;
  const unreadableIdentifiers = allRows.filter((row) => !row.readable_id).length;
  const truncatedMetadata = allRows.filter((row) => !!row.metadata_truncated).length;
  const truncatedJournals = journals.filter((journal) => !!journal.metadata_truncated).length;
  const warnings: EvidenceWarning[] = [];
  if (status.status === "degraded") {
    warnings.push({
      code: "degraded_snapshot",
      severity: "critical",
      failed_entries: status.failed_entries,
      message: `DEGRADED SNAPSHOT: ${status.failed_entries} changed entr${
        status.failed_entries === 1 ? "y" : "ies"
      } failed in the latest attempt; evidence coverage is incomplete.`,
    });
  }
  if (invalidDates) {
    warnings.push({
      code: "invalid_dates",
      severity: "warning",
      affected_entries: invalidDates,
      message: `${invalidDates} entr${invalidDates === 1 ? "y has" : "ies have"} an invalid creation date and appear in unknown time buckets.`,
    });
  }
  if (unreadableIdentifiers) {
    warnings.push({
      code: "unreadable_identifiers",
      severity: "warning",
      affected_entries: unreadableIdentifiers,
      message: `${unreadableIdentifiers} matched entr${
        unreadableIdentifiers === 1 ? "y has" : "ies have"
      } an identifier longer than ${ENTRY_UUID_MAX_CHARS} characters and cannot appear in get_entries batches.`,
    });
  }
  if (truncatedMetadata || truncatedJournals) {
    warnings.push({
      code: "metadata_truncated",
      severity: "warning",
      affected_entries: truncatedMetadata,
      affected_journals: truncatedJournals,
      message:
        `${truncatedMetadata} matched entr${truncatedMetadata === 1 ? "y has" : "ies have"} a ` +
        `truncated date or journal label; ${truncatedJournals} journal label${
          truncatedJournals === 1 ? " is" : "s are"
        } truncated. Collision-safe journal_ref values preserve identity.`,
    });
  }
  if (
    yearCoverage.truncated ||
    quarterCoverage.truncated ||
    monthCoverage.truncated ||
    journalsCoverage.truncated
  ) {
    warnings.push({
      code: "coverage_truncated",
      severity: "warning",
      message:
        "Coverage buckets were deterministically compacted to response caps; inspect each " +
        "dimension's total/returned/omitted metadata before making exhaustive coverage claims.",
    });
  }

  const readBatches: EvidenceReadBatch[] = [];
  for (let start = 0; start < entries.length; start += GET_ENTRIES_MAX) {
    const batchEntries = entries.slice(start, start + GET_ENTRIES_MAX);
    readBatches.push({
      batch: readBatches.length + 1,
      snapshot_token: snapshot.token,
      uuids: batchEntries.map((entry) => entry.uuid),
      evidence_refs: batchEntries.map((entry) => entry.evidence_ref),
    });
  }

  const textEligible = allRows.filter((row) => !!row.eligible_text).length;
  const sortedDates = allRows.map((row) => row.creation_date).sort(lexical);
  return {
    synced_at: status.last_complete_at,
    sync_status: status,
    snapshot,
    mode,
    target,
    returned: entries.length,
    population: {
      matched_entries: allRows.length,
      eligible_text_entries: textEligible,
      sample_eligible_entries: eligible.length,
      no_eligible_text_entries: allRows.length - textEligible,
      unreadable_identifier_entries: unreadableIdentifiers,
      total_text_chars: allRows.reduce((sum, row) => sum + row.text_length, 0),
      first_date: sortedDates[0] ?? null,
      last_date: sortedDates.at(-1) ?? null,
    },
    strategy: {
      deterministic: true as const,
      tie_breaker: "sha256(uuid), creation_date, uuid" as const,
      quota_plan: quotaPlan,
      selected_by_reason: selectionCounts(entries),
    },
    warnings,
    known_biases: [
      "Entries with null, empty, or whitespace-only text are ineligible for evidence reads.",
      "Breadth-first bucket quotas underrepresent dense periods and large journals.",
      "SHA-256 UUID ordering is deterministic and content-independent, not semantic relevance or randomness.",
      "Time buckets use the stored ISO creation date and do not reclassify by entry-local time zone.",
      "Starred and pinned coverage reflects explicit flags, not inferred importance.",
    ],
    entries,
    coverage: {
      time: {
        year: yearCoverage,
        quarter: quarterCoverage,
        month: monthCoverage,
      },
      journals: journalsCoverage,
      marked: markedCoverage(allRows, sampled),
    },
    read_plan: {
      tool: "get_entries" as const,
      snapshot_token_required: true as const,
      instructions:
        "Call get_entries for each batch with exactly this batch's snapshot_token. " +
        "Unguarded get_entries calls cannot support longitudinal coverage claims.",
      batches: readBatches,
    },
  };
}

/**
 * Validate an evidence snapshot and read its UUID batch within one SQLite read
 * transaction. No historical rows or tokens are retained server-side.
 */
export function getEntriesAtSnapshot(
  db: Database,
  snapshotToken: string,
  uuids: string[],
  opts: GetEntriesOptions = {},
): GetEntriesAtSnapshotResult {
  if (snapshotToken.length > SNAPSHOT_TOKEN_MAX_CHARS) {
    throw new RangeError(`snapshot_token must be at most ${SNAPSHOT_TOKEN_MAX_CHARS} characters`);
  }
  return db.transaction(() => {
    const status = readSyncStatus(db);
    const snapshot = validateToken(status, snapshotToken);
    return {
      synced_at: status.last_complete_at,
      sync_status: status,
      snapshot,
      ...getEntries(db, uuids, opts),
    };
  })();
}
