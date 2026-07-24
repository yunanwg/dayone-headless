/**
 * Tests for the deterministic stratified coverage sampler (sampleEntries).
 *
 * A fully synthetic multi-year corpus is built in memory: no real journal
 * tokens, just year-keyed placeholder entries with monotonically increasing
 * dates so chronological order is unambiguous and the even-spacing math is
 * exactly assertable.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { importExport } from "../src/ingest/json-export/import.ts";
import { openMirror } from "../src/serve/db/open.ts";
import { sampleEntries } from "../src/serve/queries.ts";
import type { DayOneEntry, DayOneExport } from "../src/types.ts";

/** Entries per calendar year in the "primary" journal — total 38 across 5 years. */
const YEAR_COUNTS: Record<number, number> = { 2019: 2, 2020: 10, 2021: 5, 2022: 1, 2023: 20 };

const uuidFor = (year: number, day: number): string => `E-${year}-${String(day).padStart(3, "0")}`;

function makeEntry(year: number, day: number): DayOneEntry {
  return {
    uuid: uuidFor(year, day),
    // All in January so day ordering within a year is trivially chronological;
    // year then day gives a total order across the whole corpus.
    creationDate: `${year}-01-${String(day).padStart(2, "0")}T00:00:00Z`,
    timeZone: "UTC",
    text: `synthetic body ${year}-${day}`,
    tags: [`y${year}`],
    starred: day === 1,
    location: day === 1 ? { placeName: `place-${year}` } : undefined,
  } as unknown as DayOneEntry;
}

/** The whole primary corpus in chronological (creation_date, uuid) order. */
const chronological: string[] = Object.keys(YEAR_COUNTS)
  .map(Number)
  .sort((a, b) => a - b)
  .flatMap((year) => Array.from({ length: YEAR_COUNTS[year]! }, (_, i) => uuidFor(year, i + 1)));

let db: Database;

beforeAll(() => {
  db = openMirror(":memory:", { writable: true });
  const entries: DayOneEntry[] = [];
  for (const [year, count] of Object.entries(YEAR_COUNTS)) {
    for (let day = 1; day <= count; day++) entries.push(makeEntry(Number(year), day));
  }
  importExport(db, { metadata: { version: "test" }, entries } as DayOneExport, "primary");
  // A second journal so journal-scoped filtering has something to exclude.
  importExport(
    db,
    {
      metadata: { version: "test" },
      entries: [makeEntry(2020, 99)],
    } as unknown as DayOneExport,
    "secondary",
  );
});

const yearOf = (uuid: string): string => uuid.slice(2, 6);

test("the result is metadata-only entry summaries, never body text", () => {
  const sample = sampleEntries(db, 5, "year", { journal: "primary" });
  expect(sample.length).toBeGreaterThan(0);
  for (const entry of sample) {
    expect(entry).toHaveProperty("uuid");
    expect(entry).toHaveProperty("creation_date");
    expect(entry).toHaveProperty("journal");
    expect(entry).toHaveProperty("tags");
    expect(entry).toHaveProperty("starred");
    expect(entry).toHaveProperty("text_length");
    expect(entry).toHaveProperty("place_name");
    // No entry body / snippet leaks through the coverage sampler.
    expect(entry.text).toBeUndefined();
    expect(entry.snippet).toBeUndefined();
  }
});

test("it is deterministic: the same mirror and args return identical uuids", () => {
  const a = sampleEntries(db, 17, "year", { journal: "primary" });
  const b = sampleEntries(db, 17, "year", { journal: "primary" });
  expect(a.map((e) => e.uuid)).toEqual(b.map((e) => e.uuid));
});

test("results come back in chronological (creation_date, uuid) order", () => {
  const sample = sampleEntries(db, 12, "year", { journal: "primary" });
  const uuids = sample.map((e) => e.uuid);
  const sorted = [...uuids].sort((x, y) => chronological.indexOf(x) - chronological.indexOf(y));
  expect(uuids).toEqual(sorted);
});

test("with a budget >= the stratum count, every non-empty year is represented at least once", () => {
  const sample = sampleEntries(db, 12, "year", { journal: "primary" });
  const years = new Set(sample.map((e) => yearOf(e.uuid)));
  expect([...years].sort()).toEqual(["2019", "2020", "2021", "2022", "2023"]);
});

test("a budget smaller than the stratum count serves the oldest years first, one each", () => {
  const sample = sampleEntries(db, 3, "year", { journal: "primary" });
  expect(sample).toHaveLength(3);
  expect(sample.map((e) => yearOf(e.uuid))).toEqual(["2019", "2020", "2021"]);
});

test("the remaining budget is allocated proportionally, and never exceeds a stratum's size", () => {
  const sample = sampleEntries(db, 20, "year", { journal: "primary" });
  expect(sample).toHaveLength(20);
  const perYear = new Map<string, number>();
  for (const entry of sample) perYear.set(yearOf(entry.uuid), (perYear.get(yearOf(entry.uuid)) ?? 0) + 1);
  // The 1-entry year is capped at exactly one.
  expect(perYear.get("2022")).toBe(1);
  // The largest year draws strictly more than the smallest non-trivial ones.
  expect(perYear.get("2023")!).toBeGreaterThan(perYear.get("2019")!);
  expect(perYear.get("2023")!).toBeGreaterThanOrEqual(perYear.get("2020")!);
  // No year is ever over-allocated beyond the entries it actually holds.
  for (const [year, picks] of perYear) expect(picks).toBeLessThanOrEqual(YEAR_COUNTS[Number(year)]!);
});

test("n larger than the population returns every entry once (capped, deduplicated)", () => {
  const sample = sampleEntries(db, 200, "year", { journal: "primary" });
  const uuids = sample.map((e) => e.uuid);
  expect(uuids).toHaveLength(38);
  expect(new Set(uuids).size).toBe(38);
  expect([...uuids].sort()).toEqual([...chronological].sort());
});

test("stratify_by none spaces picks evenly across the whole corpus", () => {
  const sample = sampleEntries(db, 4, "none", { journal: "primary" });
  const size = chronological.length; // 38
  const expected = Array.from({ length: 4 }, (_, i) => chronological[Math.floor(((i + 0.5) * size) / 4)]!);
  expect(sample.map((e) => e.uuid)).toEqual(expected);
});

test("filters scope the sample: journal filtering excludes other journals", () => {
  const sample = sampleEntries(db, 50, "year", { journal: "secondary" });
  expect(sample).toHaveLength(1);
  expect(sample[0]!.uuid).toBe(uuidFor(2020, 99));
  expect(sample[0]!.journal).toBe("secondary");
});

test("a filter matching nothing yields an empty sample, not an error", () => {
  expect(sampleEntries(db, 10, "year", { journal: "does-not-exist" })).toEqual([]);
});

test("surfaced metadata reflects the stored entry (starred / place_name / tags)", () => {
  const sample = sampleEntries(db, 5, "year", { journal: "primary" });
  // 2022 holds a single entry (day 1), which is the starred + placed one; the
  // min-1-per-year rule guarantees it is sampled.
  const only2022 = sample.find((e) => e.uuid === uuidFor(2022, 1));
  expect(only2022).toBeDefined();
  expect(only2022!.starred).toBe(1);
  expect(only2022!.place_name).toBe("place-2022");
  expect(only2022!.tags).toEqual(["y2022"]);
});
