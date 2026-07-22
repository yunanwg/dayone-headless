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

import { openMirror } from "../../serve/db/open.ts";
import type { DayOneEntry } from "../../types.ts";
import { importExport } from "../json-export/import.ts";
import { apiConfigFromEnv, DayOneApi } from "./api.ts";
import { mapEntry } from "./map.ts";
import { type EntryRef, RestReader } from "./reader.ts";

export interface SyncResult {
  journals: number;
  changed: number;
  removed: number;
  syncedAt: string;
}

/** Run an incremental sync into the mirror. `nowIso` is injectable for testing. */
export async function sync(
  masterKey: string,
  opts: {
    mirrorPath?: string;
    nowIso?: string;
    concurrency?: number;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<SyncResult> {
  const log = opts.onProgress ?? (() => {});
  const concurrency = opts.concurrency ?? 8;
  const reader = new RestReader(new DayOneApi(apiConfigFromEnv()), masterKey);

  const keys = await reader.unlockKeys();
  log(`unlocked ${keys.journalPrivByFingerprint.size} journal key(s)`);

  const db = openMirror(opts.mirrorPath, { writable: true });
  try {
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

    for (const j of keys.journals) {
      if (!j?.encryption?.vault?.keys?.length) continue;
      journalCount++;
      const name = (await reader.decryptJournalName(j.name, j.id, keys)) ?? `journal-${j.id}`;

      const refs = await reader.listEntries(j.id);
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
      const mapped: DayOneEntry[] = [];
      const done: EntryRef[] = [];
      for (let i = 0; i < toFetch.length; i += concurrency) {
        const batch = toFetch.slice(i, i + concurrency);
        const results = await Promise.all(
          batch.map(async (r) => {
            try {
              const content = await reader.decryptEntry(j.id, r.entryId, keys);
              return content ? { r, e: mapEntry(JSON.parse(content), { editDate: r.editDate }) } : null;
            } catch {
              return null; // one bad entry must not fail the whole sync
            }
          }),
        );
        for (const x of results)
          if (x) {
            mapped.push(x.e);
            done.push(x.r);
          }
      }
      if (mapped.length) {
        importExport(db, { metadata: { version: "rest" }, entries: mapped }, name);
        db.transaction((rs: EntryRef[]) => {
          for (const r of rs) setSync.run(r.entryId, j.id, r.revisionId);
        })(done);
        changed += mapped.length;
      }
      log(`  ${name}: +${mapped.length} changed, -${remove.size} removed`);
    }

    const syncedAt = opts.nowIso ?? new Date().toISOString();
    db.query(
      "INSERT INTO meta (key, value) VALUES ('synced_at', ?1), ('source', 'rest') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(syncedAt);
    return { journals: journalCount, changed, removed, syncedAt };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const masterKey = process.env.DAYONE_ENCRYPTION_KEY;
  if (!masterKey) throw new Error("set DAYONE_ENCRYPTION_KEY (the D1-<userId>-<code…> encryption key)");
  const t0 = Date.now();
  const r = await sync(masterKey, { onProgress: (m) => console.error(m) });
  console.error(
    `done in ${((Date.now() - t0) / 1000).toFixed(1)}s: +${r.changed} changed, -${r.removed} removed ` +
      `across ${r.journals} journals → mirror (synced_at ${r.syncedAt})`,
  );
}
