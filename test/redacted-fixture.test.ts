/**
 * Guards the committed redacted fixture. It is derived from a real (private)
 * export via scripts/redact-export.ts; these tests ensure it (a) still imports
 * cleanly and (b) never regresses into leaking un-redacted CJK/private text — the
 * exact failure a real bilingual journal exposed.
 */

import { test, expect } from "bun:test";
import { openMirror } from "../src/serve/db/open.ts";
import { importExport } from "../src/ingest/json-export/import.ts";
import type { DayOneExport } from "../src/types.ts";

const FIXTURE = new URL("./fixtures/redacted-sample.json", import.meta.url).pathname;
const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

test("redacted fixture imports and exercises media/tags/fts", async () => {
  const data = (await Bun.file(FIXTURE).json()) as DayOneExport;
  const db = openMirror(":memory:", { writable: true });
  const stats = importExport(db, data, "redacted-sample");
  expect(stats.entries).toBeGreaterThan(0);
  expect(stats.media).toBeGreaterThan(0);
  const fts = db.query("SELECT COUNT(*) c FROM entry_fts").get() as { c: number };
  expect(fts.c).toBeGreaterThan(0);
  db.close();
});

test("redacted fixture leaks no un-redacted CJK in private fields", async () => {
  const data = (await Bun.file(FIXTURE).json()) as DayOneExport;
  for (const e of data.entries) {
    expect(CJK.test(e.text ?? ""), "entry.text").toBe(false);
    expect(CJK.test(e.richText ?? ""), "entry.richText").toBe(false);
    for (const t of e.tags ?? []) expect(CJK.test(t), "tag").toBe(false);
    const L = e.location;
    if (L) {
      for (const v of [L.placeName, L.localityName, L.country, L.administrativeArea, L.userLabel]) {
        expect(CJK.test(v ?? ""), "location field").toBe(false);
      }
    }
  }
});
