/**
 * Serving-layer read-query tests, against the imported sample fixture.
 */

import { test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { importExport } from "../src/ingest/json-export/import.ts";
import { openMirror } from "../src/serve/db/open.ts";
import {
  listJournals,
  getEntry,
  searchEntries,
  onThisDay,
} from "../src/serve/queries.ts";
import type { DayOneExport } from "../src/types.ts";

const sample = JSON.parse(
  readFileSync(new URL("./fixtures/sample-export.json", import.meta.url), "utf8"),
) as DayOneExport;

let db: Database;

beforeAll(() => {
  db = openMirror(":memory:", { writable: true });
  importExport(db, sample, "sample");
});

test("listJournals returns one journal with its entry count", () => {
  const journals = listJournals(db);
  expect(journals).toHaveLength(1);
  expect(journals[0]!.name).toBe("sample");
  expect(journals[0]!.entries).toBe(3);
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

test("onThisDay matches month-day across years, newest first", () => {
  // 2021-07-22 and 2019-07-22 both fall on 07-22.
  const hits = onThisDay(db, "07-22");
  expect(hits).toHaveLength(2);
  expect(hits[0]!.creation_date > hits[1]!.creation_date).toBe(true);
  expect(hits[0]!.creation_date).toBe("2021-07-22T08:30:00Z");

  expect(onThisDay(db, "01-03")).toHaveLength(1);
  expect(onThisDay(db, "12-25")).toHaveLength(0);
});
