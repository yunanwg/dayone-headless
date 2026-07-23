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

test("raw column round-trips the source entry via getEntry (include_raw)", () => {
  const db = freshMirror();
  importExport(db, sample, "sample");
  const original = sample.entries[0]!;
  // Curated shape by default; the verbatim source is opt-in via include_raw and
  // must round-trip byte-for-byte with the imported entry object.
  const got = getEntry(db, original.uuid, { includeRaw: true });
  expect(got).not.toBeNull();
  expect(JSON.stringify(got!.raw)).toBe(JSON.stringify(original));
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

test("partial re-import rebuilds FTS only for UUIDs in the incoming batch", () => {
  const targetUuid = "FTSTARGET00000000000000000000001";
  const untouchedUuid = "FTSUNTOUCHED0000000000000000001";
  const entry = (uuid: string, text: string) =>
    ({
      uuid,
      creationDate: "2024-01-01T00:00:00Z",
      modifiedDate: "2024-01-01T00:00:00Z",
      timeZone: "UTC",
      text,
      starred: false,
      isPinned: false,
      isAllDay: false,
      creationDevice: "Synthetic Device",
      creationDeviceType: "Synthetic",
      creationOSName: "SyntheticOS",
      creationOSVersion: "1.0",
    }) satisfies DayOneExport["entries"][number];

  const db = freshMirror();
  importExport(
    db,
    {
      metadata: { version: "1.0" },
      entries: [
        entry(targetUuid, "obsolete target token"),
        entry(untouchedUuid, "persistent sentinel token"),
      ],
    },
    "synthetic",
  );
  importExport(
    db,
    { metadata: { version: "1.0" }, entries: [entry(targetUuid, "replacement target token")] },
    "synthetic",
  );

  expect(db.query("SELECT uuid FROM entry_fts WHERE entry_fts MATCH 'obsolete'").get()).toBeNull();
  expect(db.query("SELECT uuid FROM entry_fts WHERE entry_fts MATCH 'replacement'").get()).toEqual({
    uuid: targetUuid,
  });
  expect(db.query("SELECT uuid FROM entry_fts WHERE entry_fts MATCH 'persistent'").get()).toEqual({
    uuid: untouchedUuid,
  });
  expect((db.query("SELECT COUNT(*) AS n FROM entry_fts").get() as { n: number }).n).toBe(2);
  db.close();
});

test("duplicate UUIDs in one import keep only the last FTS body", () => {
  const uuid = "FTSDUPLICATE00000000000000000001";
  const entry = (text: string) =>
    ({
      uuid,
      creationDate: "2024-01-01T00:00:00Z",
      modifiedDate: "2024-01-01T00:00:00Z",
      timeZone: "UTC",
      text,
      starred: false,
      isPinned: false,
      isAllDay: false,
      creationDevice: "Synthetic Device",
      creationDeviceType: "Synthetic",
      creationOSName: "SyntheticOS",
      creationOSVersion: "1.0",
    }) satisfies DayOneExport["entries"][number];

  const db = freshMirror();
  importExport(
    db,
    { metadata: { version: "1.0" }, entries: [entry("first duplicate body"), entry("last duplicate body")] },
    "synthetic",
  );

  expect(db.query("SELECT uuid FROM entry_fts WHERE entry_fts MATCH 'first'").get()).toBeNull();
  expect(db.query("SELECT uuid FROM entry_fts WHERE entry_fts MATCH 'last'").get()).toEqual({ uuid });
  expect((db.query("SELECT COUNT(*) AS n FROM entry_fts").get() as { n: number }).n).toBe(1);
  db.close();
});

test("re-import replaces every typed entry column and permits journal, null, and false transitions", () => {
  const uuid = "REIMPORT000000000000000000000001";
  const originalEntry = {
    uuid,
    creationDate: "2024-01-01T08:00:00Z",
    modifiedDate: "2024-01-01T09:00:00Z",
    timeZone: "Europe/Paris",
    text: "Original searchable body.",
    richText: '{"contents":["original"]}',
    starred: true,
    isPinned: true,
    isAllDay: true,
    editingTime: 120,
    tags: ["original-tag"],
    creationDevice: "Synthetic Device",
    creationDeviceType: "Synthetic",
    creationOSName: "SyntheticOS",
    creationOSVersion: "1.0",
    location: {
      latitude: 12.5,
      longitude: 34.5,
      placeName: "Synthetic Place",
      localityName: "Synthetic Locality",
      country: "Synthetic Country",
    },
    weather: {
      weatherCode: "clear",
      weatherServiceName: "Synthetic Weather",
      conditionsDescription: "Clear",
      temperatureCelsius: 21.5,
      pressureMB: 1000,
      windBearing: 90,
      windSpeedKPH: 5,
      relativeHumidity: 0.5,
      moonPhase: 0.25,
    },
  } satisfies DayOneExport["entries"][number];
  const updatedEntry = {
    uuid,
    creationDate: "2025-02-02T10:00:00Z",
    text: "Replacement searchable body.",
    starred: false,
    isPinned: false,
    isAllDay: false,
    tags: ["replacement-tag"],
    creationDevice: "Synthetic Device",
    creationDeviceType: "Synthetic",
    creationOSName: "SyntheticOS",
    creationOSVersion: "2.0",
  } as DayOneExport["entries"][number];

  const db = freshMirror();
  importExport(db, { metadata: { version: "1.0" }, entries: [originalEntry] }, "original");
  importExport(db, { metadata: { version: "2.0" }, entries: [updatedEntry] }, "replacement");

  const row = db
    .query(
      `SELECT
         j.name AS journal_name, e.creation_date, e.modified_date, e.time_zone,
         e.text, e.rich_text, e.starred, e.pinned, e.is_all_day, e.editing_time,
         e.latitude, e.longitude, e.place_name, e.locality_name, e.country,
         e.weather_code, e.temperature_c, e.raw
       FROM entry e
       JOIN journal j ON j.id = e.journal_id
       WHERE e.uuid = ?`,
    )
    .get(uuid) as Record<string, unknown>;

  expect(row).toEqual({
    journal_name: "replacement",
    creation_date: "2025-02-02T10:00:00Z",
    modified_date: null,
    time_zone: null,
    text: "Replacement searchable body.",
    rich_text: null,
    starred: 0,
    pinned: 0,
    is_all_day: 0,
    editing_time: null,
    latitude: null,
    longitude: null,
    place_name: null,
    locality_name: null,
    country: null,
    weather_code: null,
    temperature_c: null,
    raw: JSON.stringify(updatedEntry),
  });

  const tags = db
    .query(
      `SELECT t.name
       FROM tag t
       JOIN entry_tag et ON et.tag_id = t.id
       WHERE et.entry_uuid = ?`,
    )
    .all(uuid) as { name: string }[];
  expect(tags).toEqual([{ name: "replacement-tag" }]);
  expect(db.query("SELECT uuid FROM entry_fts WHERE entry_fts MATCH 'original'").get()).toBeNull();
  expect(db.query("SELECT uuid FROM entry_fts WHERE entry_fts MATCH 'replacement'").get()).toEqual({ uuid });
  db.close();
});

test("media conflicts replace owner and every typed column alongside raw", () => {
  const identifier = "SYNTHETIC-MEDIA-ID";
  const oldEntry = {
    uuid: "MEDIAOWNER00000000000000000000001",
    creationDate: "2024-01-01T00:00:00Z",
    modifiedDate: "2024-01-01T00:00:00Z",
    timeZone: "UTC",
    text: "Original media owner.",
    starred: false,
    isPinned: false,
    isAllDay: false,
    creationDevice: "Synthetic Device",
    creationDeviceType: "Synthetic",
    creationOSName: "SyntheticOS",
    creationOSVersion: "1.0",
    photos: [
      {
        identifier,
        md5: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        type: "jpeg",
        orderInEntry: 0,
      },
    ],
  } satisfies DayOneExport["entries"][number];
  const replacementMedia = {
    identifier,
    md5: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    format: "m4a",
    orderInEntry: 3,
  };
  const newEntry = {
    ...oldEntry,
    uuid: "MEDIAOWNER00000000000000000000002",
    text: "Replacement media owner.",
    photos: undefined,
    audios: [replacementMedia],
  } satisfies DayOneExport["entries"][number];

  const db = freshMirror();
  importExport(db, { metadata: { version: "1.0" }, entries: [oldEntry] }, "original");
  importExport(db, { metadata: { version: "2.0" }, entries: [newEntry] }, "replacement");

  let row = db.query("SELECT * FROM media WHERE identifier = ?").get(identifier);
  expect(row).toEqual({
    identifier,
    entry_uuid: newEntry.uuid,
    kind: "audio",
    md5: replacementMedia.md5,
    type: "m4a",
    order_in_entry: 3,
    raw: JSON.stringify(replacementMedia),
  });

  // Moving media while both the old and new owner are in one export must not
  // depend on entry order: the old owner's cleanup runs before all inserts.
  importExport(db, { metadata: { version: "1.0" }, entries: [oldEntry] }, "original");
  const oldEntryWithoutMedia = { ...oldEntry, photos: undefined };
  importExport(
    db,
    { metadata: { version: "2.0" }, entries: [newEntry, oldEntryWithoutMedia] },
    "replacement",
  );
  row = db.query("SELECT * FROM media WHERE identifier = ?").get(identifier);
  expect(row).toEqual({
    identifier,
    entry_uuid: newEntry.uuid,
    kind: "audio",
    md5: replacementMedia.md5,
    type: "m4a",
    order_in_entry: 3,
    raw: JSON.stringify(replacementMedia),
  });
  db.close();
});
