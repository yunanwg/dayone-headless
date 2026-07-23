/**
 * Serving-layer read-query tests, against the imported sample fixture.
 */

import type { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { importExport } from "../src/ingest/json-export/import.ts";
import { openMirror } from "../src/serve/db/open.ts";
import {
  getEntries,
  getEntry,
  getEntryMedia,
  getStats,
  InvalidSearchQueryError,
  listEntries,
  listEntriesPage,
  listJournals,
  listTags,
  onThisDay,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_QUERY_MAX_TERMS,
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

test("listEntriesPage reports exact non-final and final page coverage", () => {
  const first = listEntriesPage(db, { limit: 2, offset: 0 });
  expect(first.results).toHaveLength(2);
  expect(first.page_info).toEqual({ returned: 2, has_more: true, next_offset: 2 });

  const final = listEntriesPage(db, { limit: 2, offset: 2 });
  expect(final.results).toHaveLength(2);
  expect(final.page_info).toEqual({ returned: 2, has_more: false, next_offset: null });
});

test("listEntriesPage rejects pagination values that could stall or explode a CLI page", () => {
  expect(() => listEntriesPage(db, { limit: 0 })).toThrow(/limit must be an integer/);
  expect(() => listEntriesPage(db, { limit: 201 })).toThrow(/limit must be an integer/);
  expect(() => listEntriesPage(db, { offset: -1 })).toThrow(/offset must be a non-negative integer/);
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

test("searchEntries rejects oversized queries before SQLite with a typed error", () => {
  const tooLong = "a".repeat(SEARCH_QUERY_MAX_CHARS + 1);
  expect(() => searchEntries(db, tooLong)).toThrow(InvalidSearchQueryError);
  expect(() => searchEntries(db, tooLong)).toThrow(`maximum length is ${SEARCH_QUERY_MAX_CHARS} characters`);

  const atLimit = Array.from({ length: SEARCH_QUERY_MAX_TERMS }, (_, i) => `词${i}`).join(" ");
  const tooManyTerms = `${atLimit} 词extra`;
  expect(() => searchEntries(db, atLimit)).not.toThrow();
  expect(() => searchEntries(db, tooManyTerms)).toThrow(InvalidSearchQueryError);
  expect(() => searchEntries(db, tooManyTerms)).toThrow(
    `maximum ${SEARCH_QUERY_MAX_TERMS} whitespace-separated terms`,
  );
});

test("search/list/on_this_day summaries carry text_length; search carries journal + tags", () => {
  // text_length is present on every summary surface (item 3c).
  expect(listEntries(db, { limit: 1 })[0]!.text_length).toBeGreaterThan(0);
  expect(onThisDay(db, "07-22")[0]!.text_length).toBeGreaterThan(0);
  const hit = searchEntries(db, "Paris")[0]!;
  expect(hit.text_length).toBeGreaterThan(0);
  // search hits carry journal + tags on the FTS path (item 5).
  expect(hit.journal).toBe("sample");
  expect(hit.tags).toEqual(["paris", "travel"]);
});

test("listEntries include_text returns full body; order_by=length sorts by LENGTH(text)", () => {
  const withText = listEntries(db, { include_text: true, limit: 1 });
  expect(withText[0]!.text).toBe("New year, homelab plans: headless journal reader.");
  expect(withText[0]!.snippet).toBeUndefined();
  // Longest body first regardless of date.
  const byLen = listEntries(db, { order_by: "length" });
  for (let i = 1; i < byLen.length; i++) {
    expect(byLen[i - 1]!.text_length!).toBeGreaterThanOrEqual(byLen[i]!.text_length!);
  }
});

test("listEntriesPage bounds emoji/CJK bodies per entry and across the page", () => {
  const unicodeDb = openMirror(":memory:", { writable: true });
  importExport(
    unicodeDb,
    {
      metadata: { version: "1.0" },
      entries: [
        {
          uuid: "PAGE0000000000000000000000000001",
          creationDate: "2024-03-01T00:00:00Z",
          timeZone: "UTC",
          text: "甲😀乙丙",
        },
        {
          uuid: "PAGE0000000000000000000000000002",
          creationDate: "2024-02-01T00:00:00Z",
          timeZone: "UTC",
          text: "天地玄黄",
        },
        {
          uuid: "PAGE0000000000000000000000000003",
          creationDate: "2024-01-01T00:00:00Z",
          timeZone: "UTC",
          text: "好",
        },
      ],
    } as unknown as DayOneExport,
    "unicode-page",
  );

  const first = listEntriesPage(unicodeDb, {
    include_text: true,
    limit: 2,
    max_chars_per_entry: 3,
    max_total_chars: 5,
  });
  expect(first.results[0]!.text).toBe("甲😀乙");
  expect(first.results[0]!.text_truncation).toEqual({
    truncated: true,
    original_chars: 4,
    returned_chars: 3,
    limited_by: ["per_entry"],
  });
  expect(first.results[1]!.text).toBe("天地");
  expect(first.results[1]!.text_truncation).toEqual({
    truncated: true,
    original_chars: 4,
    returned_chars: 2,
    limited_by: ["per_entry", "total"],
  });
  expect(first.page_info).toEqual({ returned: 2, has_more: true, next_offset: 2 });

  const final = listEntriesPage(unicodeDb, {
    include_text: true,
    limit: 2,
    offset: 2,
    max_chars_per_entry: 3,
    max_total_chars: 5,
  });
  expect(final.results[0]!.text).toBe("好");
  expect(final.results[0]!.text_truncation).toEqual({
    truncated: false,
    original_chars: 1,
    returned_chars: 1,
    limited_by: [],
  });
  expect(final.page_info).toEqual({ returned: 1, has_more: false, next_offset: null });
  unicodeDb.close();
});

test("getEntry returns a curated shape with typed columns + inlined media", () => {
  const e = getEntry(db, "AAAA1111BBBB2222CCCC3333DDDD4444")!;
  expect(e.journal).toBe("sample");
  expect(e.starred).toBe(true);
  expect(e.tags).toEqual(["paris", "travel"]);
  expect(e.location).toEqual({
    place_name: "Rive Gauche",
    locality_name: "Paris",
    country: "France",
    latitude: 48.8566,
    longitude: 2.3522,
  });
  expect(e.weather).toEqual({ code: "clear", temperature_c: 22.5 });
  expect(e.media).toHaveLength(1);
  expect(e.media[0]!.identifier).toBe("PHOTO-ID-1");
  expect(e.text_length).toBe(e.text!.length);
  // Heavy fields are opt-in.
  expect(e.rich_text).toBeUndefined();
  expect(e.raw).toBeUndefined();
  // Entry with no location/weather → nulls, not empty objects.
  const bare = getEntry(db, "EEEE5555FFFF6666GGGG7777HHHH8888")!;
  expect(bare.location).toBeNull();
  expect(bare.weather).toBeNull();
  expect(getEntry(db, "does-not-exist")).toBeNull();
});

test("getEntry include_raw / include_rich_text opt back into heavy fields", () => {
  const e = getEntry(db, "AAAA1111BBBB2222CCCC3333DDDD4444", { includeRaw: true })!;
  expect((e.raw as { uuid: string }).uuid).toBe("AAAA1111BBBB2222CCCC3333DDDD4444");
});

test("getEntries batches in order, truncates text with metadata, and reports missing", () => {
  const { entries, missing } = getEntries(
    db,
    ["IIII9999JJJJ0000KKKK1111LLLL2222", "nope", "AAAA1111BBBB2222CCCC3333DDDD4444"],
    { maxChars: 10 },
  );
  // Requested order preserved, unknown uuid skipped (not thrown).
  expect(entries.map((e) => e.uuid)).toEqual([
    "IIII9999JJJJ0000KKKK1111LLLL2222",
    "AAAA1111BBBB2222CCCC3333DDDD4444",
  ]);
  expect(missing).toEqual(["nope"]);
  // Body is bounded without an in-band note; metadata carries exact completeness.
  expect(entries[0]!.text).toHaveLength(10);
  expect(entries[0]!.text_length).toBeGreaterThan(10);
  expect(entries[0]!.text_truncation).toEqual({
    truncated: true,
    original_chars: entries[0]!.text_length,
    returned_chars: 10,
    limited_by: ["per_entry"],
  });
});

test("getEntries bounds echoed missing identifiers and rejects legacy heavy batch fields", () => {
  expect(() => getEntries(db, ["x".repeat(129)])).toThrow(/uuid must be at most 128/);
  expect(() =>
    getEntries(db, ["AAAA1111BBBB2222CCCC3333DDDD4444"], {
      includeRaw: true,
    }),
  ).toThrow(/call getEntry for one entry at a time/);
  expect(() =>
    getEntries(db, ["AAAA1111BBBB2222CCCC3333DDDD4444"], {
      includeRichText: true,
    }),
  ).toThrow(/call getEntry for one entry at a time/);
});

test("getEntries truncates by Unicode code points without splitting surrogate pairs", () => {
  const unicodeDb = openMirror(":memory:", { writable: true });
  importExport(
    unicodeDb,
    {
      metadata: { version: "1.0" },
      entries: [
        {
          uuid: "UNICODE000000000000000000000001",
          creationDate: "2024-01-01T00:00:00Z",
          timeZone: "UTC",
          text: "a😀b",
        },
      ],
    } as unknown as DayOneExport,
    "unicode",
  );

  const { entries } = getEntries(unicodeDb, ["UNICODE000000000000000000000001"], {
    maxChars: 2,
  });
  expect(entries[0]!.text).toBe("a😀");
  expect(entries[0]!.text_length).toBe(3);
  expect(entries[0]!.text_truncation).toEqual({
    truncated: true,
    original_chars: 3,
    returned_chars: 2,
    limited_by: ["per_entry"],
  });
  unicodeDb.close();
});

test("getEntries enforces a combined Unicode budget and reports no-truncation items", () => {
  const unicodeDb = openMirror(":memory:", { writable: true });
  importExport(
    unicodeDb,
    {
      metadata: { version: "1.0" },
      entries: [
        {
          uuid: "BATCH000000000000000000000000001",
          creationDate: "2024-02-01T00:00:00Z",
          timeZone: "UTC",
          text: "甲😀乙",
        },
        {
          uuid: "BATCH000000000000000000000000002",
          creationDate: "2024-01-01T00:00:00Z",
          timeZone: "UTC",
          text: "天地玄",
        },
      ],
    } as unknown as DayOneExport,
    "unicode-batch",
  );

  const { entries } = getEntries(
    unicodeDb,
    ["BATCH000000000000000000000000001", "BATCH000000000000000000000000002"],
    { maxChars: 3, maxTotalChars: 4 },
  );
  expect(entries[0]!.text).toBe("甲😀乙");
  expect(entries[0]!.text_truncation).toEqual({
    truncated: false,
    original_chars: 3,
    returned_chars: 3,
    limited_by: [],
  });
  expect(entries[1]!.text).toBe("天");
  expect(entries[1]!.text_truncation).toEqual({
    truncated: true,
    original_chars: 3,
    returned_chars: 1,
    limited_by: ["total"],
  });
  unicodeDb.close();
});

test("getStats maps the corpus by year and by journal", () => {
  const byYear = getStats(db, "year");
  expect(byYear.overall.entries).toBe(4);
  expect(byYear.overall.first_date).toBe("2019-07-22T20:15:00Z");
  expect(byYear.overall.last_date).toBe("2023-01-03T12:00:00Z");
  expect(byYear.overall.total_text_chars).toBeGreaterThan(0);
  expect(byYear.buckets.map((b) => b.key)).toEqual(["2019", "2021", "2022", "2023"]);
  const y2021 = byYear.buckets.find((b) => b.key === "2021")!;
  expect(y2021.entries).toBe(1);
  expect(y2021.starred).toBe(1);
  // Grouping by journal, with a filter applied.
  const byJournal = getStats(db, "journal", { starred: true });
  expect(byJournal.overall.entries).toBe(1);
  expect(byJournal.buckets).toEqual([
    { key: "sample", entries: 1, text_chars: expect.any(Number), starred: 1 },
  ]);
});

test("CJK search: 2-char term recall, mixed queries, filters, FTS path intact", () => {
  const cdb = openMirror(":memory:", { writable: true });
  const cjk = {
    metadata: { version: "1.0" },
    entries: [
      {
        uuid: "CJK000000000000000000000000COFF1",
        creationDate: "2022-01-01T00:00:00Z",
        timeZone: "UTC",
        text: "今天喝了一杯咖啡，很香。coffee time.",
        tags: ["drink"],
      },
      {
        uuid: "CJK000000000000000000000000COFF2",
        creationDate: "2023-01-01T00:00:00Z",
        timeZone: "UTC",
        text: "和朋友一起喝咖啡聊天。",
      },
      {
        uuid: "CJK000000000000000000000000PLN01",
        creationDate: "2021-01-01T00:00:00Z",
        timeZone: "UTC",
        text: "A plain english entry about tea, no coffee.",
      },
    ],
  } as unknown as DayOneExport;
  importExport(cdb, cjk, "cjk");

  // 2-char CJK term recalls both matching entries (FTS MATCH would return 0),
  // newest first, with a bracketed hand-built snippet.
  const coffee = searchEntries(cdb, "咖啡");
  expect(coffee.map((e) => e.uuid)).toEqual([
    "CJK000000000000000000000000COFF2",
    "CJK000000000000000000000000COFF1",
  ]);
  expect(coffee[0]!.snippet).toContain("[咖啡]");
  expect(coffee[0]!.journal).toBe("cjk");

  // Mixed CJK + latin: every term must match (AND) → only the entry with both.
  expect(searchEntries(cdb, "咖啡 coffee").map((e) => e.uuid)).toEqual(["CJK000000000000000000000000COFF1"]);
  // 2-char term that hits one entry only.
  expect(searchEntries(cdb, "朋友").map((e) => e.uuid)).toEqual(["CJK000000000000000000000000COFF2"]);

  // Structured filters apply identically on the CJK path.
  expect(searchEntries(cdb, "咖啡", { tag: "drink" }).map((e) => e.uuid)).toEqual([
    "CJK000000000000000000000000COFF1",
  ]);
  expect(searchEntries(cdb, "咖啡", { from: "2023-01-01" }).map((e) => e.uuid)).toEqual([
    "CJK000000000000000000000000COFF2",
  ]);

  // Pure-latin query still routes through FTS5 (relevance ranking, snippet()).
  const latin = searchEntries(cdb, "coffee");
  expect(latin.length).toBeGreaterThan(0);
  expect(latin.every((e) => typeof e.snippet === "string")).toBe(true);
  cdb.close();
});

test("CJK snippets preserve source offsets when Unicode case folding changes length", () => {
  const unicodeDb = openMirror(":memory:", { writable: true });
  importExport(
    unicodeDb,
    {
      metadata: { version: "1.0" },
      entries: [
        {
          uuid: "CJKUNICODEOFFSET000000000000001",
          creationDate: "2024-01-01T00:00:00Z",
          timeZone: "UTC",
          text: "İ咖啡",
        },
      ],
    } as unknown as DayOneExport,
    "unicode",
  );

  const hit = searchEntries(unicodeDb, "咖啡")[0]!;
  expect(hit.snippet).toBe("İ[咖啡]");
  unicodeDb.close();
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
