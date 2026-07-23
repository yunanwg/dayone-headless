import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { importExport } from "../src/ingest/json-export/import.ts";
import { openMirror } from "../src/serve/db/open.ts";
import {
  COVERAGE_JOURNAL_MAX,
  COVERAGE_MONTH_MAX,
  COVERAGE_QUARTER_MAX,
  COVERAGE_YEAR_MAX,
  getEntriesAtSnapshot,
  JOURNAL_NAME_MAX_CHARS,
  type SnapshotErrorCode,
  SnapshotValidationError,
  sampleEntries,
} from "../src/serve/evidence.ts";
import {
  assertSyncAttempt,
  recordSyncOutcome,
  recordSyncStart,
  StaleSyncAttemptError,
} from "../src/sync-status.ts";
import type { DayOneEntry, DayOneExport } from "../src/types.ts";

const entry = (
  uuid: string,
  creationDate: string,
  text: string,
  fields: Partial<DayOneEntry> = {},
): DayOneEntry =>
  ({
    uuid,
    creationDate,
    timeZone: "UTC",
    text,
    ...fields,
  }) as DayOneEntry;

const alphaEntries = [
  entry("ALPHA-2020-01", "2020-01-10T00:00:00Z", "SYNTHETIC_ALPHA_JAN"),
  entry("ALPHA-2020-02", "2020-02-10T00:00:00Z", "   "),
  entry("ALPHA-2020-03", "2020-03-10T00:00:00Z", "SYNTHETIC_ALPHA_MAR"),
  entry("ALPHA-2020-06", "2020-06-10T00:00:00Z", "SYNTHETIC_ALPHA_JUN"),
  entry("ALPHA-2020-09", "2020-09-10T00:00:00Z", "SYNTHETIC_ALPHA_SEP"),
  entry("ALPHA-2021-01", "2021-01-10T00:00:00Z", "SYNTHETIC_ALPHA_STAR", {
    starred: true,
  }),
  entry("ALPHA-2021-04", "2021-04-10T00:00:00Z", "SYNTHETIC_ALPHA_APR"),
];

const betaEntries = [
  entry("BETA-2021-07", "2021-07-10T00:00:00Z", "SYNTHETIC_BETA_PIN", {
    isPinned: true,
  }),
  entry("BETA-2021-10", "2021-10-10T00:00:00Z", "SYNTHETIC_BETA_OCT"),
  entry("BETA-2022-01", "2022-01-10T00:00:00Z", "SYNTHETIC_BETA_JAN", {
    starred: true,
    tags: ["synthetic-focus"],
    location: { placeName: "Synthetic Harbor", longitude: 0, latitude: 0, country: "Synthetic" },
  }),
  entry("BETA-2022-02", "2022-02-10T00:00:00Z", "SYNTHETIC_BETA_FEB"),
  entry("BETA-2022-03", "2022-03-10T00:00:00Z", "SYNTHETIC_BETA_MAR"),
];

function asExport(entries: DayOneEntry[]): DayOneExport {
  return { metadata: { version: "synthetic" }, entries } as DayOneExport;
}

function buildCompleteMirror(reverse = false): Database {
  const db = openMirror(":memory:", { writable: true });
  const attemptedAt = "2026-01-01T00:00:00.000Z";
  const attempt = recordSyncStart(db, attemptedAt, "synthetic");
  db.transaction(() => {
    assertSyncAttempt(db, attempt.sync_generation);
    importExport(db, asExport(reverse ? [...alphaEntries].reverse() : alphaEntries), "journal-alpha");
    importExport(db, asExport(reverse ? [...betaEntries].reverse() : betaEntries), "journal-beta");
    importExport(db, asExport([]), "journal-empty");
  })();
  recordSyncOutcome(
    db,
    { status: "complete", attemptedAt, failedEntries: 0, source: "synthetic" },
    attempt.sync_generation,
  );
  return db;
}

function expectSnapshotError(run: () => unknown, code: SnapshotErrorCode): SnapshotValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotValidationError);
    expect((error as SnapshotValidationError).code).toBe(code);
    return error as SnapshotValidationError;
  }
  throw new Error("expected SnapshotValidationError");
}

