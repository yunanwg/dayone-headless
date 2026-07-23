/**
 * Read queries — the serving layer's core. Pure SQLite, zero Day One / crypto
 * knowledge. Both the CLI and the MCP server call these; they are the single
 * definition of every read tool.
 */

import type { Database } from "bun:sqlite";
import { isMediaCached, MEDIA_DIR, mediaCachePath } from "../media-cache.ts";

/**
 * A malformed full-text query (unbalanced quote, dangling operator, unknown column
 * filter, …). Thrown by `searchEntries` so callers can surface a clean "invalid
 * search query" instead of leaking a raw SQLite error. Other DB errors are never
 * mapped to this — only genuine FTS5 query-syntax failures.
 */
export class InvalidSearchQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "InvalidSearchQueryError";
  }
}

/** True if a thrown DB error is an FTS5 query-syntax error (vs. a real DB fault). */
function isFtsQueryError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /fts5:|unterminated string|malformed MATCH|no such column|syntax error/i.test(err.message)
  );
}

export interface JournalRow {
  id: number;
  name: string;
  entries: number;
}

export interface MediaFile {
  identifier: string;
  md5: string | null;
  kind: string; // photo | video | audio | pdf
  type: string | null;
  /** True if the decrypted bytes are in the local cache (populated by media-fetch). */
  cached: boolean;
  /** Local path to the cached bytes, or null if not cached. */
  path: string | null;
}

/**
 * Resolve a media identifier to its cached bytes, if present. Pure serving: it
 * reads the mirror's media metadata and checks the local content-addressed cache
 * (keyed by the plaintext md5) — no Day One, no crypto, no fetching. Returns null
 * for an unknown identifier; `cached: false` when the metadata exists but the
 * bytes have not been fetched yet (run `daytwo media-fetch`).
 */
export function resolveMedia(db: Database, identifier: string, dir: string = MEDIA_DIR): MediaFile | null {
  const row = db
    .query("SELECT identifier, md5, kind, type FROM media WHERE identifier = ?")
    .get(identifier) as Omit<MediaFile, "cached" | "path"> | null;
  if (!row) return null;
  const cached = row.md5 ? isMediaCached(row.md5, dir) : false;
  return { ...row, cached, path: cached && row.md5 ? mediaCachePath(row.md5, dir) : null };
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

/** Media METADATA attached to one entry (never bytes), in entry order. */
export interface MediaMeta {
  identifier: string;
  kind: string; // photo | video | audio | pdf
  md5: string | null;
  type: string | null;
  order_in_entry: number | null;
}

/**
 * The media attached to an entry, as metadata only — identifier / kind / md5 /
 * type / order. The actual photo/video/audio/pdf bytes are never mirrored; this
 * is what an agent sees to know an entry HAS attachments and how to reference
 * them. Empty array for an entry with no media (or an unknown uuid).
 */
export function getEntryMedia(db: Database, uuid: string): MediaMeta[] {
  return db
    .query(
      `SELECT identifier, kind, md5, type, order_in_entry
       FROM media WHERE entry_uuid = ?
       ORDER BY order_in_entry, identifier`,
    )
    .all(uuid) as MediaMeta[];
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
    // Escape LIKE wildcards (%, _) and the escape char itself so the user's text
    // is matched as a literal substring, not a pattern. `ESCAPE '\'` names `\` as
    // the escape character for the three columns.
    const place = filters.place.replace(/[\\%_]/g, "\\$&");
    clauses.push(
      "(e.place_name LIKE $place ESCAPE '\\' OR e.locality_name LIKE $place ESCAPE '\\' " +
        "OR e.country LIKE $place ESCAPE '\\')",
    );
    params.$place = `%${place}%`;
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

  try {
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
  } catch (err) {
    if (isFtsQueryError(err)) {
      throw new InvalidSearchQueryError(
        'invalid search query — check FTS5 syntax (balance quotes; use "..." for a phrase, ' +
          "AND/OR/NOT to combine, and * for a prefix)",
        { cause: err },
      );
    }
    throw err; // a real DB fault — do not swallow it
  }
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
