import type { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { importExport } from "../src/ingest/json-export/import.ts";
import type { EntryRef } from "../src/ingest/rest/reader.ts";
import { sync } from "../src/ingest/rest/sync.ts";
import { openMirror } from "../src/serve/db/open.ts";
import { getFreshness, getSyncStatus } from "../src/serve/queries.ts";
import {
  readRestVerificationState,
  readRestVerificationVersion,
  recordSyncOutcome,
  recordSyncStart,
} from "../src/sync-status.ts";
import { REST_CONTENT_VERIFICATION_VERSION, type VerificationPolicy } from "../src/verification.ts";

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

function fakeReader(
  getRefs: () => EntryRef[],
  decrypt: (entryId: string) => Promise<string | null>,
  policy: VerificationPolicy = "compatible",
  onDecrypt?: (entryId: string, authenticity: { unsignedAccepted: number }) => void,
) {
  let authenticity = { policy, verified: 0, unsignedAccepted: 0 };
  return {
    signaturePolicy: policy,
    unlockKeys: async () => {
      authenticity = { policy, verified: 0, unsignedAccepted: 0 };
      return {
        userPriv: {} as CryptoKey,
        journalKeyByJournalId: new Map<string, Map<string, never>>(),
        vaultKeyByJournalId: new Map<string, Uint8Array>(),
        authenticity,
        journals: [
          {
            id: "SYNTHETIC-JOURNAL",
            name: null,
            encryption: { vault: { keys: [{}] } },
          },
        ],
      };
    },
    decryptJournalName: async () => "synthetic-journal",
    listEntries: async () => getRefs(),
    decryptEntry: async (_journalId: string, entryId: string) => {
      onDecrypt?.(entryId, authenticity);
      return decrypt(entryId);
    },
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

function seedOrphan(path: string, journalName: string, entryId: string): void {
  const db = openMirror(path, { writable: true });
  try {
    importExport(
      db,
      {
        metadata: { version: "synthetic" },
        entries: [
          {
            uuid: entryId,
            creationDate: "2026-01-01T00:00:00Z",
            modifiedDate: "2026-01-01T00:00:00Z",
            timeZone: "Etc/UTC",
            text: "synthetic orphan",
            starred: false,
            isPinned: false,
            isAllDay: false,
            creationDevice: "synthetic-device",
            creationDeviceType: "synthetic",
            creationOSName: "synthetic-os",
            creationOSVersion: "1",
          },
        ],
      },
      journalName,
    );
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
      sync_generation: 2,
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
      sync_generation: 3,
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
        sync_generation: 1,
      },
    });
  });
});

test("sync progress reports counts without journal names or entry identifiers", async () => {
  const path = mirrorPath();
  const progress: string[] = [];
  const reader = fakeReader(
    () => [ref("PRIVATE-ENTRY-ID", "r1")],
    async (entryId) => content(entryId),
  );
  await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-02T00:00:00.000Z",
    reader,
    onProgress: (message) => progress.push(message),
  });
  const output = progress.join("\n");
  expect(output).toContain("journal 1");
  expect(output).not.toContain("synthetic-journal");
  expect(output).not.toContain("SYNTHETIC-JOURNAL");
  expect(output).not.toContain("PRIVATE-ENTRY-ID");
});

test("a legacy synced_at-only mirror is reported as complete", () => {
  const db = openMirror(":memory:", { writable: true });
  db.query("INSERT INTO meta (key, value) VALUES ('synced_at', ?1)").run("2025-12-31T00:00:00.000Z");
  expect(getSyncStatus(db)).toEqual({
    status: "complete",
    last_attempt_at: "2025-12-31T00:00:00.000Z",
    last_complete_at: "2025-12-31T00:00:00.000Z",
    failed_entries: 0,
    sync_generation: 0,
  });
  db.close();
});

