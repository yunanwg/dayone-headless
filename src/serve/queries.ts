/**
 * Read queries — the serving layer's core. Pure SQLite, zero Day One / crypto
 * knowledge. Both the CLI and the MCP server call these; they are the single
 * definition of every read tool.
 */

import type { Database } from "bun:sqlite";
import { isMediaCached, MEDIA_DIR, mediaCachePath } from "../media-cache.ts";
import { readSyncStatus, type SyncStatus } from "../sync-status.ts";

/**
 * A malformed or oversized search query. Thrown by `searchEntries` so callers
 * can surface a clean "invalid search query" instead of leaking a raw SQLite
 * error. Other DB errors are never mapped to this.
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
  /** Contextual excerpt; absent when `text` (full body) is returned instead. */
  snippet?: string | null;
  /** Full entry body — only when listEntries is called with include_text. */
  text?: string | null;
  /** LENGTH(text) so an agent can spot long reflective entries cheaply. */
  text_length?: number;
  /** Owning journal name (search + list). */
  journal?: string;
  /** Tags carried by the entry (search + list). */
  tags?: string[];
  /** Present when a full body was requested through a bounded bulk-read surface. */
  text_truncation?: TextTruncation;
}

export interface TextTruncation {
  truncated: boolean;
  original_chars: number;
  returned_chars: number;
  /** Empty when untruncated; otherwise names every budget that shortened the body. */
  limited_by: ("per_entry" | "total")[];
}

/**
 * Codepoints where FTS5 `unicode61` gives no useful word segmentation: CJK
 * ideographs (+ ext. A / compatibility / ext. B–F via surrogates), kana, and
 * Hangul. A query term containing any of these routes through the LIKE-substring
 * path instead of FTS5 — the dominant Chinese search terms are 2-char words,
 * below the trigram tokenizer's 3-char minimum, so substring match is the only
 * correct recall path. At ~10k entries a LIKE scan is milliseconds.
 */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]|[\u{20000}-\u{3ffff}]/u;

const hasCjk = (s: string): boolean => CJK_RE.test(s);

/** Match SQLite LIKE's default ASCII-only case folding without changing offsets. */
const foldAsciiCase = (s: string): string => s.replace(/[A-Z]/g, (char) => char.toLowerCase());

/** Bound query work before it reaches FTS5 or the dynamic CJK LIKE expression. */
export const SEARCH_QUERY_MAX_CHARS = 1024;
export const SEARCH_QUERY_MAX_TERMS = 32;

function validatedSearchTerms(query: string): string[] {
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new InvalidSearchQueryError(
      `invalid search query — maximum length is ${SEARCH_QUERY_MAX_CHARS} characters`,
    );
  }
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length > SEARCH_QUERY_MAX_TERMS) {
    throw new InvalidSearchQueryError(
      `invalid search query — maximum ${SEARCH_QUERY_MAX_TERMS} whitespace-separated terms`,
    );
  }
  return terms;
}

/** Escape LIKE wildcards (%, _) and the escape char so a term matches literally. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

/**
 * Correlated tag list for a row of `entry e` — newline-joined, name-sorted, no
 * fan-out. Mirrors the trick used across the entry summaries.
 */
const TAG_LIST_SUBQUERY =
  "(SELECT group_concat(t.name, char(10) ORDER BY t.name) " +
  "FROM entry_tag et JOIN tag t ON t.id = et.tag_id " +
  "WHERE et.entry_uuid = e.uuid) AS tag_list";

/** Split a group_concat(char(10)) tag list into an array ([] when null). */
const splitTags = (list: string | null): string[] => (list ? list.split("\n") : []);

/**
 * Build a hand-rolled snippet (~60 chars) around the first term match, bracketing
 * the matched substring `[like this]` to mirror the FTS snippet style. Used by the
 * CJK LIKE path, which has no FTS `snippet()` to lean on.
 */
