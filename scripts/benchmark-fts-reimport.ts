/**
 * Synthetic benchmark for the FTS re-import deletion phase.
 *
 * This is intentionally not a CI gate: wall-clock timings vary by machine.
 * Run with:
 *   bun run scripts/benchmark-fts-reimport.ts [row-count]
 */

import { Database } from "bun:sqlite";

const requestedRows = Number(process.argv[2] ?? 4_000);
if (!Number.isSafeInteger(requestedRows) || requestedRows < 1) {
  throw new Error("row-count must be a positive safe integer");
}

const uuids = Array.from({ length: requestedRows }, (_, index) => `synthetic-${index}`);

function seededFts(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE entry_fts USING fts5(uuid UNINDEXED, text)");
  const insert = db.query("INSERT INTO entry_fts (uuid, text) VALUES (?, ?)");
  db.transaction(() => {
    for (const uuid of uuids) insert.run(uuid, `Synthetic benchmark text for ${uuid}`);
  })();
  return db;
}

function measure(run: (db: Database) => void): number {
  const db = seededFts();
  const startedAt = performance.now();
  db.transaction(() => run(db))();
  const elapsedMs = performance.now() - startedAt;
  db.close();
  return elapsedMs;
}

const perEntryMs = measure((db) => {
  const remove = db.query("DELETE FROM entry_fts WHERE uuid = ?");
  for (const uuid of uuids) remove.run(uuid);
});

const batchMs = measure((db) => {
  db.query("DELETE FROM entry_fts WHERE uuid IN (SELECT value FROM json_each(?))").run(JSON.stringify(uuids));
});

console.log(
  JSON.stringify(
    {
      rows: requestedRows,
      deleteStatements: { perEntry: requestedRows, batch: 1 },
      elapsedMs: {
        perEntry: Number(perEntryMs.toFixed(2)),
        batch: Number(batchMs.toFixed(2)),
      },
      speedup: Number((perEntryMs / batchMs).toFixed(1)),
    },
    null,
    2,
  ),
);
