#!/usr/bin/env bun

/**
 * REST ingester — incremental sync. Fetches ciphertext over the Day One sync API,
 * decrypts it with our own crypto, maps it to the export shape, and writes the
 * mirror via the shared `importExport()`. No browser.
 *
 * Incremental: the feed is metadata-only + cheap; we re-fetch/re-decrypt only
 * entries whose server `revisionId` changed since the last sync (tracked in
 * `entry_sync`), and remove explicitly tombstoned entries. The initial run asks
 * for every API-reported revision; later runs are cheap deltas. Media BYTES are
 * never stored — only metadata; the actual
 * photo/video/audio/pdf blobs are fetched + decrypted on demand elsewhere.
 *
 *   DAYONE_ENCRYPTION_KEY + (DAYONE_API_TOKEN | DAYONE_EMAIL+DAYONE_PASSWORD)
 *   DAYONE_MIRROR   mirror db path (default mirror.db)
 *
 *   bun run src/ingest/rest/sync.ts
 */

import { boundedPositiveInteger, SYNC_CONCURRENCY_BOUNDS } from "../../runtime-config.ts";
import { requireSecret } from "../../secret-config.ts";
import { openMirror } from "../../serve/db/open.ts";
import {
  assertSyncAttempt,
  readRestVerificationState,
  recordRestVerificationRequirement,
  recordSyncOutcome,
  recordSyncStart,
  StaleSyncAttemptError,
  type SyncState,
} from "../../sync-status.ts";
import type { DayOneEntry } from "../../types.ts";
import {
  REST_CONTENT_VERIFICATION_VERSION,
  type VerificationPolicy,
  verificationPolicySatisfies,
} from "../../verification.ts";
import { importExport } from "../json-export/import.ts";
import { apiConfigFromEnv, DayOneApi } from "./api.ts";
import { mapEntry } from "./map.ts";
import { runPool } from "./pool.ts";
import type { D1AuthenticityStatus } from "./reader.ts";
import { type EntryRef, RestReader } from "./reader.ts";

export interface SyncResult {
  journals: number;
  changed: number;
  removed: number;
  failed: number;
  status: Exclude<SyncState, "unknown" | "running" | "failed">;
  lastAttemptAt: string;
  lastCompleteAt: string | null;
  /** Backwards-compatible alias for the last complete sync, not the latest attempt. */
  syncedAt: string | null;
  /** D1 signed-key verification coverage for content processed in this attempt. */
  d1Authenticity: D1AuthenticityStatus;
}

const SYNC_WRITE_BATCH_SIZE = 8;
export const MAX_SYNC_ENTRY_REFS = 100_000;
export const MAX_MAPPED_SOURCE_BYTES_PER_JOURNAL = 64 * 1024 * 1024;

type SyncReader = Pick<
  RestReader,
  "signaturePolicy" | "unlockKeys" | "decryptJournalName" | "listEntries" | "decryptEntry"
>;

/** `opts.concurrency` wins; else DAYONE_SYNC_CONCURRENCY; else the default. */
function resolveConcurrency(opts: { concurrency?: number }): number {
  return boundedPositiveInteger(
    "DAYONE_SYNC_CONCURRENCY",
    opts.concurrency ?? process.env.DAYONE_SYNC_CONCURRENCY,
    SYNC_CONCURRENCY_BOUNDS,
  );
}

/**
 * Fetch + decrypt + map every ref in `toFetch` with bounded concurrency (a true
 * worker pool, not fixed-size batches with a barrier between them) — the slowest
 * entry in flight no longer stalls the rest of the pool's width. A per-entry
 * failure (fetch, decrypt, missing key, parse, or map) is caught here and counted
 * without retaining its identifier or error details. It must not abort the
 * remaining entries, but the caller must mark the overall sync degraded. Return
 * order is completion order, not input order — callers must not depend on it
 * (writes here are keyed by uuid).
 */