test("sampleEntries rejects unknown, running, and failed mirrors", () => {
  const db = openMirror(":memory:", { writable: true });
  expectSnapshotError(() => sampleEntries(db), "snapshot_unavailable");

  const attempt = recordSyncStart(db, "2026-01-01T00:00:00.000Z", "synthetic");
  expectSnapshotError(() => sampleEntries(db), "snapshot_unavailable");
  recordSyncOutcome(
    db,
    {
      status: "failed",
      attemptedAt: "2026-01-01T00:00:00.000Z",
      failedEntries: 0,
      source: "synthetic",
    },
    attempt.sync_generation,
  );
  expectSnapshotError(() => sampleEntries(db, { mode: "best_effort" }), "snapshot_unavailable");
  db.close();
});

test("sampleEntries is repeatable, metadata-only, and explicit about coverage gaps", () => {
  const db = buildCompleteMirror();
  const first = sampleEntries(db, { target: 8 });
  const second = sampleEntries(db, { target: 8 });
  expect(second).toEqual(first);
  expect(first.target).toBe(8);
  expect(first.returned).toBe(8);
  expect(first.population).toEqual({
    matched_entries: 12,
    eligible_text_entries: 11,
    sample_eligible_entries: 11,
    no_eligible_text_entries: 1,
    unreadable_identifier_entries: 0,
    total_text_chars: expect.any(Number),
    first_date: "2020-01-10T00:00:00Z",
    last_date: "2022-03-10T00:00:00Z",
  });
  expect(first.snapshot.status).toBe("complete");
  expect(first.snapshot.sync_generation).toBe(1);
  expect(first.strategy.quota_plan).toEqual({
    marked: 2,
    journal: 1,
    year: 2,
    quarter: 2,
    month: 1,
  });

  for (const item of first.entries) {
    expect(item).not.toHaveProperty("text");
    expect(item).not.toHaveProperty("snippet");
    expect(item).not.toHaveProperty("raw");
    expect(item).not.toHaveProperty("rich_text");
    expect(item.evidence_ref).toMatch(/^d2e1_[A-Za-z0-9_-]{43}$/);
  }
  const serialized = JSON.stringify(first);
  expect(serialized).not.toContain("SYNTHETIC_ALPHA");
  expect(serialized).not.toContain("SYNTHETIC_BETA");

  expect(first.coverage.time.month.buckets.find((bucket) => bucket.key === "2020-02")).toMatchObject({
    status: "no_eligible_text",
    entries: 1,
    eligible_text_entries: 0,
  });
  expect(first.coverage.time.month.buckets.find((bucket) => bucket.key === "2020-04")).toMatchObject({
    status: "no_entries",
    entries: 0,
  });
  expect(first.coverage.time.month.buckets.some((bucket) => bucket.status === "unsampled_budget")).toBe(true);
  expect(first.coverage.journals.buckets.find((bucket) => bucket.key === "journal-empty")).toMatchObject({
    status: "no_entries",
    entries: 0,
  });
  expect(first.coverage.marked).toEqual([
    expect.objectContaining({ key: "starred", status: "represented" }),
    expect.objectContaining({ key: "pinned", status: "represented" }),
  ]);
  expect(first.coverage.marked.every((bucket) => bucket.sampled_entries > 0)).toBe(true);
  expect(new Set(first.coverage.time.month.buckets.map((bucket) => bucket.status))).toEqual(
    new Set(["represented", "unsampled_budget", "no_entries", "no_eligible_text"]),
  );

  expect(first.read_plan.snapshot_token_required).toBe(true);
  expect(first.read_plan.batches.flatMap((batch) => batch.uuids)).toEqual(
    first.entries.map((item) => item.uuid),
  );
  expect(first.read_plan.batches.every((batch) => batch.snapshot_token === first.snapshot.token)).toBe(true);
  db.close();
});

