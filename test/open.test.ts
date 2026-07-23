/**
 * openMirror() pragma + schema wiring tests.
 *   - read-only opens set busy_timeout and query_only (so the MCP reader can't
 *     be handed SQLITE_BUSY at 0ms while the sync writer checkpoints WAL, and
 *     can never write even by accident).
 *   - writable opens set busy_timeout too, and re-applying schema.sql against
 *     an already-migrated file is a no-op that still lands new indexes
 *     (CREATE INDEX IF NOT EXISTS), so an existing mirror picks up
 *     entry_sync_journal_idx on its very next writable open.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMirror } from "../src/serve/db/open.ts";

function pragma(db: ReturnType<typeof openMirror>, name: string, column = name): unknown {
  return (db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null)?.[column];
}

test("writable open sets busy_timeout and creates entry_sync_journal_idx", () => {
  const db = openMirror(":memory:", { writable: true });
  expect(pragma(db, "busy_timeout", "timeout")).toBe(5000);
  const idx = db
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'entry_sync_journal_idx'")
    .get();
  expect(idx).not.toBeNull();
  db.close();
});

test("an existing mirror file gains the new index on its next writable open", () => {
  const dir = mkdtempSync(join(tmpdir(), "mirror-"));
  const path = join(dir, "mirror.db");
  try {
    // Simulate a mirror created before entry_sync_journal_idx existed: drop the
    // index right after the (idempotent) schema creates it, then reopen.
    const first = openMirror(path, { writable: true });
    first.exec("DROP INDEX IF EXISTS entry_sync_journal_idx;");
    let idx = first
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'entry_sync_journal_idx'")
      .get();
    expect(idx).toBeNull();
    first.close();

    const second = openMirror(path, { writable: true });
    idx = second
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'entry_sync_journal_idx'")
      .get();
    expect(idx).not.toBeNull();
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only open sets busy_timeout and query_only, rejecting writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "mirror-"));
  const path = join(dir, "mirror.db");
  try {
    const writer = openMirror(path, { writable: true });
    writer.close();

    const reader = openMirror(path);
    expect(pragma(reader, "busy_timeout", "timeout")).toBe(5000);
    expect(pragma(reader, "query_only")).toBe(1);
    expect(() => reader.exec("INSERT INTO meta (key, value) VALUES ('x', 'y')")).toThrow();
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