export async function fetchChangedEntries(
  toFetch: readonly EntryRef[],
  decrypt: (r: EntryRef) => Promise<string | null>,
  concurrency: number,
  maximumMappedSourceBytes = MAX_MAPPED_SOURCE_BYTES_PER_JOURNAL,
): Promise<{ mapped: DayOneEntry[]; done: EntryRef[]; failed: number }> {
  if (!Number.isSafeInteger(maximumMappedSourceBytes) || maximumMappedSourceBytes < 1) {
    throw new RangeError("maximum mapped source bytes must be a positive safe integer");
  }
  const mapped: DayOneEntry[] = [];
  const done: EntryRef[] = [];
  let failed = 0;
  let retainedSourceBytes = 0;
  await runPool(toFetch, concurrency, async (r) => {
    try {
      const content = await decrypt(r);
      if (content) {
        const contentBytes = Buffer.byteLength(content, "utf8");
        if (retainedSourceBytes + contentBytes > maximumMappedSourceBytes) {
          failed++;
          return;
        }
        retainedSourceBytes += contentBytes;
        const entry = mapEntry(JSON.parse(content), { editDate: r.editDate });
        if (entry.uuid !== r.entryId) throw new Error("decrypted entry identity mismatch");
        mapped.push(entry);
        done.push(r);
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  });
  return { mapped, done, failed };
}

/** Run an incremental sync into the mirror. `nowIso` is injectable for testing. */
export async function sync(
  masterKey: string,
  opts: {
    mirrorPath?: string;
    nowIso?: string;
    concurrency?: number;
    onProgress?: (msg: string) => void;
    /** Synthetic reader seam for deterministic tests; production leaves this unset. */
    reader?: SyncReader;
  } = {},
): Promise<SyncResult> {
  const log = opts.onProgress ?? (() => {});
  const concurrency = resolveConcurrency(opts);
  const attemptedAt = opts.nowIso ?? new Date().toISOString();
  const db = openMirror(opts.mirrorPath, { writable: true });
  let attempt: ReturnType<typeof recordSyncStart> | undefined;
  let failed = 0;
  try {
    attempt = recordSyncStart(db, attemptedAt, "rest");
    const generation = attempt.sync_generation;
    const reader: SyncReader = opts.reader ?? new RestReader(new DayOneApi(apiConfigFromEnv()), masterKey);
    recordRestVerificationRequirement(db, generation, reader.signaturePolicy);
    const keys = await reader.unlockKeys();
    if (keys.authenticity.policy !== reader.signaturePolicy) {
      throw new Error("REST reader signature-policy mismatch");
    }
    const priorVerification = readRestVerificationState(db);
    const forceReverify =
      priorVerification.version < REST_CONTENT_VERIFICATION_VERSION ||
      !verificationPolicySatisfies(priorVerification.policy, keys.authenticity.policy);
    const journalKeyCount = [...keys.journalKeyByJournalId.values()].reduce(
      (total, journalKeys) => total + journalKeys.size,
      0,
    );
    log(`unlocked ${journalKeyCount} journal key(s); ` + `D1 signature policy ${keys.authenticity.policy}`);
    if (forceReverify) {
      log(`revalidating the mirror with verification generation ${REST_CONTENT_VERIFICATION_VERSION}`);
    }

    const setSync = db.query(
      "INSERT INTO entry_sync (uuid, journal_id, revision_id) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(uuid) DO UPDATE SET journal_id = excluded.journal_id, revision_id = excluded.revision_id",
    );
    const delEntry = db.query("DELETE FROM entry WHERE uuid = ?");
    const delFts = db.query("DELETE FROM entry_fts WHERE uuid = ?");
    const delSync = db.query("DELETE FROM entry_sync WHERE uuid = ?");
    const setVerificationPolicy = db.query(
      `INSERT INTO meta (key, value) VALUES ('rest_content_verification_policy', ?1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );

    let changed = 0;
    let removed = 0;
    let journalCount = 0;
    let observedEntryRefs = 0;
    const trackedRows = db
      .query(
        `SELECT e.uuid, e.journal_id AS mirrorJournalId, es.journal_id AS externalJournalId
         FROM entry e JOIN entry_sync es ON es.uuid = e.uuid`,
      )
      .all() as { uuid: string; mirrorJournalId: number; externalJournalId: string }[];
    const existingEntries = new Set(
      trackedRows.map((row) => JSON.stringify([row.externalJournalId, row.uuid])),
    );
    const externalIdsByMirrorJournal = new Map<number, Set<string>>();
    for (const row of trackedRows) {
      const ids = externalIdsByMirrorJournal.get(row.mirrorJournalId) ?? new Set<string>();
      ids.add(row.externalJournalId);
      externalIdsByMirrorJournal.set(row.mirrorJournalId, ids);
    }
    const orphanRows = db
      .query(
        `SELECT e.uuid, e.journal_id AS mirrorJournalId, j.name AS journalName
         FROM entry e
         JOIN journal j ON j.id = e.journal_id
         LEFT JOIN entry_sync es ON es.uuid = e.uuid
         WHERE es.uuid IS NULL`,
      )
      .all() as { uuid: string; mirrorJournalId: number; journalName: string }[];
    const journalDescriptors: { id: string; name: string }[] = [];
    for (const journal of keys.journals) {
      if (!journal?.encryption?.vault?.keys?.length) continue;
      const id = String(journal.id);
      const name = (await reader.decryptJournalName(journal.name, id, keys)) ?? `journal-${id}`;
      journalDescriptors.push({ id, name });
    }
    const externalIdsByName = new Map<string, Set<string>>();
    for (const journal of journalDescriptors) {
      const ids = externalIdsByName.get(journal.name) ?? new Set<string>();
      ids.add(journal.id);
      externalIdsByName.set(journal.name, ids);
    }
    const orphansByExternalJournal = new Map<string, Set<string>>();
    for (const orphan of orphanRows) {
      const mappedIds = externalIdsByMirrorJournal.get(orphan.mirrorJournalId);
      const nameIds = externalIdsByName.get(orphan.journalName);
      const externalId =
        mappedIds?.size === 1
          ? [...mappedIds][0]
          : (!mappedIds || mappedIds.size === 0) && nameIds?.size === 1
            ? [...nameIds][0]
            : undefined;
      if (externalId) {
        const uuids = orphansByExternalJournal.get(externalId) ?? new Set<string>();
        uuids.add(orphan.uuid);
        orphansByExternalJournal.set(externalId, uuids);
      }
    }
    const orphanAccounted = new Set<string>();
    const feedAccounted = new Set<string>();

    for (const journal of journalDescriptors) {
      journalCount++;
      const journalId = journal.id;
      const name = journal.name;
      const knownOrphans = orphansByExternalJournal.get(journalId) ?? new Set<string>();
      for (const uuid of knownOrphans) orphanAccounted.add(uuid);

      const refs = await reader.listEntries(journalId);
      observedEntryRefs += refs.length;
      if (observedEntryRefs > MAX_SYNC_ENTRY_REFS) {
        throw new Error(`sync feed exceeded the ${MAX_SYNC_ENTRY_REFS}-entry safety limit`);
      }
      const feedUuids = new Set(refs.map((r) => r.entryId));
      const stored = new Map<string, string>();
      for (const row of db
        .query("SELECT uuid, revision_id FROM entry_sync WHERE journal_id = ?")
        .all(journalId) as any[]) {
        stored.set(row.uuid, row.revision_id);
      }
      // A successful HTTP response with no feed records has no authenticated
      // terminal/count signal. With no prior rows to compare, it therefore
      // cannot establish that this journal is genuinely empty.
      if (refs.length === 0 && stored.size === 0 && knownOrphans.size === 0) {
        failed++;
        log("one empty journal feed could not establish completeness");
      }

      // Absence is not a tombstone: a truncated/empty 200 response cannot prove
      // deletion. Only an explicit deletionRequested revision may remove data.
      const remove = new Set<string>();
      for (const r of refs) {
        if (r.deleted && (stored.has(r.entryId) || knownOrphans.has(r.entryId))) {
          remove.add(r.entryId);
        }
      }
      for (const r of refs) feedAccounted.add(JSON.stringify([journalId, r.entryId]));
      let absentStored = 0;
      for (const uuid of new Set([...stored.keys(), ...knownOrphans])) {
        if (!feedUuids.has(uuid)) {
          feedAccounted.add(JSON.stringify([journalId, uuid]));
          absentStored++;
        }
      }
      if (absentStored > 0) {
        failed += absentStored;
        log(`${absentStored} stored item(s) were absent from one returned journal feed and preserved`);
      }
      // Changed: new or bumped revisionId → re-fetch + decrypt (bounded concurrency).
      const toFetch = refs.filter(
        (r) => !r.deleted && (forceReverify || stored.get(r.entryId) !== r.revisionId),
      );
      let journalChanged = 0;
      let journalFailed = 0;
      // Apply authoritative removals independently of fetch batches. A newer
      // overlapping sync can start during network/decryption, but every write
      // transaction rechecks generation ownership.
      db.transaction(() => {
        assertSyncAttempt(db, generation);
        for (const uuid of remove) {
          delEntry.run(uuid);
          delFts.run(uuid);
          delSync.run(uuid);
        }
      }).immediate();
      // Bound retained decrypted strings/mapped objects independently of the
      // feed cardinality. At most one small batch survives to a write.
      for (let offset = 0; offset < toFetch.length; offset += SYNC_WRITE_BATCH_SIZE) {
        const batch = toFetch.slice(offset, offset + SYNC_WRITE_BATCH_SIZE);
        const result = await fetchChangedEntries(
          batch,
          (r) => reader.decryptEntry(journalId, r.entryId, keys),
          concurrency,
        );
        journalFailed += result.failed;
        db.transaction(() => {
          assertSyncAttempt(db, generation);
          // A degraded compatible attempt may still commit some successfully
          // decrypted unsigned entries. Downgrade policy atomically with writes.
          if (
            priorVerification.policy === "strict" &&
            keys.authenticity.policy === "compatible" &&
            keys.authenticity.unsignedAccepted > 0
          ) {
            setVerificationPolicy.run("compatible");
          }
          if (result.mapped.length) {
            importExport(db, { metadata: { version: "rest" }, entries: result.mapped }, name);
            for (const ref of result.done) setSync.run(ref.entryId, journalId, ref.revisionId);
          }
        }).immediate();
        journalChanged += result.mapped.length;
      }
      failed += journalFailed;
      removed += remove.size;
      changed += journalChanged;
      log(
        `  journal ${journalCount}: +${journalChanged} changed, -${remove.size} removed` +
          (journalFailed ? `, !${journalFailed} failed` : ""),
      );
    }

    if (journalCount === 0 && existingEntries.size === 0) {
      failed++;
      log("an empty journal set could not establish completeness");
    }
    let unaccounted = 0;
    for (const entryKey of existingEntries) {
      if (!feedAccounted.has(entryKey)) unaccounted++;
    }
    if (unaccounted > 0) {
      failed += unaccounted;
      log(`${unaccounted} stored item(s) belonged to journals absent from the returned journal set`);
    }
    const unmappableOrphans = orphanRows.length - orphanAccounted.size;
    if (unmappableOrphans > 0) {
      failed += unmappableOrphans;
      log(`${unmappableOrphans} mirror item(s) had no unambiguous REST journal mapping and were preserved`);
    }

    const status = failed === 0 ? "complete" : "degraded";
    const completedPolicy: VerificationPolicy =
      keys.authenticity.policy === "strict" ||
      (keys.authenticity.unsignedAccepted === 0 && priorVerification.policy === "strict")
        ? "strict"
        : "compatible";
    const recorded = recordSyncOutcome(
      db,
      {
        status,
        attemptedAt,
        failedEntries: failed,
        source: "rest",
        verificationVersion: status === "complete" ? REST_CONTENT_VERIFICATION_VERSION : undefined,
        verificationPolicy: status === "complete" ? completedPolicy : undefined,
      },
      generation,
    );
    log(
      `D1 signatures: ${keys.authenticity.verified} verified, ` +
        `${keys.authenticity.unsignedAccepted} unsigned accepted (${keys.authenticity.policy})`,
    );
    return {
      journals: journalCount,
      changed,
      removed,
      failed,
      status,
      lastAttemptAt: attemptedAt,
      lastCompleteAt: recorded.last_complete_at,
      syncedAt: recorded.last_complete_at,
      d1Authenticity: { ...keys.authenticity },
    };
  } catch (error) {
    if (attempt) {
      try {
        recordSyncOutcome(
          db,
          {
            status: "failed",
            attemptedAt,
            failedEntries: failed,
            source: "rest",
          },
          attempt.sync_generation,
        );
      } catch (outcomeError) {
        // A newer attempt owns the mirror; do not let this stale process overwrite
        // its status. Preserve the original error unless the CAS itself revealed
        // the stale overlap.
        if (!(outcomeError instanceof StaleSyncAttemptError)) throw outcomeError;
        if (!(error instanceof StaleSyncAttemptError)) throw error;
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const masterKey = requireSecret("DAYONE_ENCRYPTION_KEY");
  const t0 = Date.now();
  const r = await sync(masterKey, { onProgress: (m) => console.error(m) });
  console.error(
    `done in ${((Date.now() - t0) / 1000).toFixed(1)}s: +${r.changed} changed, -${r.removed} removed, ` +
      `${r.failed} failed across ${r.journals} journals → mirror ` +
      `(${r.status}; last_complete_at ${r.lastCompleteAt ?? "never"})`,
  );
}
