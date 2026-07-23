/**
 * Conformance harness tests. Two layers:
 *   1. Pure classifier + synthetic two-mirror comparison — always run in CI.
 *   2. Real-data integration — runs ONLY when CONFORMANCE_REST_DB and
 *      CONFORMANCE_EXPORT_DB point at two local (gitignored) mirrors, so real
 *      journal data never has to enter the repo. Skipped otherwise.
 */

import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { compareMirrors, criticalDiffs, type EntryFacts } from "../scripts/conformance.ts";
import { importExport } from "../src/ingest/json-export/import.ts";
import { openMirror } from "../src/serve/db/open.ts";
import type { DayOneExport } from "../src/types.ts";

const facts = (over: Partial<EntryFacts>): EntryFacts => ({
  uuid: "U",
  text: "hello",
  rich_text: null,
  creation_date: "2024-01-01T10:00:00Z",
  starred: 0,
  pinned: 0,
  is_all_day: 0,
  tags: [],
  mediaIds: [],
  ...over,
});

test("criticalDiffs: identical entries have no diffs", () => {
  expect(criticalDiffs(facts({}), facts({}))).toEqual([]);
});

test("criticalDiffs: empty-string text equals NULL text", () => {
  expect(criticalDiffs(facts({ text: "" }), facts({ text: null }))).toEqual([]);
});

test("criticalDiffs: differing decrypted text is critical", () => {
  expect(criticalDiffs(facts({ text: "a" }), facts({ text: "b" }))).toContain("text");
});

test("criticalDiffs: differing rich_text is critical, but presence mismatch is not", () => {
  expect(criticalDiffs(facts({ rich_text: "{x}" }), facts({ rich_text: "{y}" }))).toContain("rich_text");
  expect(criticalDiffs(facts({ rich_text: "{x}" }), facts({ rich_text: null }))).toEqual([]);
});

test("criticalDiffs: tag and media identifier sets must match", () => {
  expect(criticalDiffs(facts({ tags: ["a", "b"] }), facts({ tags: ["a"] }))).toContain("tags");
  expect(criticalDiffs(facts({ mediaIds: ["m1"] }), facts({ mediaIds: ["m2"] }))).toContain(
    "media_identifiers",
  );
});

test("criticalDiffs: flags must match", () => {
  expect(criticalDiffs(facts({ starred: 1 }), facts({ starred: 0 }))).toContain("flags");
});

test("criticalDiffs: creation_date is compared for timed entries only", () => {
  const a = facts({ creation_date: "2024-01-01T10:00:00Z" });
  const b = facts({ creation_date: "2024-01-01T12:00:00Z" });
  expect(criticalDiffs(a, b)).toContain("creation_date");
  // Same timestamps, but marked all-day → the timestamp diff is tolerated.
  const aAllDay = facts({ creation_date: "2024-01-01T00:00:00Z", is_all_day: 1 });
  const bAllDay = facts({ creation_date: "2023-12-31T22:00:00Z", is_all_day: 1 });
  expect(criticalDiffs(aAllDay, bAllDay)).toEqual([]);
});

// --- synthetic two-mirror comparison (exercises loadFacts + compareMirrors) ---

const makeExport = (entries: DayOneExport["entries"]): DayOneExport =>
  ({ metadata: { version: "1.0" }, entries }) as DayOneExport;

let restDb: Database;
let exportDb: Database;
beforeAll(() => {
  // "REST" side.
  restDb = openMirror(":memory:", { writable: true });
  importExport(
    restDb,
    makeExport([
      { uuid: "E1", creationDate: "2024-01-01T10:00:00Z", text: "hello", tags: ["a", "b"] },
      { uuid: "E2", creationDate: "2024-02-02T00:00:00Z", text: "day", isAllDay: true },
    ] as DayOneExport["entries"]),
    "j",
  );
  // "export" oracle side: E1 loses a tag (critical); E2's all-day timestamp
  // shifts a day (benign); E3 exists only here (orphan).
  exportDb = openMirror(":memory:", { writable: true });
  importExport(
    exportDb,
    makeExport([
      { uuid: "E1", creationDate: "2024-01-01T10:00:00Z", text: "hello", tags: ["a"] },
      { uuid: "E2", creationDate: "2024-02-01T22:00:00Z", text: "day", isAllDay: true },
      { uuid: "E3", creationDate: "2024-03-03T10:00:00Z", text: "extra" },
    ] as DayOneExport["entries"]),
    "j",
  );
});

test("compareMirrors flags the tag diff and the orphan, tolerates the all-day shift", () => {
  const report = compareMirrors(restDb, exportDb);
  expect(report.restCount).toBe(2);
  expect(report.exportCount).toBe(3);
  expect(report.exportOnly).toEqual(["E3"]);
  expect(report.restOnly).toEqual([]);
  // Only E1 (tags) is critical; E2's all-day timestamp difference is tolerated.
  expect(report.critical).toEqual([{ uuid: "E1", kinds: ["tags"] }]);
});

// --- real-data integration (opt-in via env; skipped in CI) ---

const restPath = process.env.CONFORMANCE_REST_DB;
const exportPath = process.env.CONFORMANCE_EXPORT_DB;
const haveRealData = !!restPath && !!exportPath && existsSync(restPath) && existsSync(exportPath);

test.skipIf(!haveRealData)("real REST mirror is byte-conformant with the export oracle", () => {
  const report = compareMirrors(
    new Database(restPath as string, { readonly: true }),
    new Database(exportPath as string, { readonly: true }),
  );
  expect(report.restOnly).toEqual([]);
  expect(report.exportOnly).toEqual([]);
  expect(report.critical).toEqual([]);
});