test("an old REST-complete mirror is degraded until every unchanged entry is reverified", async () => {
  const path = mirrorPath();
  const refs = [ref("ENTRY-OLD", "r1")];
  const fetched: string[] = [];
  let fail = false;
  const reader = fakeReader(
    () => refs,
    async (entryId) => {
      fetched.push(entryId);
      if (fail) throw new Error("synthetic revalidation failure");
      return content(entryId);
    },
  );

  await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-10T00:00:00.000Z",
    reader,
  });
  fetched.length = 0;
  await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-11T00:00:00.000Z",
    reader,
  });
  expect(fetched).toEqual([]);

  const legacy = openMirror(path, { writable: true });
  legacy
    .query(
      `UPDATE meta SET value = '0'
       WHERE key = 'rest_content_verification_version'`,
    )
    .run();
  expect(getSyncStatus(legacy)).toMatchObject({
    status: "degraded",
    last_complete_at: "2026-02-11T00:00:00.000Z",
  });
  legacy.close();

  fail = true;
  const degraded = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-12T00:00:00.000Z",
    reader,
  });
  expect(degraded.status).toBe("degraded");
  readMirror(path, (db) => {
    expect(readRestVerificationVersion(db)).toBe(0);
  });

  fail = false;
  fetched.length = 0;
  const completed = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-13T00:00:00.000Z",
    reader,
  });
  expect(fetched).toEqual(["ENTRY-OLD"]);
  expect(completed.status).toBe("complete");
  readMirror(path, (db) => {
    expect(readRestVerificationVersion(db)).toBe(REST_CONTENT_VERIFICATION_VERSION);
  });
});

test("a feed failure cannot delete absent entries or advance completeness", async () => {
  const path = mirrorPath();
  const healthy = fakeReader(
    () => [ref("ENTRY-PRESERVED", "r1")],
    async (entryId) => content(entryId),
  );
  await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-20T00:00:00.000Z",
    reader: healthy,
  });

  const invalidFeed = {
    ...healthy,
    listEntries: async () => {
      throw new Error("synthetic malformed feed");
    },
  };
  await expect(
    sync("synthetic-key", {
      mirrorPath: path,
      nowIso: "2026-02-21T00:00:00.000Z",
      reader: invalidFeed,
    }),
  ).rejects.toThrow("synthetic malformed feed");

  readMirror(path, (db) => {
    expect(db.query("SELECT COUNT(*) AS count FROM entry WHERE uuid = 'ENTRY-PRESERVED'").get()).toEqual({
      count: 1,
    });
    expect(getSyncStatus(db)).toMatchObject({
      status: "failed",
      last_complete_at: "2026-02-20T00:00:00.000Z",
    });
  });
});

test("empty and prefix feeds preserve absent stored entries and cannot advance completeness", async () => {
  for (const refsAfter of [[], [ref("ENTRY-A", "r1")]]) {
    const path = mirrorPath();
    let refs = [ref("ENTRY-A", "r1"), ref("ENTRY-B", "r1")];
    const reader = fakeReader(
      () => refs,
      async (entryId) => content(entryId),
    );
    await sync("synthetic-key", {
      mirrorPath: path,
      nowIso: "2026-02-20T00:00:00.000Z",
      reader,
    });

    refs = refsAfter;
    const degraded = await sync("synthetic-key", {
      mirrorPath: path,
      nowIso: "2026-02-21T00:00:00.000Z",
      reader,
    });
    expect(degraded.status).toBe("degraded");
    expect(degraded.failed).toBe(refsAfter.length === 0 ? 2 : 1);
    expect(degraded.removed).toBe(0);
    expect(degraded.lastCompleteAt).toBe("2026-02-20T00:00:00.000Z");
    readMirror(path, (db) => {
      expect(db.query("SELECT uuid FROM entry ORDER BY uuid").all() as { uuid: string }[]).toEqual([
        { uuid: "ENTRY-A" },
        { uuid: "ENTRY-B" },
      ]);
    });
  }
});

test("an empty first feed cannot establish a complete mirror", async () => {
  const path = mirrorPath();
  const reader = fakeReader(
    () => [],
    async (entryId) => content(entryId),
  );
  const result = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-19T00:00:00.000Z",
    reader,
  });
  expect(result).toMatchObject({
    status: "degraded",
    failed: 1,
    lastCompleteAt: null,
  });
});