test("structured filters scope candidates, coverage, and population without exposing text", () => {
  const db = buildCompleteMirror();
  const period = sampleEntries(db, {
    target: 8,
    journal: "journal-beta",
    from: "2022-01-01",
    to: "2022-12-31",
  });
  expect(period.population).toMatchObject({
    matched_entries: 3,
    eligible_text_entries: 3,
    sample_eligible_entries: 3,
    no_eligible_text_entries: 0,
    unreadable_identifier_entries: 0,
    first_date: "2022-01-10T00:00:00Z",
    last_date: "2022-03-10T00:00:00Z",
  });
  expect(period.returned).toBe(3);
  expect(new Set(period.entries.map((item) => item.journal))).toEqual(new Set(["journal-beta"]));
  expect(period.coverage.journals.buckets.map((bucket) => bucket.key)).toEqual(["journal-beta"]);
  expect(period.coverage.time.year.buckets.map((bucket) => bucket.key)).toEqual(["2022"]);
  expect(period.coverage.time.month.buckets.at(-1)).toMatchObject({
    key: "2022-12",
    status: "no_entries",
  });
  expect(JSON.stringify(period)).not.toContain("SYNTHETIC_BETA");

  const counterexampleScope = sampleEntries(db, {
    target: 8,
    journal: "journal-beta",
    tag: "synthetic-focus",
    starred: true,
    from: "2022-01-01",
    to: "2022-12-31",
    place: "harbor",
  });
  expect(counterexampleScope.population.matched_entries).toBe(1);
  expect(counterexampleScope.entries.map((item) => item.uuid)).toEqual(["BETA-2022-01"]);
  expect(counterexampleScope.coverage.journals.buckets.map((bucket) => bucket.key)).toEqual(["journal-beta"]);
  expect(JSON.stringify(counterexampleScope)).not.toContain("SYNTHETIC_BETA_JAN");
  db.close();
});

test("Unicode whitespace-only bodies are ineligible without materializing text", () => {
  const db = openMirror(":memory:", { writable: true });
  const attemptedAt = "2026-01-01T00:00:00.000Z";
  const attempt = recordSyncStart(db, attemptedAt, "synthetic");
  db.transaction(() => {
    assertSyncAttempt(db, attempt.sync_generation);
    importExport(
      db,
      asExport([
        entry("BLANK-NEWLINE", "2024-01-01T00:00:00Z", "\n\r\n"),
        entry("BLANK-TAB", "2024-02-01T00:00:00Z", "\t\t"),
        entry("BLANK-NBSP", "2024-03-01T00:00:00Z", "\u00A0\u00A0"),
        entry("BLANK-IDEOGRAPHIC", "2024-04-01T00:00:00Z", "\u3000\u3000"),
        entry("MEANINGFUL", "2024-05-01T00:00:00Z", "\u3000SYNTHETIC_MEANINGFUL\u00A0"),
      ]),
      "unicode-whitespace",
    );
  })();
  recordSyncOutcome(
    db,
    { status: "complete", attemptedAt, failedEntries: 0, source: "synthetic" },
    attempt.sync_generation,
  );

  const result = sampleEntries(db, { target: 8 });
  expect(result.population).toMatchObject({
    matched_entries: 5,
    eligible_text_entries: 1,
    sample_eligible_entries: 1,
    no_eligible_text_entries: 4,
  });
  expect(result.entries.map((item) => item.uuid)).toEqual(["MEANINGFUL"]);
  for (const month of ["2024-01", "2024-02", "2024-03", "2024-04"]) {
    expect(result.coverage.time.month.buckets.find((bucket) => bucket.key === month)?.status).toBe(
      "no_eligible_text",
    );
  }
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_MEANINGFUL");
  db.close();
});

