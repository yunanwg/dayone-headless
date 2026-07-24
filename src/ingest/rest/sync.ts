#!/usr/bin/env bun

/**
 * REST ingester — incremental sync. Fetches ciphertext over the Day One sync API,
 * decrypts it with our own crypto, maps it to the export shape, and writes the
 * mirror via the shared `importExport()`. No browser.
 *
 * Incremental: the feed is metadata-only + cheap; we re-fetch/re-decrypt only
 * entries whose server `revisionId` changed since the last sync (tracked in
 * `entry_sync`), and remove entries deleted upstream. First sync = full; after
 * that = cheap deltas. Media BYTES are never stored — only metadata; the actual
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
import { recordSyncOutcome, recordSyncStart, type SyncState } from "../../sync-status.ts";
import type { DayOneEntry } from "../../types.ts";
import { importExport } from "../json-export/import.ts";
import { apiConfigFromEnv, DayOneApi } from "./api.ts";
import { mapEntry } from "./map.ts";
import { runPool } from "./pool.ts";
import { type DecryptedEntryContent, type EntryRef, type JournalKeys, RestReader } from "./reader.ts";

/** Per-run tally of D1 envelope-signature outcomes across all decrypted entries. */
export interface SignatureCounters {
  verified: number;
  unsigned: number;
  failed: number;
}

export interface SyncResult {
  journals: number;
  changed: number;
  removed: number;
  failed: number;
  /** Entries whose envelope signature verified against the journal public key. */
  signatureVerified: number;
  /** Entries carrying no signature (documented for server-created content). */
  signatureUnsigned: number;
  /** Entries whose signature was present but did not verify (or lacked a key). */
  signatureFailed: number;
  status: Exclude<SyncState, "unknown" | "running" | "failed">;
  lastAttemptAt: string;
  lastCompleteAt: string | null;
  /** Backwards-compatible alias for the last complete sync, not the latest attempt. */
  syncedAt: string | null;
}

/** What a reader's `decryptEntry` may return: content-only (fakes) or content + outcome. */
type DecryptEntryOutput = string | DecryptedEntryContent | null;

interface SyncReader {
  unlockKeys: RestReader["unlockKeys"];
  decryptJournalName: RestReader["decryptJournalName"];
  listEntries: RestReader["listEntries"];
  decryptEntry(journalId: string, entryId: string, keys: JournalKeys): Promise<DecryptEntryOutput>;
}

