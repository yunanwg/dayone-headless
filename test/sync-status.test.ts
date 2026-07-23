import type { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntryRef } from "../src/ingest/rest/reader.ts";
import { sync } from "../src/ingest/rest/sync.ts";
import { openMirror } from "../src/serve/db/open.ts";
import { getFreshness, getSyncStatus } from "../src/serve/queries.ts";
import { recordSyncOutcome, recordSyncStart } from "../src/sync-status.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function mirrorPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "dayone-sync-status-"));
  tempDirs.push(dir);
  return join(dir, "mirror.db");
}

const ref = (entryId: string, revisionId: string): EntryRef => ({
  entryId,
  revisionId,
  deleted: false,
  editDate: 1_700_000_000_000,
});

const content = (entryId: string): string =>
  JSON.stringify({
    id: entryId,
    date: 1_700_000_000_000,
    body: `synthetic body for ${entryId}`,
  });

function fakeReader(getRefs: () => EntryRef[], decrypt: (entryId: string) => Promise<string | null>) {
  return {
    unlockKeys: async () => ({
      userPriv: {} as CryptoKey,
      journalPrivByFingerprint: new Map<string, CryptoKey>(),
      vaultKeyByJournalId: new Map<string, Uint8Array>(),
      journals: [
        {
          id: "SYNTHETIC-JOURNAL",
          name: null,
          encryption: { vault: { keys: [{}] } },
        },
      ],
    }),
    decryptJournalName: async () => "synthetic-journal",
    listEntries: async () => getRefs(),
    decryptEntry: async (_journalId: string, entryId: string) => decrypt(entryId),
  };
}

function readMirror(path: string, read: (db: Database) => void): void {
  const db = openMirror(path);
  try {
    read(db);
  } finally {
    db.close();
  }
}

test("complete → degraded preserves the last complete timestamp, then a retry completes", async () => {
  const path = mirrorPath();
  let refs = [ref("ENTRY-A", "r1")];
  const failing = new Set<string>();
  const fetched: string[] = [];
  const reader = fakeReader(
    () => refs,
    async (entryId) => {
      fetched.push(entryId);
      if (failing.has(entryId)) throw new Error("synthetic failure");
      return content(entryId);
    },
  );

  const first = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-01-01T00:00:00.000Z",
    reader,
  });
  expect(first.status).toBe("complete");
  expect(first.failed).toBe(0);
  expect(first.syncedAt).toBe("2026-01-01T00:00:00.000Z");

  refs = [ref("ENTRY-A", "r2"), ref("ENTRY-B", "r1")];
  failing.add("ENTRY-B");
  fetched.length = 0;
  const degraded = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-01-02T00:00:00.000Z",
    reader,
  });
  expect(degraded.status).toBe("degraded");
  expect(degraded.failed).toBe(1);
  expect(degraded.syncedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(fetched.sort()).toEqual(["ENTRY-A", "ENTRY-B"]);
  readMirror(path, (db) => {
    expect(getSyncStatus(db)).toEqual({
      status: "degraded",
      last_attempt_at: "2026-01-02T00:00:00.000Z",
      last_complete_at: "2026-01-01T00:00:00.000Z",
      failed_entries: 1,
    });
    expect(getFreshness(db).synced_at).toBe("2026-01-01T00:00:00.000Z");
  });

  failing.clear();
  fetched.length = 0;
  const retried = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-01-03T00:00:00.000Z",
    reader,
  });
  expect(fetched).toEqual(["ENTRY-B"]);
  expect(retried.status).toBe("complete");
  expect(retried.failed).toBe(0);
  expect(retried.syncedAt).toBe("2026-01-03T00:00:00.000Z");
  readMirror(path, (db) => {
    expect(getSyncStatus(db)).toEqual({
      status: "complete",
      last_attempt_at: "2026-01-03T00:00:00.000Z",
      last_complete_at: "2026-01-03T00:00:00.000Z",
      failed_entries: 0,
    });
  });
});

test("a first degraded attempt has no complete freshness timestamp", async () => {
  const path = mirrorPath();
  const reader = fakeReader(
    () => [ref("ENTRY-ONLY", "r1")],
    async () => {
      throw new Error("synthetic failure");
    },
  );

  const result = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-01T00:00:00.000Z",
    reader,
  });
  expect(result.status).toBe("degraded");
  expect(result.failed).toBe(1);
  expect(result.syncedAt).toBeNull();
  readMirror(path, (db) => {
    expect(getFreshness(db)).toEqual({
      synced_at: null,
      sync_status: {
        status: "degraded",
        last_attempt_at: "2026-02-01T00:00:00.000Z",
        last_complete_at: null,
        failed_entries: 1,
      },
    });
  });
});

test("a legacy synced_at-only mirror is reported as complete", () => {
  const db = openMirror(":memory:", { writable: true });
  db.query("INSERT INTO meta (key, value) VALUES ('synced_at', ?1)").run("2025-12-31T00:00:00.000Z");
  expect(getSyncStatus(db)).toEqual({
    status: "complete",
    last_attempt_at: "2025-12-31T00:00:00.000Z",
    last_complete_at: "2025-12-31T00:00:00.000Z",
    failed_entries: 0,
  });
  db.close();
});

test("a first running attempt is visible without claiming a complete snapshot", () => {
  const db = openMirror(":memory:", { writable: true });
  recordSyncStart(db, "2026-03-01T00:00:00.000Z", "rest");
  expect(getFreshness(db)).toEqual({
    synced_at: null,
    sync_status: {
      status: "running",
      last_attempt_at: "2026-03-01T00:00:00.000Z",
      last_complete_at: null,
      failed_entries: 0,
    },
  });
  db.close();
});

test("an in-flight sync is readable as running while preserving the previous complete snapshot", async () => {
  const path = mirrorPath();
  const initial = openMirror(path, { writable: true });
  recordSyncOutcome(initial, {
    status: "complete",
    attemptedAt: "2026-03-01T00:00:00.000Z",
    failedEntries: 0,
    source: "rest",
  });
  initial.close();

  let releaseUnlock!: () => void;
  const unlockGate = new Promise<void>((resolve) => {
    releaseUnlock = resolve;
  });
  let reportUnlockStarted!: () => void;
  const unlockStarted = new Promise<void>((resolve) => {
    reportUnlockStarted = resolve;
  });
  const baseReader = fakeReader(
    () => [],
    async (entryId) => content(entryId),
  );
  const blockedReader = {
    ...baseReader,
    unlockKeys: async () => {
      reportUnlockStarted();
      await unlockGate;
      return baseReader.unlockKeys();
    },
  };

  const inFlight = sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-03-02T00:00:00.000Z",
    reader: blockedReader,
  });
  await unlockStarted;
  try {
    readMirror(path, (db) => {
      expect(getFreshness(db)).toEqual({
        synced_at: "2026-03-01T00:00:00.000Z",
        sync_status: {
          status: "running",
          last_attempt_at: "2026-03-02T00:00:00.000Z",
          last_complete_at: "2026-03-01T00:00:00.000Z",
          failed_entries: 0,
        },
      });
    });
  } finally {
    releaseUnlock();
  }

  const completed = await inFlight;
  expect(completed.status).toBe("complete");
  expect(completed.syncedAt).toBe("2026-03-02T00:00:00.000Z");
});