test("journal identity never collapses labels with the same truncated prefix", () => {
  const db = openMirror(":memory:", { writable: true });
  const attemptedAt = "2026-01-01T00:00:00.000Z";
  const attempt = recordSyncStart(db, attemptedAt, "synthetic");
  const prefix = "J".repeat(JOURNAL_NAME_MAX_CHARS);
  db.transaction(() => {
    assertSyncAttempt(db, attempt.sync_generation);
    importExport(
      db,
      asExport([entry("LONG-JOURNAL-A", "2024-01-01T00:00:00Z", "SYNTHETIC_LONG_A")]),
      `${prefix}A`,
    );
    importExport(
      db,
      asExport([entry("LONG-JOURNAL-B", "2024-02-01T00:00:00Z", "SYNTHETIC_LONG_B")]),
      `${prefix}B`,
    );
  })();
  recordSyncOutcome(
    db,
    { status: "complete", attemptedAt, failedEntries: 0, source: "synthetic" },
    attempt.sync_generation,
  );

  const result = sampleEntries(db, { target: 8 });
  expect(result.entries).toHaveLength(2);
  expect(new Set(result.entries.map((item) => item.journal))).toEqual(new Set([prefix]));
  expect(new Set(result.entries.map((item) => item.journal_ref)).size).toBe(2);
  expect(result.coverage.journals).toMatchObject({
    total: 2,
    returned: 2,
    omitted: 0,
    truncated: false,
  });
  expect(new Set(result.coverage.journals.buckets.map((bucket) => bucket.journal_ref)).size).toBe(2);
  expect(new Set(result.coverage.journals.buckets.map((bucket) => bucket.journal_id)).size).toBe(2);
  expect(result.coverage.journals.buckets.every((bucket) => bucket.key === prefix)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(`${prefix}A`);
  expect(JSON.stringify(result)).not.toContain(`${prefix}B`);

  const onlySecond = sampleEntries(db, { target: 8, journal: `${prefix}B` });
  expect(onlySecond.entries.map((item) => item.uuid)).toEqual(["LONG-JOURNAL-B"]);
  expect(onlySecond.coverage.journals).toMatchObject({ total: 1, returned: 1, truncated: false });
  expect(onlySecond.coverage.journals.buckets[0]!.journal_ref).toBe(
    result.entries.find((item) => item.uuid === "LONG-JOURNAL-B")!.journal_ref,
  );
  db.close();
});

test("coverage manifests cap journal and time buckets with explicit overflow metadata", () => {
  const db = openMirror(":memory:", { writable: true });
  const attemptedAt = "2026-01-01T00:00:00.000Z";
  const attempt = recordSyncStart(db, attemptedAt, "synthetic");
  db.transaction(() => {
    assertSyncAttempt(db, attempt.sync_generation);
    for (let index = 0; index < 70; index++) {
      importExport(
        db,
        asExport([
          entry(
            `OVERFLOW-${String(index).padStart(3, "0")}`,
            `${1900 + index}-01-01T00:00:00Z`,
            `SYNTHETIC_OVERFLOW_${index}`,
          ),
        ]),
        `overflow-journal-${String(index).padStart(3, "0")}`,
      );
    }
  })();
  recordSyncOutcome(
    db,
    { status: "complete", attemptedAt, failedEntries: 0, source: "synthetic" },
    attempt.sync_generation,
  );

  const result = sampleEntries(db, { target: 8 });
  expect(result.coverage.journals).toMatchObject({
    cap: COVERAGE_JOURNAL_MAX,
    total: 70,
    returned: COVERAGE_JOURNAL_MAX,
    omitted: 70 - COVERAGE_JOURNAL_MAX,
    truncated: true,
  });
  expect(result.coverage.time.year).toMatchObject({
    cap: COVERAGE_YEAR_MAX,
    total: 70,
    returned: COVERAGE_YEAR_MAX,
    omitted: 70 - COVERAGE_YEAR_MAX,
    truncated: true,
  });
  expect(result.coverage.time.quarter).toMatchObject({
    cap: COVERAGE_QUARTER_MAX,
    total: 277,
    returned: COVERAGE_QUARTER_MAX,
    omitted: 277 - COVERAGE_QUARTER_MAX,
    truncated: true,
  });
  expect(result.coverage.time.month).toMatchObject({
    cap: COVERAGE_MONTH_MAX,
    total: 829,
    returned: COVERAGE_MONTH_MAX,
    omitted: 829 - COVERAGE_MONTH_MAX,
    truncated: true,
  });
  const journalRefs = new Set(result.coverage.journals.buckets.map((bucket) => bucket.journal_ref));
  const years = new Set(result.coverage.time.year.buckets.map((bucket) => bucket.key));
  const months = new Set(result.coverage.time.month.buckets.map((bucket) => bucket.key));
  for (const sampled of result.entries) {
    expect(journalRefs.has(sampled.journal_ref)).toBe(true);
    expect(years.has(sampled.year!)).toBe(true);
    expect(months.has(sampled.month!)).toBe(true);
  }
  expect(result.warnings).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "coverage_truncated" })]),
  );

  const decade = sampleEntries(db, {
    target: 8,
    from: "1900-01-01",
    to: "1909-12-31",
  });
  expect(decade.coverage.time.month).toMatchObject({
    cap: COVERAGE_MONTH_MAX,
    total: 120,
    returned: 120,
    omitted: 0,
    truncated: false,
  });
  db.close();
});

