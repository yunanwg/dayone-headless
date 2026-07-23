import type { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
    () => [],
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
