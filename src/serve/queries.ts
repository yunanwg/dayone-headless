/**
 * Read queries — the serving layer's core. Pure SQLite, zero Day One / crypto
 * knowledge. Both the CLI and the MCP server call these; they are the single
 * definition of every read tool.
 */

import type { Database } from "bun:sqlite";

export interface JournalRow {
  id: number;
  name: string;
  entries: number;
}

export interface EntrySummary {
  uuid: string;
  creation_date: string;
  place_name: string | null;
  starred: number;
  snippet: string | null;
  /** Only populated by listEntries; search/on_this_day leave it undefined. */
  tags?: string[];
}

/**
 * Structured (non-text) filters for listEntries. Every field is optional and
 * ANDed together; an empty object lists the most recent entries. Date bounds are
 * ISO-8601 prefixes compared against creation_date — `from` is an inclusive lower
 * bound, `to` an inclusive upper bound (a bare `YYYY-MM-DD` covers the whole day).
 */
export interface ListFilters {
  journal?: string;
  tag?: string;
  starred?: boolean;
  from?: string;
  to?: string;
  /** Case-insensitive substring over place_name / locality_name / country. */
  place?: string;
  limit?: number;
  offset?: number;
}

export interface TagFacet {
  name: string;
  entries: number;
}

/** When the mirror was last synced (ISO-8601), or null if unknown/never. */
export function getSyncedAt(db: Database): string | null {
  try {
    const row = db.query("SELECT value FROM meta WHERE key = 'synced_at'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null; // meta table absent (old mirror)
  }
}

export function listJournals(db: Database): JournalRow[] {
  return db
    .query(
      `SELECT j.id, j.name, COUNT(e.uuid) AS entries
       FROM journal j LEFT JOIN entry e ON e.journal_id = j.id
       GROUP BY j.id ORDER BY j.name`,
    )
    .all() as JournalRow[];
}

export function getEntry(db: Database, uuid: string): Record<string, unknown> | null {
  const row = db.query(`SELECT raw FROM entry WHERE uuid = ?`).get(uuid) as { raw: string } | null;
  return row ? (JSON.parse(row.raw) as Record<string, unknown>) : null;
}

/**
 * Build the shared structured-filter WHERE fragments + params, over `entry e`
 * joined to `journal j`. Used by both listEntries and searchEntries so the two
 * surfaces filter identically; the caller owns MATCH, ORDER BY, and pagination.
 */
function entryFilterClauses(filters: ListFilters): {
  clauses: string[];
  params: Record<string, string | number>;
} {
  const clauses: string[] = [];
  const params: Record<string, string | number> = {};

  if (filters.journal !== undefined) {
    clauses.push("j.name = $journal");
    params.$journal = filters.journal;
  }
  if (filters.starred !== undefined) {
    clauses.push("e.starred = $starred");
    params.$starred = filters.starred ? 1 : 0;
  }
  if (filters.from !== undefined) {
    clauses.push("e.creation_date >= $from");
    params.$from = filters.from;
  }
  if (filters.to !== undefined) {
    // Append '~' (0x7E, above 'T'/'Z') so a bare date upper bound is inclusive
    // of that whole day, and a full timestamp bound stays inclusive too.
    clauses.push("e.creation_date <= $to");
    params.$to = `${filters.to}~`;
  }
  if (filters.place !== undefined) {
    clauses.push("(e.place_name LIKE $place OR e.locality_name LIKE $place OR e.country LIKE $place)");
    params.$place = `%${filters.place}%`;
  }
  if (filters.tag !== undefined) {
    // Correlated existence check keeps the row-per-entry shape (no fan-out).
    clauses.push(
      "EXISTS (SELECT 1 FROM entry_tag et JOIN tag t ON t.id = et.tag_id " +
        "WHERE et.entry_uuid = e.uuid AND t.name = $tag)",
    );
    params.$tag = filters.tag;
  }

  return { clauses, params };
}

/**
 * Full-text search over entry bodies, optionally narrowed by the same structured
 * filters as listEntries (journal / tag / date range / place / starred). Ranked
 * by FTS relevance, so "coffee in 2021, journal Trips" is one call. The text
 * query is required; every filter is optional and ANDs onto the match.
 */
export function searchEntries(db: Database, query: string, filters: ListFilters = {}): EntrySummary[] {
  const { clauses, params } = entryFilterClauses(filters);
  params.$q = query;
  params.$limit = filters.limit ?? 25;
  params.$offset = filters.offset ?? 0;

  return db
    .query(
      `SELECT e.uuid, e.creation_date, e.place_name, e.starred,
              snippet(entry_fts, 1, '[', ']', ' … ', 12) AS snippet
       FROM entry_fts
       JOIN entry e ON e.uuid = entry_fts.uuid
       JOIN journal j ON j.id = e.journal_id
       WHERE entry_fts MATCH $q${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
       ORDER BY rank
       LIMIT $limit OFFSET $offset`,
    )
    .all(params) as EntrySummary[];
}

/**
 * Structured browse: filter by journal / tag / date range / place / starred and
 * page through the results, newest first. No text query — this is the complement
 * to searchEntries, for "the last N entries", "everything tagged code in 2023",
 * "starred entries from Paris", etc. All filters AND together.
 */
export function listEntries(db: Database, filters: ListFilters = {}): EntrySummary[] {
  const { clauses, params } = entryFilterClauses(filters);
  params.$limit = filters.limit ?? 50;
  params.$offset = filters.offset ?? 0;

  const rows = db
    .query(
      `SELECT e.uuid, e.creation_date, e.place_name, e.starred,
              substr(e.text, 1, 140) AS snippet,
              (SELECT group_concat(t.name, char(10) ORDER BY t.name)
               FROM entry_tag et JOIN tag t ON t.id = et.tag_id
               WHERE et.entry_uuid = e.uuid) AS tag_list
       FROM entry e JOIN journal j ON j.id = e.journal_id
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY e.creation_date DESC, e.uuid
       LIMIT $limit OFFSET $offset`,
    )
    .all(params) as (Omit<EntrySummary, "tags"> & { tag_list: string | null })[];

  return rows.map(({ tag_list, ...e }) => ({
    ...e,
    tags: tag_list ? tag_list.split("\n") : [],
  }));
}

/** All tags with how many entries carry each, most-used first. */
export function listTags(db: Database): TagFacet[] {
  return db
    .query(
      `SELECT t.name, COUNT(et.entry_uuid) AS entries
       FROM tag t LEFT JOIN entry_tag et ON et.tag_id = t.id
       GROUP BY t.id ORDER BY entries DESC, t.name`,
    )
    .all() as TagFacet[];
}

/**
 * Entries whose month-day matches the given date (default: today), across all
 * years. `md` is "MM-DD"; creation_date is "YYYY-MM-DD...".
 */
export function onThisDay(db: Database, md: string, limit = 50): EntrySummary[] {
  return db
    .query(
      `SELECT uuid, creation_date, place_name, starred,
              substr(text, 1, 140) AS snippet
       FROM entry
       WHERE substr(creation_date, 6, 5) = ?
       ORDER BY creation_date DESC
       LIMIT ?`,
    )
    .all(md, limit) as EntrySummary[];
}
