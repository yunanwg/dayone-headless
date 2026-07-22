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
  const row = db.query(`SELECT raw FROM entry WHERE uuid = ?`).get(uuid) as
    | { raw: string }
    | null;
  return row ? (JSON.parse(row.raw) as Record<string, unknown>) : null;
}

export function searchEntries(db: Database, query: string, limit = 25): EntrySummary[] {
  return db
    .query(
      `SELECT e.uuid, e.creation_date, e.place_name, e.starred,
              snippet(entry_fts, 1, '[', ']', ' … ', 12) AS snippet
       FROM entry_fts
       JOIN entry e ON e.uuid = entry_fts.uuid
       WHERE entry_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit) as EntrySummary[];
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