function buildSnippet(text: string, terms: string[]): string {
  const CONTEXT = 24; // chars of context on each side of the match
  const hay = foldAsciiCase(text);
  let at = -1;
  let matched = "";
  for (const t of terms) {
    const idx = hay.indexOf(foldAsciiCase(t));
    if (idx !== -1 && (at === -1 || idx < at)) {
      at = idx;
      matched = text.slice(idx, idx + t.length);
    }
  }
  if (at === -1) return text.slice(0, 60);
  const start = Math.max(0, at - CONTEXT);
  const end = Math.min(text.length, at + matched.length + CONTEXT);
  return (
    (start > 0 ? "… " : "") +
    text.slice(start, at) +
    `[${matched}]` +
    text.slice(at + matched.length, end) +
    (end < text.length ? " …" : "")
  );
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
  /** Return each entry's full `text` instead of a 140-char snippet (listEntries only). */
  include_text?: boolean;
  /** Per-entry full-text budget in Unicode code points (bounded bulk surfaces only). */
  max_chars_per_entry?: number;
  /** Combined full-text budget in Unicode code points (bounded bulk surfaces only). */
  max_total_chars?: number;
  /** Sort key, all DESC. "date" (default) | "length" (LENGTH(text)) | "editing_time". */
  order_by?: "date" | "length" | "editing_time";
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

/** Completeness-aware freshness while retaining the legacy `synced_at` field. */
export function getFreshness(db: Database): {
  synced_at: string | null;
  sync_status: SyncStatus;
} {
  const syncStatus = readSyncStatus(db);
  return {
    synced_at: syncStatus.last_complete_at,
    sync_status: syncStatus,
  };
}

/** Detailed mirror sync state for dedicated CLI/MCP status commands. */
export function getSyncStatus(db: Database): SyncStatus {
  return readSyncStatus(db);
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

/** Curated single-entry shape: typed columns + selective raw fields, no bloat. */
export interface CuratedEntry {
  uuid: string;
  journal: string;
  creation_date: string;
  modified_date: string | null;
  time_zone: string | null;
  text: string | null;
  tags: string[];
  starred: boolean;
  pinned: boolean;
  is_all_day: boolean;
  editing_time: number | null;
  location: {
    place_name: string | null;
    locality_name: string | null;
    country: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  weather: { code: string | null; temperature_c: number | null } | null;
  media: MediaMeta[];
  text_length: number;
  /** Always present on entries returned by the bounded getEntries bulk surface. */
  text_truncation?: TextTruncation;
  /** Present only with includeRichText. */
  rich_text?: unknown;
  /** Present only with includeRaw. */
  raw?: unknown;
}

interface EntryColumnsRow {
  uuid: string;
  journal: string;
  creation_date: string;
  modified_date: string | null;
  time_zone: string | null;
  text: string | null;
  rich_text: string | null;
  starred: number;
  pinned: number;
  is_all_day: number;
  editing_time: number | null;
  latitude: number | null;
  longitude: number | null;
  place_name: string | null;
  locality_name: string | null;
  country: string | null;
  weather_code: string | null;
  temperature_c: number | null;
  text_length: number | null;
  raw: string;
}

/** Parse a stored JSON string, falling back to the raw string if it is malformed. */
function parseJsonOr(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export interface GetEntryOptions {
  /** Include the structured rich-text JSON (default false — it duplicates `text`). */
  includeRichText?: boolean;
  /** Include the potentially large verbatim raw source object (default false). */
  includeRaw?: boolean;
}

/**
 * One entry as a curated, token-lean object built from typed columns plus a few
 * selective raw fields — NOT the whole `raw` blob (that duplicates the body via
 * richText and can contain substantial device/weather/unmodeled metadata).
 * `includeRichText` / `includeRaw` opt back into the heavy fields when needed.
 * Returns null for an unknown uuid.
 */
export function getEntry(db: Database, uuid: string, opts: GetEntryOptions = {}): CuratedEntry | null {
  const row = db
    .query(
      `SELECT e.uuid, j.name AS journal, e.creation_date, e.modified_date, e.time_zone,
              e.text, e.rich_text, e.starred, e.pinned, e.is_all_day, e.editing_time,
              e.latitude, e.longitude, e.place_name, e.locality_name, e.country,
              e.weather_code, e.temperature_c, LENGTH(e.text) AS text_length, e.raw
       FROM entry e JOIN journal j ON j.id = e.journal_id
       WHERE e.uuid = ?`,
    )
    .get(uuid) as EntryColumnsRow | null;
  if (!row) return null;

  const hasLocation =
    row.place_name !== null ||
    row.locality_name !== null ||
    row.country !== null ||
    row.latitude !== null ||
    row.longitude !== null;
  const hasWeather = row.weather_code !== null || row.temperature_c !== null;

  const entry: CuratedEntry = {
    uuid: row.uuid,
    journal: row.journal,
    creation_date: row.creation_date,
    modified_date: row.modified_date,
    time_zone: row.time_zone,
    text: row.text,
    tags: db
      .query(
        `SELECT t.name FROM entry_tag et JOIN tag t ON t.id = et.tag_id
         WHERE et.entry_uuid = ? ORDER BY t.name`,
      )
      .all(uuid)
      .map((r) => (r as { name: string }).name),
    starred: !!row.starred,
    pinned: !!row.pinned,
    is_all_day: !!row.is_all_day,
    editing_time: row.editing_time,
    location: hasLocation
      ? {
          place_name: row.place_name,
          locality_name: row.locality_name,
          country: row.country,
          latitude: row.latitude,
          longitude: row.longitude,
        }
      : null,
    weather: hasWeather ? { code: row.weather_code, temperature_c: row.temperature_c } : null,
    media: getEntryMedia(db, uuid),
    text_length: row.text_length ?? 0,
  };
  if (opts.includeRichText) entry.rich_text = row.rich_text ? parseJsonOr(row.rich_text) : null;
  if (opts.includeRaw) entry.raw = parseJsonOr(row.raw);
  return entry;
}

export interface GetEntriesOptions {
  /** Per-entry body budget in Unicode code points. */
  maxChars?: number;
  /** Combined body budget across all returned entries, in Unicode code points. */
  maxTotalChars?: number;
  /** Retained only so legacy callers receive an explicit migration error. */
  includeRichText?: boolean;
  /** Retained only so legacy callers receive an explicit migration error. */
  includeRaw?: boolean;
}

export interface GetEntriesResult {
  entries: CuratedEntry[];
  /** uuids that matched no entry — reported, never thrown. */
  missing: string[];
}

/** Cap on how many uuids one getEntries call may request. */
export const GET_ENTRIES_MAX = 50;
/** Generous identifier bound; also caps how much missing-input data can be echoed. */
export const ENTRY_UUID_MAX_CHARS = 128;

/** Safe defaults keep bulk reads useful without silently flooding an agent context. */
export const LIST_TEXT_DEFAULT_PER_ENTRY_CHARS = 4_000;
export const LIST_TEXT_DEFAULT_TOTAL_CHARS = 24_000;
export const GET_ENTRIES_DEFAULT_PER_ENTRY_CHARS = 12_000;
export const GET_ENTRIES_DEFAULT_TOTAL_CHARS = 60_000;
export const TEXT_BUDGET_MAX_PER_ENTRY_CHARS = 50_000;
export const TEXT_BUDGET_MAX_TOTAL_CHARS = 100_000;
export const LIST_ENTRIES_MAX = 200;

/** Slice by Unicode code points so a non-BMP character is never split mid-surrogate. */
function sliceCodePoints(value: string, maxCodePoints: number): string {
  let end = 0;
  let count = 0;
  for (const codePoint of value) {
    if (count >= maxCodePoints) break;
    end += codePoint.length;
    count++;
  }
  return value.slice(0, end);
}

/** Count Unicode code points (not UTF-16 code units). */
function codePointLength(value: string): number {
  let count = 0;
  for (const _codePoint of value) count++;
  return count;
}

function validateTextBudget(value: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer from 1 to ${max}`);
  }
}

/**
 * Apply per-entry and combined body budgets in result order. Metadata is explicit
 * even when no truncation occurred; callers never need to infer completeness
 * from punctuation or compare UTF-16 string lengths.
 */
function applyTextBudgets<T extends { text?: string | null; text_truncation?: TextTruncation }>(
  entries: T[],
  perEntryChars: number,
  totalChars: number,
): void {
  validateTextBudget(perEntryChars, TEXT_BUDGET_MAX_PER_ENTRY_CHARS, "max chars per entry");
  validateTextBudget(totalChars, TEXT_BUDGET_MAX_TOTAL_CHARS, "max total chars");

  let remaining = totalChars;
  for (const entry of entries) {
    const text = entry.text;
    const originalChars = text ? codePointLength(text) : 0;
    const afterPerEntry = Math.min(originalChars, perEntryChars);
    const returnedChars = Math.min(afterPerEntry, remaining);
    const limitedBy: TextTruncation["limited_by"] = [];
    if (originalChars > perEntryChars) limitedBy.push("per_entry");
    if (afterPerEntry > remaining) limitedBy.push("total");

    if (text && returnedChars < originalChars) {
      entry.text = sliceCodePoints(text, returnedChars);
    }
    entry.text_truncation = {
      truncated: returnedChars < originalChars,
      original_chars: originalChars,
      returned_chars: returnedChars,
      limited_by: limitedBy,
    };
    remaining -= returnedChars;
  }
}

/**
 * Batch curated read: resolve up to GET_ENTRIES_MAX uuids in the order requested,
 * with safe per-entry and combined body budgets. Unknown uuids are returned in
 * `missing`, not thrown — a partial hit is still useful for bulk reading. Heavy
 * raw/rich-text fields intentionally remain a single-entry getEntry concern.
 */
export function getEntries(db: Database, uuids: string[], opts: GetEntriesOptions = {}): GetEntriesResult {
  if (opts.includeRichText || opts.includeRaw) {
    throw new RangeError(
      "getEntries does not return rich_text or raw in a batch; call getEntry for one entry at a time",
    );
  }
  if (uuids.some((uuid) => uuid.length > ENTRY_UUID_MAX_CHARS)) {
    throw new RangeError(`entry uuid must be at most ${ENTRY_UUID_MAX_CHARS} characters`);
  }

  const entries: CuratedEntry[] = [];
  const missing: string[] = [];
  for (const uuid of uuids.slice(0, GET_ENTRIES_MAX)) {
    const entry = getEntry(db, uuid);
    if (!entry) {
      missing.push(uuid);
      continue;
    }
    entries.push(entry);
  }
  applyTextBudgets(
    entries,
    opts.maxChars ?? GET_ENTRIES_DEFAULT_PER_ENTRY_CHARS,
    opts.maxTotalChars ?? GET_ENTRIES_DEFAULT_TOTAL_CHARS,
  );
  return { entries, missing };
}

export interface StatsBucket {
  key: string;
  entries: number;
  text_chars: number;
  starred: number;
}

export interface Stats {
  overall: {
    entries: number;
    first_date: string | null;
    last_date: string | null;
    total_text_chars: number;
  };
  buckets: StatsBucket[];
}

/**
 * The corpus map: aggregate counts + text volume over the whole (optionally
 * filtered) journal, grouped by year / month / journal. Pure SQL aggregation — no
 * entry text leaves the DB — so it is the cheap first call for any longitudinal
 * or overview question ("shape of my last 10 years") before reading any entry.
 */
export function getStats(
  db: Database,
  groupBy: "year" | "month" | "journal",
  filters: ListFilters = {},
): Stats {
  const { clauses, params } = entryFilterClauses(filters);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const keyExpr = {
    year: "substr(e.creation_date, 1, 4)",
    month: "substr(e.creation_date, 1, 7)",
    journal: "j.name",
  }[groupBy];

  const overall = db
    .query(
      `SELECT COUNT(*) AS entries, MIN(e.creation_date) AS first_date,
              MAX(e.creation_date) AS last_date,
              COALESCE(SUM(LENGTH(e.text)), 0) AS total_text_chars
       FROM entry e JOIN journal j ON j.id = e.journal_id
       ${where}`,
    )
    .get(params) as Stats["overall"];

  const buckets = db
    .query(
      `SELECT ${keyExpr} AS key, COUNT(*) AS entries,
              COALESCE(SUM(LENGTH(e.text)), 0) AS text_chars,
              SUM(e.starred) AS starred
       FROM entry e JOIN journal j ON j.id = e.journal_id
       ${where}
       GROUP BY key ORDER BY key`,
    )
    .all(params) as StatsBucket[];

  return { overall, buckets };
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
export function entryFilterClauses(filters: ListFilters): {
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
 * filters as listEntries (journal / tag / date range / place / starred). Each hit
 * carries its journal name and tags for context.
 *
 * Hybrid tokenization: if any whitespace-split term contains CJK codepoints the
 * query routes through a LIKE-substring path (every term must match, newest
 * first, hand-built snippet) — FTS5 `unicode61` does not segment CJK, so a
 * 2-char Chinese word like 咖啡 matches nothing via MATCH but everything via
 * LIKE. Otherwise the FTS5 path is used unchanged: relevance ranking, snippet(),
 * and typed InvalidSearchQueryError on malformed syntax.
 */
export function searchEntries(db: Database, query: string, filters: ListFilters = {}): EntrySummary[] {
  const terms = validatedSearchTerms(query);
  if (terms.some(hasCjk)) return searchEntriesLike(db, terms, filters);

  const { clauses, params } = entryFilterClauses(filters);
  params.$q = query;
  params.$limit = filters.limit ?? 25;
  params.$offset = filters.offset ?? 0;

  try {
    const rows = db
      .query(
        `SELECT e.uuid, e.creation_date, e.place_name, e.starred,
                j.name AS journal, LENGTH(e.text) AS text_length,
                snippet(entry_fts, 1, '[', ']', ' … ', 12) AS snippet,
                ${TAG_LIST_SUBQUERY}
         FROM entry_fts
         JOIN entry e ON e.uuid = entry_fts.uuid
         JOIN journal j ON j.id = e.journal_id
         WHERE entry_fts MATCH $q${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
         ORDER BY rank
         LIMIT $limit OFFSET $offset`,
      )
      .all(params) as (EntrySummary & { tag_list: string | null })[];
    return rows.map(({ tag_list, ...e }) => ({ ...e, tags: splitTags(tag_list) }));
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
 * CJK-capable substring search: every term must appear in the body
 * (`text LIKE '%term%'`, AND-combined, wildcard-escaped, ASCII-case-insensitive),
 * newest first, with a hand-built snippet. Structured filters apply identically
 * to the FTS path via entryFilterClauses.
 */
function searchEntriesLike(db: Database, terms: string[], filters: ListFilters): EntrySummary[] {
  const { clauses, params } = entryFilterClauses(filters);
  const likeClauses = terms.map((t, i) => {
    params[`$t${i}`] = `%${escapeLike(t)}%`;
    return `e.text LIKE $t${i} ESCAPE '\\'`;
  });
  params.$limit = filters.limit ?? 25;
  params.$offset = filters.offset ?? 0;

  const where = [...likeClauses, ...clauses].join(" AND ");
  const rows = db
    .query(
      `SELECT e.uuid, e.creation_date, e.place_name, e.starred,
              j.name AS journal, e.text AS full_text, LENGTH(e.text) AS text_length,
              ${TAG_LIST_SUBQUERY}
       FROM entry e JOIN journal j ON j.id = e.journal_id
       WHERE ${where}
       ORDER BY e.creation_date DESC, e.uuid
       LIMIT $limit OFFSET $offset`,
    )
    .all(params) as (EntrySummary & { full_text: string | null; tag_list: string | null })[];

  return rows.map(({ full_text, tag_list, ...e }) => ({
    ...e,
    snippet: full_text ? buildSnippet(full_text, terms) : null,
    tags: splitTags(tag_list),
  }));
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

  const orderBy = {
    date: "e.creation_date DESC, e.uuid",
    length: "LENGTH(e.text) DESC, e.uuid",
    editing_time: "e.editing_time DESC, e.uuid",
  }[filters.order_by ?? "date"];

  // include_text returns the full body; otherwise a cheap 140-char snippet.
  const bodyCol = filters.include_text ? "e.text AS text" : "substr(e.text, 1, 140) AS snippet";

  const rows = db
    .query(
      `SELECT e.uuid, e.creation_date, e.place_name, e.starred,
              j.name AS journal, LENGTH(e.text) AS text_length,
              ${bodyCol},
              ${TAG_LIST_SUBQUERY}
       FROM entry e JOIN journal j ON j.id = e.journal_id
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY ${orderBy}
       LIMIT $limit OFFSET $offset`,
    )
    .all(params) as (Omit<EntrySummary, "tags"> & { tag_list: string | null })[];

  return rows.map(({ tag_list, ...e }) => ({
    ...e,
    tags: splitTags(tag_list),
  }));
}

export interface PageInfo {
  /** Number of rows in this page (independent of text-budget truncation). */
  returned: number;
  /** True when at least one more row exists after this page. */
  has_more: boolean;
  /** Offset for the next call, or null at the end of the result set. */
  next_offset: number | null;
}

export interface ListEntriesPage {
  results: EntrySummary[];
  page_info: PageInfo;
}

/**
 * Public bulk-browse surface: fetch one look-ahead row for exact page coverage,
 * then apply explicit Unicode-safe text budgets when full bodies were requested.
 * A full COUNT is intentionally avoided; it would repeat the filtered scan only
 * to provide non-essential metadata.
 */
export function listEntriesPage(db: Database, filters: ListFilters = {}): ListEntriesPage {
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIST_ENTRIES_MAX) {
    throw new RangeError(`limit must be an integer from 1 to ${LIST_ENTRIES_MAX}`);
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError("offset must be a non-negative integer");
  }
  const rows = listEntries(db, { ...filters, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const results = rows.slice(0, limit);

  if (filters.include_text) {
    applyTextBudgets(
      results,
      filters.max_chars_per_entry ?? LIST_TEXT_DEFAULT_PER_ENTRY_CHARS,
      filters.max_total_chars ?? LIST_TEXT_DEFAULT_TOTAL_CHARS,
    );
  }

  return {
    results,
    page_info: {
      returned: results.length,
      has_more: hasMore,
      next_offset: hasMore ? offset + results.length : null,
    },
  };
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
              LENGTH(text) AS text_length,
              substr(text, 1, 140) AS snippet
       FROM entry
       WHERE substr(creation_date, 6, 5) = ?
       ORDER BY creation_date DESC
       LIMIT ?`,
    )
    .all(md, limit) as EntrySummary[];
}
