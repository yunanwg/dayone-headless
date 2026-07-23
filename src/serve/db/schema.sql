-- Mirror schema — the local decrypted store the serving layer reads.
--
-- Shaped to mirror the Day One JSON export (see src/types.ts): the stable contract
-- every ingester (browser / REST / json-export) targets.
--
-- Design rules:
--   * The shape follows the JSON export, not Day One's internal model, and not
--     whatever an ingester finds easiest to produce.
--   * Every row keeps a `raw` JSON column: the verbatim source object. Queries
--     read typed columns; the mirror never loses a field it didn't model yet.
--   * Read-only serving. No trigger/writer paths here.
--   * Media stores METADATA only (identifier / md5 / kind / type). The actual
--     photo/video/audio/pdf bytes are never mirrored — they are fetched and
--     decrypted on demand.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Ingestion metadata: freshness (`synced_at`), source ingester, schema version.
-- The serving layer surfaces `synced_at` so callers know how stale the mirror is.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS journal (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,   -- from the export filename / journal metadata
  export_version TEXT
);

CREATE TABLE IF NOT EXISTS entry (
  uuid           TEXT PRIMARY KEY,
  journal_id     INTEGER NOT NULL REFERENCES journal(id) ON DELETE CASCADE,

  creation_date  TEXT NOT NULL,          -- ISO-8601 UTC
  modified_date  TEXT,
  time_zone      TEXT,                   -- IANA name; entry-local wall time basis

  text           TEXT,                   -- Markdown body
  rich_text      TEXT,                   -- Day One structured rich-text JSON (stringified)

  starred        INTEGER NOT NULL DEFAULT 0,
  pinned         INTEGER NOT NULL DEFAULT 0,
  is_all_day     INTEGER NOT NULL DEFAULT 0,
  editing_time   REAL,

  -- Flattened for cheap filtering/sorting; full objects live in `raw`.
  latitude       REAL,
  longitude      REAL,
  place_name     TEXT,
  locality_name  TEXT,
  country        TEXT,
  weather_code   TEXT,
  temperature_c  REAL,

  raw            TEXT NOT NULL           -- verbatim source entry object (JSON)
);

CREATE INDEX IF NOT EXISTS entry_creation_date_idx ON entry(creation_date);
CREATE INDEX IF NOT EXISTS entry_journal_idx        ON entry(journal_id);
-- on_this_day: match month-day across years. Store a generated md key.
CREATE INDEX IF NOT EXISTS entry_month_day_idx      ON entry(substr(creation_date, 6, 5));

-- Per-entry sync state so the REST ingester can skip unchanged entries: only
-- entries whose server `revision_id` differs from what we stored are re-fetched
-- and re-decrypted. First sync = full; subsequent syncs = cheap deltas.
CREATE TABLE IF NOT EXISTS entry_sync (
  uuid        TEXT PRIMARY KEY,
  journal_id  TEXT,
  revision_id TEXT
);

-- Incremental sync loads the whole per-journal `entry_sync` set every run
-- (see src/ingest/rest/sync.ts); without this, that's a full table scan.
CREATE INDEX IF NOT EXISTS entry_sync_journal_idx ON entry_sync(journal_id);

CREATE TABLE IF NOT EXISTS tag (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS entry_tag (
  entry_uuid TEXT NOT NULL REFERENCES entry(uuid) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tag(id)  ON DELETE CASCADE,
  PRIMARY KEY (entry_uuid, tag_id)
);

CREATE TABLE IF NOT EXISTS media (
  identifier  TEXT PRIMARY KEY,          -- dayone-moment://<identifier>
  entry_uuid  TEXT NOT NULL REFERENCES entry(uuid) ON DELETE CASCADE,
  kind        TEXT NOT NULL,             -- photo | video | audio | pdf
  md5         TEXT,                      -- file on disk is <md5>.<type>
  type        TEXT,
  order_in_entry INTEGER,
  raw         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS media_entry_idx ON media(entry_uuid);

-- Full-text search over entry bodies. Rebuilt on import; plain FTS5 with its own
-- stored copy of `text` (not contentless) — the duplication costs some disk but
-- means snippet()/highlight() work directly off the index, no join back to entry.
CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
  uuid UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
