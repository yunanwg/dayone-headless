import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

/**
 * Default mirror location; gitignored. Under `data/` so all runtime state lives
 * in one dir, matching the container's `/data` volume. Override with DAYONE_MIRROR.
 */
export const DEFAULT_MIRROR = process.env.DAYONE_MIRROR ?? "data/mirror.db";

/**
 * Open the mirror and ensure the schema exists. The serving layer opens it
 * read-only by default; the importer passes `writable: true`.
 */
export function openMirror(path = DEFAULT_MIRROR, opts: { writable?: boolean } = {}): Database {
  if (opts.writable) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, {
    readonly: !opts.writable,
    create: opts.writable === true,
  });
  db.exec("PRAGMA foreign_keys = ON;");
  // The MCP reader shares this file with the sync writer; without a busy_timeout
  // a WAL checkpoint on the writer's side can hand the reader SQLITE_BUSY
  // immediately instead of retrying. 5s is enough to ride out a checkpoint.
  db.exec("PRAGMA busy_timeout = 5000;");
  if (!opts.writable) {
    // Read-only opens: belt-and-suspenders against any write ever reaching this
    // connection (the `readonly: true` option above already prevents it at the
    // file level; this rejects at the SQL layer too).
    db.exec("PRAGMA query_only = ON;");
  }
  if (opts.writable) {
    db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  }
  return db;
}
