/**
 * conformance — prove the REST ingester decrypts correctly by comparing its
 * mirror against an INDEPENDENT oracle: a mirror built from Day One's own JSON
 * export. If the same entries come out of two independent pipelines identically,
 * the decryption + mapping is correct. This is the OmniFocus codec-cross-
 * validation discipline (see CLAUDE.md).
 *
 * Usage:  bun run scripts/conformance.ts <rest-mirror.db> <export-mirror.db>
 *   exits 0 if there are zero CRITICAL diffs, 1 otherwise.
 *
 * Build the two mirrors first (both gitignored — real journal data never enters
 * git):
 *   DAYONE_MIRROR=exports/mirror-export.db bun run import <Journal>.json   # oracle
 *   bun run sync                                                           # REST
 *
 * What counts as a diff
 * ---------------------
 * CRITICAL — a decryption/mapping error. These must be zero:
 *   - an entry present in one mirror but not the other (uuid set must match)
 *   - decrypted `text` differs (empty-string vs NULL is normalized away)
 *   - decrypted `rich_text` differs (both present)
 *   - tag set differs
 *   - media identifier set differs
 *   - starred / pinned / is_all_day differ
 *   - creation_date differs for a NON all-day entry
 *
 * BENIGN — the export is a DIFFERENT serialization than the live REST feed, so
 * these legitimately differ and are reported for information only, never failed:
 *   - coordinates (float32 vs float64 precision)
 *   - temperature / weather (precision / refresh)
 *   - reverse-geocoded place / locality / country (export-only client enrichment;
 *     the REST feed does not carry them)
 *   - media `type` naming (e.g. `quicktime` vs `mov`) and `md5` (edited media)
 *   - creation_date of an all-day entry (timezone anchoring can shift it a day)
 */

import { Database } from "bun:sqlite";

export interface EntryFacts {
  uuid: string;
  text: string | null;
  rich_text: string | null;
  creation_date: string;
  starred: number;
  pinned: number;
  is_all_day: number;
  tags: string[];
  mediaIds: string[];
}

export interface ConformanceReport {
  restCount: number;
  exportCount: number;
  common: number;
  restOnly: string[];
  exportOnly: string[];
  /** uuid → the critical diff kinds it exhibits. Empty map == pass. */
  critical: { uuid: string; kinds: string[] }[];
}

/** "" and NULL both mean "no body" — normalize so they compare equal. */
const normText = (t: string | null): string => t ?? "";
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]); // both are pre-sorted

/**
 * The critical (correctness) diff kinds between two views of the same uuid.
 * Empty array === the two pipelines agree on everything that must be identical.
 */
export function criticalDiffs(a: EntryFacts, b: EntryFacts): string[] {
  const kinds: string[] = [];
  if (normText(a.text) !== normText(b.text)) kinds.push("text");
  if (a.rich_text != null && b.rich_text != null && a.rich_text !== b.rich_text) {
    kinds.push("rich_text");
  }
  if (!sameSet(a.tags, b.tags)) kinds.push("tags");
  if (!sameSet(a.mediaIds, b.mediaIds)) kinds.push("media_identifiers");
  if (a.starred !== b.starred || a.pinned !== b.pinned || a.is_all_day !== b.is_all_day) {
    kinds.push("flags");
  }
  // All-day entries have an ambiguous intra-day time that the export and the REST
  // feed anchor differently (see header) — only compare the timestamp for timed
  // entries.
  if (!a.is_all_day && !b.is_all_day && a.creation_date !== b.creation_date) {
    kinds.push("creation_date");
  }
  return kinds;
}

/** Read every entry's correctness-relevant facts, keyed by uuid. */
export function loadFacts(db: Database): Map<string, EntryFacts> {
  const map = new Map<string, EntryFacts>();
  const tagStmt = db.query(
    "SELECT t.name FROM entry_tag et JOIN tag t ON t.id = et.tag_id WHERE et.entry_uuid = ? ORDER BY t.name",
  );
  const mediaStmt = db.query("SELECT identifier FROM media WHERE entry_uuid = ? ORDER BY identifier");
  const rows = db
    .query("SELECT uuid, text, rich_text, creation_date, starred, pinned, is_all_day FROM entry")
    .all() as Omit<EntryFacts, "tags" | "mediaIds">[];
  for (const r of rows) {
    map.set(r.uuid, {
      ...r,
      tags: (tagStmt.all(r.uuid) as { name: string }[]).map((x) => x.name),
      mediaIds: (mediaStmt.all(r.uuid) as { identifier: string }[]).map((x) => x.identifier),
    });
  }
  return map;
}

/** Compare a REST mirror against an export-oracle mirror. */
export function compareMirrors(restDb: Database, exportDb: Database): ConformanceReport {
  const rest = loadFacts(restDb);
  const exp = loadFacts(exportDb);
  const restOnly = [...rest.keys()].filter((u) => !exp.has(u)).sort();
  const exportOnly = [...exp.keys()].filter((u) => !rest.has(u)).sort();
  const critical: { uuid: string; kinds: string[] }[] = [];
  for (const [uuid, a] of rest) {
    const b = exp.get(uuid);
    if (!b) continue;
    const kinds = criticalDiffs(a, b);
    if (kinds.length) critical.push({ uuid, kinds });
  }
  return {
    restCount: rest.size,
    exportCount: exp.size,
    common: [...rest.keys()].filter((u) => exp.has(u)).length,
    restOnly,
    exportOnly,
    critical,
  };
}

if (import.meta.main) {
  const [restPath, exportPath] = process.argv.slice(2);
  if (!restPath || !exportPath) {
    console.error("usage: bun run scripts/conformance.ts <rest-mirror.db> <export-mirror.db>");
    process.exit(2);
  }
  const report = compareMirrors(
    new Database(restPath, { readonly: true }),
    new Database(exportPath, { readonly: true }),
  );
  // Privacy: print only counts + diff KINDS, never entry text/places/values.
  console.error(`REST entries: ${report.restCount} | export entries: ${report.exportCount}`);
  console.error(`common uuids: ${report.common}`);
  console.error(`REST-only: ${report.restOnly.length} | export-only: ${report.exportOnly.length}`);
  const kindCounts: Record<string, number> = {};
  for (const c of report.critical) for (const k of c.kinds) kindCounts[k] = (kindCounts[k] ?? 0) + 1;
  const ok = report.critical.length === 0 && report.restOnly.length === 0 && report.exportOnly.length === 0;
  if (ok) {
    console.error(`\n✓ conformance PASS — ${report.common} entries, zero critical diffs`);
    process.exit(0);
  }
  console.error(`\n✗ conformance FAIL — ${report.critical.length} entries with critical diffs`);
  console.error(`  by kind: ${JSON.stringify(kindCounts)}`);
  console.error(`  (uuids omitted from this summary; run locally to inspect)`);
  process.exit(1);
}
