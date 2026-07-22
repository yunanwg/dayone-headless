/**
 * Tier A completeness gate — the guard against the lazy-cache gotcha (recon Q2:
 * a journal can sit at 0 cached entries until force-loaded). Pure, synthetic.
 */

import { test, expect } from "bun:test";
import { computeCompleteness, incompleteJournals } from "../src/ingest/tier-a/extract.ts";

function dump(over: Record<string, any> = {}) {
  return {
    entries: [] as any[],
    moments: [] as any[],
    journals: [
      { id: "J1", name: "Alpha" },
      { id: "J2", name: "Beta" },
    ],
    tags: [] as any[],
    entry_counts_cache: [
      { journal_id: "J1", count: 3, photo: 1, video: 0, audio: 0, pdf: 0 },
      { journal_id: "J2", count: 2, photo: 0, video: 0, audio: 0, pdf: 0 },
    ],
    ...over,
  };
}

test("a journal with zero cached entries is flagged incomplete (the empty-journal case)", () => {
  const rows = computeCompleteness(
    dump({
      entries: [
        { id: "e1", journal_id: "J1" },
        { id: "e2", journal_id: "J1" },
        { id: "e3", journal_id: "J1" },
        // J2 loads nothing but expects 2
      ],
    }),
  );
  const j1 = rows.find((r) => r.journalId === "J1")!;
  const j2 = rows.find((r) => r.journalId === "J2")!;
  expect(j1.complete).toBe(true);
  expect(j2.complete).toBe(false);
  expect(j2.expectedEntries).toBe(2);
  expect(j2.loadedEntries).toBe(0);
  expect(incompleteJournals(rows).map((r) => r.name)).toEqual(["Beta"]);
});

test("is_deleted entries do not count toward completeness", () => {
  const rows = computeCompleteness(
    dump({
      entries: [
        { id: "e1", journal_id: "J1" },
        { id: "e2", journal_id: "J1" },
        { id: "e3", journal_id: "J1", is_deleted: 1 }, // excluded
        { id: "x1", journal_id: "J2" },
        { id: "x2", journal_id: "J2" },
      ],
    }),
  );
  expect(rows.find((r) => r.journalId === "J1")!.loadedEntries).toBe(2);
  expect(rows.find((r) => r.journalId === "J1")!.complete).toBe(false); // 2 < 3
  expect(rows.find((r) => r.journalId === "J2")!.complete).toBe(true); // 2 >= 2
});