test("sampleEntries emits bounded get_entries UUID batches with stable reference alignment", () => {
  const db = openMirror(":memory:", { writable: true });
  const attemptedAt = "2026-01-01T00:00:00.000Z";
  const attempt = recordSyncStart(db, attemptedAt, "synthetic");
  const entries = Array.from({ length: 60 }, (_, index) =>
    entry(
      `BATCH-${String(index).padStart(3, "0")}`,
      `2024-${String((index % 12) + 1).padStart(2, "0")}-01T00:00:00Z`,
      `SYNTHETIC_BATCH_${index}`,
    ),
  );
  db.transaction(() => {
    assertSyncAttempt(db, attempt.sync_generation);
    importExport(db, asExport(entries), "batch-journal");
  })();
  recordSyncOutcome(
    db,
    { status: "complete", attemptedAt, failedEntries: 0, source: "synthetic" },
    attempt.sync_generation,
  );

  const result = sampleEntries(db, { target: 60 });
  expect(result.returned).toBe(60);
  expect(result.read_plan.batches.map((batch) => batch.uuids.length)).toEqual([50, 10]);
  for (const batch of result.read_plan.batches) {
    expect(batch.uuids.length).toBe(batch.evidence_refs.length);
    expect(batch.snapshot_token).toBe(result.snapshot.token);
  }
  db.close();
});

test("sampling is independent of insertion order and uses stable evidence refs", () => {
  const forward = buildCompleteMirror(false);
  const reversed = buildCompleteMirror(true);
  const first = sampleEntries(forward, { target: 8 });
  const second = sampleEntries(reversed, { target: 8 });
  expect(second.entries).toEqual(first.entries);
  expect(second.coverage).toEqual(first.coverage);
  forward.close();
  reversed.close();
});

test("sparse samples return all eligible rows and target bounds are enforced", () => {
  const db = openMirror(":memory:", { writable: true });
  const attemptedAt = "2026-01-01T00:00:00.000Z";
  const attempt = recordSyncStart(db, attemptedAt, "synthetic");
  db.transaction(() => {
    assertSyncAttempt(db, attempt.sync_generation);
    importExport(
      db,
      asExport([
        entry("SPARSE-A", "2024-01-01T00:00:00Z", "SYNTHETIC_ONE"),
        entry("SPARSE-B", "2024-02-01T00:00:00Z", "SYNTHETIC_TWO"),
        entry("SPARSE-EMPTY", "2024-03-01T00:00:00Z", ""),
      ]),
      "sparse",
    );
    importExport(
      db,
      asExport([entry("X".repeat(129), "2024-04-01T00:00:00Z", "SYNTHETIC_UNREADABLE_IDENTIFIER")]),
      "J".repeat(300),
    );
  })();
  recordSyncOutcome(
    db,
    { status: "complete", attemptedAt, failedEntries: 0, source: "synthetic" },
    attempt.sync_generation,
  );

  const result = sampleEntries(db, { target: 8 });
  expect(result.returned).toBe(2);
  expect(result.entries.map((item) => item.uuid).sort()).toEqual(["SPARSE-A", "SPARSE-B"]);
  expect(result.population).toMatchObject({
    matched_entries: 4,
    eligible_text_entries: 3,
    sample_eligible_entries: 2,
    unreadable_identifier_entries: 1,
  });
  expect(result.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "unreadable_identifiers", affected_entries: 1 }),
      expect.objectContaining({ code: "metadata_truncated", affected_entries: 1 }),
    ]),
  );
  expect(result.read_plan.batches.flatMap((batch) => batch.uuids).every((uuid) => uuid.length <= 128)).toBe(
    true,
  );
  expect(result.coverage.journals.buckets.every((bucket) => bucket.key.length <= 256)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("SYNTHETIC_UNREADABLE_IDENTIFIER");
  expect(result.coverage.time.month.buckets.find((bucket) => bucket.key === "2024-03")?.status).toBe(
    "no_eligible_text",
  );
  expect(sampleEntries(db).target).toBe(48);
  expect(() => sampleEntries(db, { target: 7 })).toThrow(/target must be an integer/);
  expect(() => sampleEntries(db, { target: 97 })).toThrow(/target must be an integer/);
  db.close();
});