test("an empty first journal set cannot establish a complete mirror", async () => {
  const path = mirrorPath();
  const reader = fakeReader(
    () => [ref("UNREACHABLE", "r1")],
    async (entryId) => content(entryId),
  );
  const result = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-19T00:00:00.000Z",
    reader: {
      ...reader,
      unlockKeys: async () => ({
        ...(await reader.unlockKeys()),
        journals: [],
      }),
    },
  });
  expect(result).toMatchObject({
    status: "degraded",
    failed: 1,
    lastCompleteAt: null,
  });
});

test("an explicit deletion tombstone remains the only feed-driven removal signal", async () => {
  const path = mirrorPath();
  let refs = [ref("ENTRY-A", "r1")];
  const reader = fakeReader(
    () => refs,
    async (entryId) => content(entryId),
  );
  await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-20T00:00:00.000Z",
    reader,
  });
  refs = [{ ...ref("ENTRY-A", "r2"), deleted: true }];
  const completed = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-21T00:00:00.000Z",
    reader,
  });
  expect(completed).toMatchObject({ status: "complete", removed: 1, failed: 0 });
  readMirror(path, (db) => {
    expect(db.query("SELECT COUNT(*) AS count FROM entry").get()).toEqual({ count: 0 });
  });
});

test("an explicit tombstone deletes a name-mapped entry missing entry_sync state", async () => {
  const path = mirrorPath();
  seedOrphan(path, "synthetic-journal", "ORPHAN-DELETED");
  const tombstone = { ...ref("ORPHAN-DELETED", "r2"), deleted: true };
  const reader = fakeReader(
    () => [tombstone],
    async (entryId) => content(entryId),
    "strict",
  );
  const result = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-22T00:00:00.000Z",
    reader,
  });
  expect(result).toMatchObject({ status: "complete", removed: 1, failed: 0 });
  readMirror(path, (db) => {
    expect(db.query("SELECT COUNT(*) AS count FROM entry WHERE uuid = 'ORPHAN-DELETED'").get()).toEqual({
      count: 0,
    });
  });
});

test("a mapped orphan is revalidated and adopted, while an unmappable orphan degrades", async () => {
  const adoptPath = mirrorPath();
  seedOrphan(adoptPath, "synthetic-journal", "ORPHAN-ADOPTED");
  const adopter = fakeReader(
    () => [ref("ORPHAN-ADOPTED", "r2")],
    async (entryId) => content(entryId),
    "strict",
  );
  const adopted = await sync("synthetic-key", {
    mirrorPath: adoptPath,
    nowIso: "2026-02-23T00:00:00.000Z",
    reader: adopter,
  });
  expect(adopted).toMatchObject({ status: "complete", changed: 1, failed: 0 });
  readMirror(adoptPath, (db) => {
    expect(
      db.query("SELECT journal_id, revision_id FROM entry_sync WHERE uuid = ?").get("ORPHAN-ADOPTED"),
    ).toEqual({ journal_id: "SYNTHETIC-JOURNAL", revision_id: "r2" });
  });

  const unmappablePath = mirrorPath();
  seedOrphan(unmappablePath, "different-synthetic-journal", "ORPHAN-PRESERVED");
  const unmappable = fakeReader(
    () => [ref("NEW-ENTRY", "r1")],
    async (entryId) => content(entryId),
    "strict",
  );
  const degraded = await sync("synthetic-key", {
    mirrorPath: unmappablePath,
    nowIso: "2026-02-24T00:00:00.000Z",
    reader: unmappable,
  });
  expect(degraded).toMatchObject({ status: "degraded", failed: 1 });
  readMirror(unmappablePath, (db) => {
    expect(db.query("SELECT COUNT(*) AS count FROM entry WHERE uuid = 'ORPHAN-PRESERVED'").get()).toEqual({
      count: 1,
    });
  });
});

