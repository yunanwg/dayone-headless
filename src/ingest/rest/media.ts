/**
 * REST media ingester — fetch + decrypt attachment BYTES into a content-addressed
 * cache. Metadata already lives in the mirror (from `sync`); this populates the
 * actual photo/video/audio/pdf bytes on request, so the 9-figure-MB blob store is
 * never pulled unless asked for.
 *
 * Worklist comes from the mirror (`media` ⨝ `entry_sync` for the Day One journal
 * id); bytes are written to `data/media/<md5>` keyed by the plaintext md5 the
 * mirror already stores. Idempotent: an already-cached md5 is skipped without a
 * download. Each fetched file is md5-verified against the mirror before caching —
 * a wrong-decrypt is never written.
 *
 * Secrets (master key + API creds) come only from the environment/caller.
 */

import { createHash } from "node:crypto";
import { isMediaCached, prepareMediaPath } from "../../media-cache.ts";
import { openMirror } from "../../serve/db/open.ts";
import { apiConfigFromEnv, DayOneApi } from "./api.ts";
import { RestReader } from "./reader.ts";

const md5hex = (b: Uint8Array): string => createHash("md5").update(b).digest("hex");

interface MediaJob {
  identifier: string;
  md5: string | null;
  kind: string;
  journalId: string;
}

export interface MediaSyncStats {
  total: number;
  alreadyCached: number;
  fetched: number;
  skippedNoMd5: number;
  md5Mismatch: number;
  failed: number;
  bytes: number;
}

export interface MediaSyncOptions {
  /** Only this entry's media (by uuid); default: all media in the mirror. */
  entryUuid?: string;
  /** Cap the number of NEW downloads (for bounded / test runs). */
  limit?: number;
  onProgress?: (msg: string) => void;
}

/** Read the media worklist (identifier + plaintext md5 + Day One journal id). */
function loadJobs(entryUuid?: string): MediaJob[] {
  const db = openMirror();
  const where = entryUuid ? "WHERE m.entry_uuid = $uuid" : "";
  const jobs = db
    .query(
      `SELECT m.identifier, m.md5, m.kind, es.journal_id AS journalId
       FROM media m JOIN entry_sync es ON es.uuid = m.entry_uuid
       ${where}`,
    )
    .all(entryUuid ? { $uuid: entryUuid } : {}) as MediaJob[];
  db.close();
  return jobs;
}

export async function syncMedia(masterKey: string, opts: MediaSyncOptions = {}): Promise<MediaSyncStats> {
  const jobs = loadJobs(opts.entryUuid);
  const stats: MediaSyncStats = {
    total: jobs.length,
    alreadyCached: 0,
    fetched: 0,
    skippedNoMd5: 0,
    md5Mismatch: 0,
    failed: 0,
    bytes: 0,
  };

  const api = new DayOneApi(apiConfigFromEnv());
  await api.ensureToken();
  const reader = new RestReader(api, masterKey);
  const keys = await reader.unlockKeys();

  for (const job of jobs) {
    if (!job.md5) {
      stats.skippedNoMd5++;
      continue;
    }
    if (isMediaCached(job.md5)) {
      stats.alreadyCached++;
      continue;
    }
    if (opts.limit !== undefined && stats.fetched >= opts.limit) break;
    try {
      const bytes = await reader.fetchMedia(job.journalId, job.identifier, keys);
      if (md5hex(bytes) !== job.md5) {
        stats.md5Mismatch++;
        opts.onProgress?.(`md5 mismatch for ${job.kind} ${job.identifier.slice(0, 8)}… — not cached`);
        continue;
      }
      await Bun.write(prepareMediaPath(job.md5), bytes);
      stats.fetched++;
      stats.bytes += bytes.length;
      opts.onProgress?.(`cached ${job.kind} ${job.identifier.slice(0, 8)}… (${bytes.length} B)`);
    } catch (err) {
      stats.failed++;
      opts.onProgress?.(`failed ${job.identifier.slice(0, 8)}…: ${(err as Error).message}`);
    }
  }
  return stats;
}
