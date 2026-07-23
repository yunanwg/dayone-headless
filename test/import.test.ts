/**
 * Importer tests — import a fixture into a fresh in-memory mirror and assert the
 * mirror is populated the way the serving layer expects.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { importExport } from "../src/ingest/json-export/import.ts";
import { openMirror } from "../src/serve/db/open.ts";
import { getEntry } from "../src/serve/queries.ts";
import type { DayOneExport } from "../src/types.ts";

const sample = JSON.parse(
  readFileSync(new URL("./fixtures/sample-export.json", import.meta.url), "utf8"),
) as DayOneExport;

function freshMirror() {
  return openMirror(":memory:", { writable: true });
}

test("imports entries, media and distinct tags with the right counts", () => {
  const db = freshMirror();
  const stats = importExport(db, sample, "sample");

  expect(stats.entries).toBe(3);
  expect(stats.media).toBe(1);
  expect(stats.tags).toBe(4); // travel, paris, code, homelab

  const count = (sql: string) => (db.query(sql).get() as { n: number }).n;
  expect(count("SELECT COUNT(*) n FROM entry")).toBe(3);
  expect(count("SELECT COUNT(*) n FROM media")).toBe(1);
  expect(count("SELECT COUNT(*) n FROM tag")).toBe(4);
  expect(count("SELECT COUNT(*) n FROM entry_tag")).toBe(5); // 2 + 1 + 2
  db.close();
});

test("isPinned maps to the pinned column", () => {
  const pinnedFixture: DayOneExport = {
    metadata: { version: "1.0" },
    entries: [
      {
        uuid: "PINNED00000000000000000000000001",
        creationDate: "2024-02-02T10:00:00Z",
        modifiedDate: "2024-02-02T10:00:00Z",
        timeZone: "Asia/Shanghai",
        text: "Pinned entry.",
        starred: false,
        isPinned: true,
        isAllDay: false,
        creationDevice: "test",
        creationDeviceType: "test",
        creationOSName: "test",
        creationOSVersion: "1.0",
      },
    ],
  };
  const db = freshMirror();
  importExport(db, pinnedFixture, "pinned");
  const row = db.query("SELECT pinned FROM entry WHERE uuid = ?").get("PINNED00000000000000000000000001") as {
    pinned: number;
  };
  expect(row.pinned).toBe(1);
  db.close();
});

test("raw column round-trips the source entry via getEntry", () => {
  const db = freshMirror();
  importExport(db, sample, "sample");
  const original = sample.entries[0]!;
  const got = getEntry(db, original.uuid);
  expect(got).not.toBeNull();
  // Full verbatim round-trip: raw === JSON.stringify(entry).
  expect(JSON.stringify(got)).toBe(JSON.stringify(original));
  expect(got!.text).toBe(original.text);
  db.close();
});

test("a tag repeated across many entries resolves to one cached tag id", () => {
  // Guards the per-run tag-id cache in importExport: every occurrence of the
  // same tag name across entries must resolve to the same row in `tag`,
  // whether it's a cache hit or the first-seen insertTag+getTagId lookup.
  const repeatedTagFixture: DayOneExport = {
    metadata: { version: "1.0" },
    entries: Array.from({ length: 5 }, (_, i) => ({
      uuid: `REPEAT0000000000000000000000000${i}`,
      creationDate: `2024-03-0${i + 1}T10:00:00Z`,
      modifiedDate: `2024-03-0${i + 1}T10:00:00Z`,
      timeZone: "UTC",
      text: `Entry number ${i}.`,
      tags: ["recurring", `unique-${i}`],
      starred: false,
      isPinned: false,
      isAllDay: false,
      creationDevice: "test",
      creationDeviceType: "test",
      creationOSName: "test",
      creationOSVersion: "1.0",
    })),
  };
  const db = freshMirror();
  const stats = importExport(db, repeatedTagFixture, "repeat-tags");

  expect(stats.entries).toBe(5);
  expect(stats.tags).toBe(6); // "recurring" once + 5 distinct "unique-N"

  const tagRow = db.query("SELECT id FROM tag WHERE name = 'recurring'").get() as { id: number };
  const linkedIds = db
    .query(
      `SELECT DISTINCT tag_id FROM entry_tag et
       JOIN tag t ON t.id = et.tag_id
       WHERE t.name = 'recurring'`,
    )
    .all() as { tag_id: number }[];
  expect(linkedIds).toEqual([{ tag_id: tagRow.id }]);

  const linkCount = (
    db
      .query(
        `SELECT COUNT(*) n FROM entry_tag et
         JOIN tag t ON t.id = et.tag_id
         WHERE t.name = 'recurring'`,
      )
      .get() as { n: number }
  ).n;
  expect(linkCount).toBe(5);
  db.close();
});

test("FTS is populated for every entry with body text", () => {
  const db = freshMirror();
  importExport(db, sample, "sample");
  const n = (db.query("SELECT COUNT(*) n FROM entry_fts").get() as { n: number }).n;
  expect(n).toBe(3);
  const hit = db.query("SELECT uuid FROM entry_fts WHERE entry_fts MATCH ?").get("debugging") as {
    uuid: string;
  } | null;
  expect(hit?.uuid).toBe("EEEE5555FFFF6666GGGG7777HHHH8888");
  db.close();
});