test("strict policy upgrade forces full revalidation and persists its strength only on success", async () => {
  const path = mirrorPath();
  const refs = [ref("ENTRY-A", "r1")];
  const compatible = fakeReader(
    () => refs,
    async (entryId) => content(entryId),
  );
  await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-20T00:00:00.000Z",
    reader: compatible,
  });
  readMirror(path, (db) => {
    expect(readRestVerificationState(db)).toEqual({
      version: REST_CONTENT_VERIFICATION_VERSION,
      policy: "compatible",
      requiredPolicy: "compatible",
    });
  });

  const strictFetches: string[] = [];
  let failStrict = true;
  const strict = fakeReader(
    () => refs,
    async (entryId) => {
      strictFetches.push(entryId);
      if (failStrict) throw new Error("synthetic strict failure");
      return content(entryId);
    },
    "strict",
  );
  await expect(
    sync("synthetic-key", {
      mirrorPath: path,
      nowIso: "2026-02-20T12:00:00.000Z",
      reader: {
        ...strict,
        unlockKeys: async () => {
          throw new Error("synthetic unlock failure");
        },
      },
    }),
  ).rejects.toThrow("synthetic unlock failure");
  readMirror(path, (db) => {
    expect(readRestVerificationState(db)).toMatchObject({
      policy: "compatible",
      requiredPolicy: "strict",
    });
  });

  const degraded = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-21T00:00:00.000Z",
    reader: strict,
  });
  expect(degraded.status).toBe("degraded");
  expect(strictFetches).toEqual(["ENTRY-A"]);
  readMirror(path, (db) => {
    expect(readRestVerificationState(db)).toMatchObject({
      policy: "compatible",
      requiredPolicy: "strict",
    });
  });

  failStrict = false;
  strictFetches.length = 0;
  const completed = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-22T00:00:00.000Z",
    reader: strict,
  });
  expect(completed.status).toBe("complete");
  expect(strictFetches).toEqual(["ENTRY-A"]);
  readMirror(path, (db) => {
    expect(readRestVerificationState(db)).toEqual({
      version: REST_CONTENT_VERIFICATION_VERSION,
      policy: "strict",
      requiredPolicy: "strict",
    });
  });
});

test("a degraded compatible write atomically downgrades prior strict corpus state", async () => {
  const path = mirrorPath();
  let refs = [ref("ENTRY-A", "r1"), ref("ENTRY-B", "r1")];
  const initialStrict = fakeReader(
    () => refs,
    async (entryId) => content(entryId),
    "strict",
  );
  await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-25T00:00:00.000Z",
    reader: initialStrict,
  });

  refs = [ref("ENTRY-A", "r2"), ref("ENTRY-B", "r2")];
  const compatible = fakeReader(
    () => refs,
    async (entryId) => {
      if (entryId === "ENTRY-B") throw new Error("synthetic partial failure");
      return content(entryId);
    },
    "compatible",
    (entryId, authenticity) => {
      if (entryId === "ENTRY-A") authenticity.unsignedAccepted++;
    },
  );
  const degraded = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-26T00:00:00.000Z",
    reader: compatible,
  });
  expect(degraded.status).toBe("degraded");
  readMirror(path, (db) => {
    expect(readRestVerificationState(db).policy).toBe("compatible");
  });

  const strictFetches: string[] = [];
  const strictRetry = fakeReader(
    () => refs,
    async (entryId) => {
      strictFetches.push(entryId);
      return content(entryId);
    },
    "strict",
  );
  const completed = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-27T00:00:00.000Z",
    reader: strictRetry,
  });
  expect(completed.status).toBe("complete");
  expect(strictFetches.sort()).toEqual(["ENTRY-A", "ENTRY-B"]);
  readMirror(path, (db) => {
    expect(readRestVerificationState(db).policy).toBe("strict");
  });
});

test("sync progress does not expose decrypted journal names or entry identifiers", async () => {
  const path = mirrorPath();
  const progress: string[] = [];
  const reader = fakeReader(
    () => [ref("PRIVATE-ENTRY-ID", "r1")],
    async (entryId) => content(entryId),
  );
  const result = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-22T00:00:00.000Z",
    reader,
    onProgress: (message) => progress.push(message),
  });
  expect(result.status).toBe("complete");
  const output = progress.join("\n");
  expect(output).not.toContain("synthetic-journal");
  expect(output).not.toContain("PRIVATE-ENTRY-ID");
  expect(output).toContain("journal 1");
});

