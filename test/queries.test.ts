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