test("snapshot tokens go stale on running, completion, and degraded status transitions", () => {
  const db = buildCompleteMirror();
  const complete = sampleEntries(db, { target: 8 });
  const batch = complete.read_plan.batches[0]!;
  const read = getEntriesAtSnapshot(db, batch.snapshot_token, batch.uuids, {
    maxChars: 10,
    maxTotalChars: 30,
  });
  expect(read.snapshot.token).toBe(complete.snapshot.token);
  expect(read.entries.length).toBe(batch.uuids.length);
  expect(
    read.entries.reduce((sum, item) => sum + (item.text_truncation?.returned_chars ?? 0), 0),
  ).toBeLessThanOrEqual(30);

  const running = recordSyncStart(db, "2026-01-02T00:00:00.000Z", "synthetic");
  expect(running.sync_generation).toBe(2);
  expectSnapshotError(() => getEntriesAtSnapshot(db, complete.snapshot.token, batch.uuids), "snapshot_stale");
  expectSnapshotError(() => sampleEntries(db), "snapshot_unavailable");

  recordSyncOutcome(
    db,
    {
      status: "complete",
      attemptedAt: "2026-01-02T00:00:00.000Z",
      failedEntries: 0,
      source: "synthetic",
    },
    running.sync_generation,
  );
  expectSnapshotError(() => getEntriesAtSnapshot(db, complete.snapshot.token, batch.uuids), "snapshot_stale");
  const refreshed = sampleEntries(db, { target: 8 });
  expect(refreshed.snapshot.token).not.toBe(complete.snapshot.token);

  const degradedAttempt = recordSyncStart(db, "2026-01-03T00:00:00.000Z", "synthetic");
  recordSyncOutcome(
    db,
    {
      status: "degraded",
      attemptedAt: "2026-01-03T00:00:00.000Z",
      failedEntries: 2,
      source: "synthetic",
    },
    degradedAttempt.sync_generation,
  );
  expectSnapshotError(() => sampleEntries(db), "snapshot_degraded");
  const bestEffort = sampleEntries(db, { target: 8, mode: "best_effort" });
  expect(bestEffort.snapshot.status).toBe("degraded");
  expect(bestEffort.warnings[0]).toMatchObject({
    code: "degraded_snapshot",
    severity: "critical",
    failed_entries: 2,
  });
  expect(bestEffort.warnings[0]!.message).toContain("DEGRADED SNAPSHOT");
  expect(
    getEntriesAtSnapshot(db, bestEffort.snapshot.token, bestEffort.read_plan.batches[0]!.uuids).snapshot
      .status,
  ).toBe("degraded");
  db.close();
});

test("newer overlapping sync generations reject stale writes and outcomes", () => {
  const db = openMirror(":memory:", { writable: true });
  const first = recordSyncStart(db, "2026-01-01T00:00:00.000Z", "synthetic");
  const second = recordSyncStart(db, "2026-01-02T00:00:00.000Z", "synthetic");
  expect(first.sync_generation).toBe(1);
  expect(second.sync_generation).toBe(2);

  expect(() =>
    db.transaction(() => {
      assertSyncAttempt(db, first.sync_generation);
      db.query("INSERT INTO journal (name) VALUES ('stale-write')").run();
    })(),
  ).toThrow(StaleSyncAttemptError);
  expect(db.query("SELECT COUNT(*) AS n FROM journal").get()).toEqual({ n: 0 });

  expect(() =>
    recordSyncOutcome(
      db,
      {
        status: "complete",
        attemptedAt: "2026-01-01T00:00:00.000Z",
        failedEntries: 0,
        source: "synthetic",
      },
      first.sync_generation,
    ),
  ).toThrow(StaleSyncAttemptError);
  expect(
    recordSyncOutcome(
      db,
      {
        status: "complete",
        attemptedAt: "2026-01-02T00:00:00.000Z",
        failedEntries: 0,
        source: "synthetic",
      },
      second.sync_generation,
    ),
  ).toMatchObject({ status: "complete", sync_generation: 2 });
  db.close();
});