test("revalidation cannot complete when a legacy journal is absent from the journal set", async () => {
  const path = mirrorPath();
  const healthy = fakeReader(
    () => [ref("ENTRY-IN-LEGACY-JOURNAL", "r1")],
    async (entryId) => content(entryId),
  );
  await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-23T00:00:00.000Z",
    reader: healthy,
  });
  const legacy = openMirror(path, { writable: true });
  legacy.query("UPDATE meta SET value = '0' WHERE key = 'rest_content_verification_version'").run();
  legacy.close();

  const missingJournal = {
    ...healthy,
    unlockKeys: async () => ({
      ...(await healthy.unlockKeys()),
      journals: [],
    }),
  };
  const result = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-02-24T00:00:00.000Z",
    reader: missingJournal,
  });
  expect(result.status).toBe("degraded");
  expect(result.failed).toBe(1);
  readMirror(path, (db) => {
    expect(readRestVerificationVersion(db)).toBe(0);
    expect(
      db.query("SELECT COUNT(*) AS count FROM entry WHERE uuid = 'ENTRY-IN-LEGACY-JOURNAL'").get(),
    ).toEqual({ count: 1 });
  });
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
      sync_generation: 1,
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
    () => [ref("IN-FLIGHT-ENTRY", "r1")],
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
          sync_generation: 1,
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

test("an overlapping newer REST sync prevents the stale attempt from writing or finalizing", async () => {
  const path = mirrorPath();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let reportFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    reportFirstStarted = resolve;
  });
  const firstBase = fakeReader(
    () => [ref("STALE-ENTRY", "r1")],
    async (entryId) => content(entryId),
  );
  const firstReader = {
    ...firstBase,
    unlockKeys: async () => {
      reportFirstStarted();
      await firstGate;
      return firstBase.unlockKeys();
    },
  };
  const newerReader = fakeReader(
    () => [ref("NEWER-ENTRY", "r1")],
    async (entryId) => content(entryId),
  );

  const stale = sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-04-01T00:00:00.000Z",
    reader: firstReader,
  });
  await firstStarted;
  const newer = await sync("synthetic-key", {
    mirrorPath: path,
    nowIso: "2026-04-02T00:00:00.000Z",
    reader: newerReader,
  });
  expect(newer.status).toBe("complete");
  releaseFirst();
  await expect(stale).rejects.toThrow(/stale sync attempt/);

  readMirror(path, (db) => {
    expect(db.query("SELECT COUNT(*) AS n FROM entry WHERE uuid = 'STALE-ENTRY'").get()).toEqual({
      n: 0,
    });
    expect(getSyncStatus(db)).toMatchObject({
      status: "complete",
      last_attempt_at: "2026-04-02T00:00:00.000Z",
      sync_generation: 2,
    });
  });
});

test("simultaneous starts from independent processes all claim a unique generation", async () => {
  const path = mirrorPath();
  const initialized = openMirror(path, { writable: true });
  initialized.close();
  const openModule = pathToFileURL(join(import.meta.dir, "../src/serve/db/open.ts")).href;
  const statusModule = pathToFileURL(join(import.meta.dir, "../src/sync-status.ts")).href;
  const worker = `
    import { openMirror } from ${JSON.stringify(openModule)};
    import { recordSyncStart } from ${JSON.stringify(statusModule)};
    const db = openMirror(process.argv[1], { writable: true });
    try {
      const status = recordSyncStart(db, new Date().toISOString(), "concurrency-test");
      console.log(status.sync_generation);
    } finally {
      db.close();
    }
  `;
  const processes = Array.from({ length: 12 }, () =>
    Bun.spawn([process.execPath, "-e", worker, path], {
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = await Promise.all(
    processes.map(async (process) => ({
      exitCode: await process.exited,
      stdout: await new Response(process.stdout).text(),
      stderr: await new Response(process.stderr).text(),
    })),
  );
  expect(results.map((result) => result.exitCode)).toEqual(Array(12).fill(0));
  expect(results.map((result) => Number(result.stdout.trim())).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
  expect(results.map((result) => result.stderr).join("")).toBe("");
  readMirror(path, (db) => {
    expect(getSyncStatus(db).sync_generation).toBe(12);
  });
});
