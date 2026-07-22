/**
 * Browser-ingester mapper — the two recon-driven rules wired after the mapper was drafted:
 * millisecond-stripped dates (Q5) and is_deleted exclusion (Q2). Synthetic
 * IndexedDB-shaped records only.
 */

import { expect, test } from "bun:test";
import { mapStoresToExports } from "../src/ingest/browser/map.ts";

function entryRec(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: "idnormal000000001",
    journal_id: "J1",
    date: 1725341954000, // 2024-09-03T05:39:14.000Z
    edit_date: 1725341954123,
    body: "synthetic body",
    is_pinned: 0,
    is_starred: 0,
    is_all_day: 0,
    timezone: "Europe/Paris",
    ...over,
  };
}
const journals = [{ id: "J1", name: "Test" }];

test("dates are ISO-8601 UTC with milliseconds stripped (matches export format)", () => {
  const out = mapStoresToExports({
    entries: [entryRec({ date: 1725341954123 })], // has .123 ms
    moments: [],
    journals,
  });
  const e = out[0]!.export.entries[0]!;
  expect(e.creationDate).toBe("2024-09-03T05:39:14Z"); // not …14.123Z / …14.000Z
  expect(e.creationDate).not.toMatch(/\.\d{3}Z$/);
  expect(e.modifiedDate).toBe("2024-09-03T05:39:14Z");
});

test("is_deleted entries are excluded from the mirror", () => {
  const out = mapStoresToExports({
    entries: [
      entryRec({ id: "keep1", is_deleted: 0 }),
      entryRec({ id: "gone1", is_deleted: 1 }),
      entryRec({ id: "keep2" }), // field absent → kept
    ],
    moments: [],
    journals,
  });
  const uuids = out.flatMap((j) => j.export.entries.map((e) => e.uuid));
  expect(uuids.sort()).toEqual(["keep1", "keep2"]);
});
