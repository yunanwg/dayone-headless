/**
 * Serving-layer read-query tests, against the imported sample fixture.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { importExport } from "../src/ingest/json-export/import.ts";
import { openMirror } from "../src/serve/db/open.ts";
import {
  getEntry,
  getEntryMedia,
  InvalidSearchQueryError,
  listEntries,
  listJournals,
  listTags,
  onThisDay,
  searchEntries,
} from "../src/serve/queries.ts";
import type { DayOneExport } from "../src/types.ts";

const sample = JSON.parse(
  readFileSync(new URL("./fixtures/sample-export.json", import.meta.url), "utf8"),
) as DayOneExport;

// A second, one-entry journal so journal-scoped filters have something to scope.
// Cast like the JSON fixture: real exports omit many fields the type marks required.
const other = {
  metadata: { version: "1.0" },
  entries: [
    {
      uuid: "ZZZZ0000ZZZZ0000ZZZZ0000ZZZZ0000",
      creationDate: "2022-06-01T00:00:00Z",
      timeZone: "UTC",
      text: "Second journal, lone entry.",
      tags: ["misc"],
    },
  ],
} as DayOneExport;

let db: Database;

beforeAll(() => {
  db = openMirror(":memory:", { writable: true });
  importExport(db, sample, "sample");
  importExport(db, other, "other");
});

test("listJournals returns each journal with its entry count", () => {
  const journals = listJournals(db);
  expect(journals).toHaveLength(2);
  const sampleJournal = journals.find((j) => j.name === "sample");
  expect(sampleJournal!.entries).toBe(3);
  expect(journals.find((j) => j.name === "other")!.entries).toBe(1);
});

test("getEntry returns the raw entry, or null for an unknown uuid", () => {
  const e = getEntry(db, "AAAA1111BBBB2222CCCC3333DDDD4444");
  expect(e).not.toBeNull();
  expect(e!.uuid).toBe("AAAA1111BBBB2222CCCC3333DDDD4444");
  expect(typeof e!.text).toBe("string");
  expect(getEntry(db, "does-not-exist")).toBeNull();
});

test("getEntryMedia returns attached media metadata, [] when none", () => {
  const media = getEntryMedia(db, "AAAA1111BBBB2222CCCC3333DDDD4444");
  expect(media).toHaveLength(1);
  expect(media[0]).toEqual({
    identifier: "PHOTO-ID-1",
    kind: "photo",
    md5: "0123456789abcdef0123456789abcdef",
    type: "jpeg",
    order_in_entry: 0,
  });
  // Entry with no attachments, and an unknown uuid, both yield [].
  expect(getEntryMedia(db, "EEEE5555FFFF6666GGGG7777HHHH8888")).toEqual([]);
  expect(getEntryMedia(db, "does-not-exist")).toEqual([]);
});

test("searchEntries finds by body text and returns a snippet", () => {
  const hits = searchEntries(db, "Paris");
  expect(hits).toHaveLength(1);
  expect(hits[0]!.uuid).toBe("AAAA1111BBBB2222CCCC3333DDDD4444");
  expect(hits[0]!.snippet).toContain("[");

  expect(searchEntries(db, "debugging")).toHaveLength(1);
  expect(searchEntries(db, "nonexistentwordxyz")).toHaveLength(0);
});

test("searchEntries narrows by the same structured filters as listEntries", () => {
  // 'journal' matches the homelab entry (sample) and the lone 'other' entry.
  expect(
    searchEntries(db, "journal")
      .map((e) => e.uuid)
      .sort(),
  ).toEqual(["IIII9999JJJJ0000KKKK1111LLLL2222", "ZZZZ0000ZZZZ0000ZZZZ0000ZZZZ0000"].sort());
  // scoped to the 'other' journal → just its entry.
  expect(searchEntries(db, "journal", { journal: "other" }).map((e) => e.uuid)).toEqual([
    "ZZZZ0000ZZZZ0000ZZZZ0000ZZZZ0000",
  ]);
  // scoped by date range → just the 2023 sample entry.
  expect(searchEntries(db, "journal", { from: "2023-01-01" }).map((e) => e.uuid)).toEqual([
    "IIII9999JJJJ0000KKKK1111LLLL2222",
  ]);
  // scoped by tag → just the homelab entry.
  expect(searchEntries(db, "journal", { tag: "homelab" }).map((e) => e.uuid)).toEqual([
    "IIII9999JJJJ0000KKKK1111LLLL2222",
  ]);
  // limit still respected alongside filters.
  expect(searchEntries(db, "journal", { limit: 1 })).toHaveLength(1);
});

test("onThisDay matches month-day across years, newest first", () => {
  // 2021-07-22 and 2019-07-22 both fall on 07-22.
  const hits = onThisDay(db, "07-22");
  expect(hits).toHaveLength(2);
  expect(hits[0]!.creation_date > hits[1]!.creation_date).toBe(true);
  expect(hits[0]!.creation_date).toBe("2021-07-22T08:30:00Z");

  expect(onThisDay(db, "01-03")).toHaveLength(1);
  expect(onThisDay(db, "12-25")).toHaveLength(0);
});

test("listEntries with no filters returns everything, newest first", () => {
  const all = listEntries(db);
  expect(all.map((e) => e.uuid)).toEqual([
    "IIII9999JJJJ0000KKKK1111LLLL2222", // 2023-01-03
    "ZZZZ0000ZZZZ0000ZZZZ0000ZZZZ0000", // 2022-06-01
    "AAAA1111BBBB2222CCCC3333DDDD4444", // 2021-07-22
    "EEEE5555FFFF6666GGGG7777HHHH8888", // 2019-07-22
  ]);
  expect(all[0]!.tags).toEqual(["code", "homelab"]); // sorted for stable output
});

test("listEntries filters by journal", () => {
  const hits = listEntries(db, { journal: "other" });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.uuid).toBe("ZZZZ0000ZZZZ0000ZZZZ0000ZZZZ0000");
});

test("listEntries filters by tag (existence, no row fan-out)", () => {
  expect(listEntries(db, { tag: "code" }).map((e) => e.uuid)).toEqual([
    "IIII9999JJJJ0000KKKK1111LLLL2222",
    "EEEE5555FFFF6666GGGG7777HHHH8888",
  ]);
  expect(listEntries(db, { tag: "paris" })).toHaveLength(1);
  expect(listEntries(db, { tag: "nope" })).toHaveLength(0);
});

test("listEntries filters by starred", () => {
  const starred = listEntries(db, { starred: true });
  expect(starred).toHaveLength(1);
  expect(starred[0]!.uuid).toBe("AAAA1111BBBB2222CCCC3333DDDD4444");
});

test("listEntries filters by inclusive date range", () => {
  // 2020-01-01 .. 2022-12-31 → the 2021 and 2022 entries, not 2019 or 2023.
  const hits = listEntries(db, { from: "2020-01-01", to: "2022-12-31" });
  expect(hits.map((e) => e.uuid)).toEqual([
    "ZZZZ0000ZZZZ0000ZZZZ0000ZZZZ0000",
    "AAAA1111BBBB2222CCCC3333DDDD4444",
  ]);
  // A bare-date upper bound is inclusive of that whole day.
  expect(listEntries(db, { from: "2023-01-03", to: "2023-01-03" })).toHaveLength(1);
});

test("listEntries filters by place substring, case-insensitive", () => {
  const hits = listEntries(db, { place: "par" });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.uuid).toBe("AAAA1111BBBB2222CCCC3333DDDD4444");
  expect(listEntries(db, { place: "france" })).toHaveLength(1); // matches country
});

test("listEntries paginates with limit + offset", () => {
  const page1 = listEntries(db, { limit: 2, offset: 0 });
  const page2 = listEntries(db, { limit: 2, offset: 2 });
  expect(page1.map((e) => e.uuid)).toEqual([
    "IIII9999JJJJ0000KKKK1111LLLL2222",
    "ZZZZ0000ZZZZ0000ZZZZ0000ZZZZ0000",
  ]);
  expect(page2.map((e) => e.uuid)).toEqual([
    "AAAA1111BBBB2222CCCC3333DDDD4444",
    "EEEE5555FFFF6666GGGG7777HHHH8888",
  ]);
});

test("listEntries ANDs filters together", () => {
  // tag code + on/after 2023 → only the homelab entry.
  const hits = listEntries(db, { tag: "code", from: "2023-01-01" });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.uuid).toBe("IIII9999JJJJ0000KKKK1111LLLL2222");
});

test("listTags counts entries per tag, most-used first", () => {
  const tags = listTags(db);
  const code = tags.find((t) => t.name === "code");
  expect(code!.entries).toBe(2);
  expect(tags.find((t) => t.name === "paris")!.entries).toBe(1);
  // 'code' (2) must rank before any 1-count tag.
  expect(tags[0]!.name).toBe("code");
});

test("searchEntries surfaces a malformed FTS5 query as a typed error", () => {
  // Unbalanced quote / dangling operator are FTS5 syntax errors, not DB faults.
  expect(() => searchEntries(db, '"unbalanced')).toThrow(InvalidSearchQueryError);
  expect(() => searchEntries(db, "foo AND")).toThrow(InvalidSearchQueryError);
  expect(() => searchEntries(db, '"unbalanced')).toThrow(/FTS5 syntax/);
  // A well-formed query still returns normally (no false positives).
  expect(() => searchEntries(db, "Paris")).not.toThrow();
});

test("place filter escapes LIKE wildcards, matching them literally", () => {
  // A dedicated DB so these wildcard-bearing places don't perturb the shared-db
  // assertions above.
  const wdb = openMirror(":memory:", { writable: true });
  const wild = {
    metadata: { version: "1.0" },
    entries: [
      {
        uuid: "WILD000000000000000000000000PCT1",
        creationDate: "2020-03-01T00:00:00Z",
        timeZone: "UTC",
        text: "percent place",
        location: { placeName: "50% off" },
      },
      {
        uuid: "WILD000000000000000000000000UND1",
        creationDate: "2020-03-02T00:00:00Z",
        timeZone: "UTC",
        text: "underscore place",
        location: { placeName: "a_b" },
      },
      {
        uuid: "WILD000000000000000000000000PLN1",
        creationDate: "2020-03-03T00:00:00Z",
        timeZone: "UTC",
        text: "plain place",
        location: { placeName: "xyz" },
      },
    ],
  } as DayOneExport;
  importExport(wdb, wild, "wild");

  // '%' is escaped → matches only the literal "50% off", not every row.
  expect(listEntries(wdb, { place: "%" }).map((e) => e.uuid)).toEqual(["WILD000000000000000000000000PCT1"]);
  // '_' is escaped → matches only the literal "a_b", not any single char.
  expect(listEntries(wdb, { place: "_" }).map((e) => e.uuid)).toEqual(["WILD000000000000000000000000UND1"]);
  // A normal substring still works.
  expect(listEntries(wdb, { place: "xy" }).map((e) => e.uuid)).toEqual(["WILD000000000000000000000000PLN1"]);
  wdb.close();
});