/** True when the run must fail-closed on missing/invalid signatures. */
export function requireSignaturesFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DAYONE_REQUIRE_SIGNATURES === "1";
}
export const MAX_SYNC_ENTRY_REFS = 100_000;
export const MAX_MAPPED_SOURCE_BYTES_PER_JOURNAL = 64 * 1024 * 1024;

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
  decrypt: (r: EntryRef) => Promise<DecryptEntryOutput>,
  concurrency: number,
  maximumMappedSourceBytes = MAX_MAPPED_SOURCE_BYTES_PER_JOURNAL,
  signatureOptions: {
    /** Fail-closed: skip writing entries whose signature is missing or invalid. */
    requireSignatures?: boolean;
    /** Mutated in place with each entry's signature outcome (verified/unsigned/failed). */
    signatures?: SignatureCounters;
    /** Warn sink for signature problems — receives a uuid-prefix + reason only. */
    onWarn?: (msg: string) => void;
  } = {},
): Promise<{ mapped: DayOneEntry[]; done: EntryRef[]; failed: number }> {
  if (!Number.isSafeInteger(maximumMappedSourceBytes) || maximumMappedSourceBytes < 1) {
    throw new RangeError("maximum mapped source bytes must be a positive safe integer");
  }
  const { requireSignatures = false, signatures, onWarn } = signatureOptions;
  const mapped: DayOneEntry[] = [];
  const done: EntryRef[] = [];
  let failed = 0;
  let retainedSourceBytes = 0;
  await runPool(toFetch, concurrency, async (r) => {
    try {
      const out = await decrypt(r);
      const content = typeof out === "string" ? out : (out?.content ?? null);
      const disposition = out && typeof out !== "string" ? out.signature : undefined;
      if (!content) {
        failed++;
        return;
      }
      // Count the signature outcome and, under fail-closed policy, skip writing
      // any entry that is not "verified". Warnings carry only a uuid PREFIX and a
      // reason — never entry content or the full identifier.
      if (disposition) {
        if (signatures) signatures[disposition]++;
        if (disposition === "failed") {
          onWarn?.(
            `  signature: entry ${r.entryId.slice(0, 8)} verification failed${
              requireSignatures ? " (skipped)" : ""
            }`,
          );
        } else if (disposition === "unsigned" && requireSignatures) {
          onWarn?.(`  signature: entry ${r.entryId.slice(0, 8)} unsigned (skipped)`);
        }
        if (requireSignatures && disposition !== "verified") return; // fail-closed: not written
      }
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (retainedSourceBytes + contentBytes > maximumMappedSourceBytes) {
        failed++;
        return;
      }
      retainedSourceBytes += contentBytes;
      mapped.push(mapEntry(JSON.parse(content), { editDate: r.editDate }));
      done.push(r);
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
  recordSyncStart(db, attemptedAt, "rest");
  let failed = 0;
  try {
    const reader: SyncReader = opts.reader ?? new RestReader(new DayOneApi(apiConfigFromEnv()), masterKey);
    const requireSignatures = requireSignaturesFromEnv();
    const signatures: SignatureCounters = { verified: 0, unsigned: 0, failed: 0 };
    const keys = await reader.unlockKeys();
    log(
      `unlocked ${keys.journalPrivByFingerprint.size} journal key(s)` +
        (requireSignatures ? " (signatures required)" : ""),
    );

    const setSync = db.query(
      "INSERT INTO entry_sync (uuid, journal_id, revision_id) VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(uuid) DO UPDATE SET journal_id = excluded.journal_id, revision_id = excluded.revision_id",
    );
    const delEntry = db.query("DELETE FROM entry WHERE uuid = ?");
    const delFts = db.query("DELETE FROM entry_fts WHERE uuid = ?");
    const delSync = db.query("DELETE FROM entry_sync WHERE uuid = ?");

    let changed = 0;
    let removed = 0;
    let journalCount = 0;
    let observedEntryRefs = 0;

    for (const j of keys.journals) {
      if (!j?.encryption?.vault?.keys?.length) continue;
      journalCount++;
      const name = (await reader.decryptJournalName(j.name, j.id, keys)) ?? `journal-${j.id}`;

      const refs = await reader.listEntries(j.id);
      observedEntryRefs += refs.length;
      if (observedEntryRefs > MAX_SYNC_ENTRY_REFS) {
        throw new Error(`sync feed exceeded the ${MAX_SYNC_ENTRY_REFS}-entry safety limit`);
      }
      const feedUuids = new Set(refs.map((r) => r.entryId));
      const stored = new Map<string, string>();
      for (const row of db
        .query("SELECT uuid, revision_id FROM entry_sync WHERE journal_id = ?")
        .all(j.id) as any[]) {
        stored.set(row.uuid, row.revision_id);
      }

      // Removals: entries marked deleted upstream, or gone from the feed entirely.
      const remove = new Set<string>();
      for (const r of refs) if (r.deleted && stored.has(r.entryId)) remove.add(r.entryId);
      for (const u of stored.keys()) if (!feedUuids.has(u)) remove.add(u);
      if (remove.size) {
        db.transaction((uuids: string[]) => {
          for (const u of uuids) {
            delEntry.run(u);
            delFts.run(u);
            delSync.run(u);
          }
        })([...remove]);
        removed += remove.size;
      }

      // Changed: new or bumped revisionId → re-fetch + decrypt (bounded concurrency).
      const toFetch = refs.filter((r) => !r.deleted && stored.get(r.entryId) !== r.revisionId);
      const result = await fetchChangedEntries(
        toFetch,
        (r) => reader.decryptEntry(j.id, r.entryId, keys),
        concurrency,
        MAX_MAPPED_SOURCE_BYTES_PER_JOURNAL,
        { requireSignatures, signatures, onWarn: log },
      );
      const { mapped, done } = result;
      failed += result.failed;
      if (mapped.length) {
        importExport(db, { metadata: { version: "rest" }, entries: mapped }, name);
        db.transaction((rs: EntryRef[]) => {
          for (const r of rs) setSync.run(r.entryId, j.id, r.revisionId);
        })(done);
        changed += mapped.length;
      }
      log(
        `  journal ${journalCount}: +${mapped.length} changed, -${remove.size} removed` +
          (result.failed ? `, !${result.failed} failed` : ""),
      );
    }

    log(
      `signatures: ${signatures.verified} verified, ${signatures.unsigned} unsigned, ` +
        `${signatures.failed} failed`,
    );
    const status = failed === 0 ? "complete" : "degraded";
    const recorded = recordSyncOutcome(db, {
      status,
      attemptedAt,
      failedEntries: failed,
      source: "rest",
    });
    return {
      journals: journalCount,
      changed,
      removed,
      failed,
      signatureVerified: signatures.verified,
      signatureUnsigned: signatures.unsigned,
      signatureFailed: signatures.failed,
      status,
      lastAttemptAt: attemptedAt,
      lastCompleteAt: recorded.last_complete_at,
      syncedAt: recorded.last_complete_at,
    };
  } catch (error) {
    recordSyncOutcome(db, {
      status: "failed",
      attemptedAt,
      failedEntries: failed,
      source: "rest",
    });
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
      `(sig: ${r.signatureVerified} verified / ${r.signatureUnsigned} unsigned / ${r.signatureFailed} failed; ` +
      `${r.status}; last_complete_at ${r.lastCompleteAt ?? "never"})`,
  );
}
