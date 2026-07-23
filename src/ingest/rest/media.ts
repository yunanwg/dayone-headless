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
import { writeFile } from "node:fs/promises";
import { hardenPrivateFile, installPrivateUmask, PRIVATE_FILE_MODE } from "../../local-permissions.ts";
import { isMediaCached, isValidMd5, prepareMediaPath } from "../../media-cache.ts";
import { openMirror } from "../../serve/db/open.ts";
import { apiConfigFromEnv, DayOneApi } from "./api.ts";
import { runPool } from "./pool.ts";
import { RestReader } from "./reader.ts";

const md5hex = (b: Uint8Array): string => createHash("md5").update(b).digest("hex");

export interface MediaJob {
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
  /** Exact cap on NEW download attempts (for bounded / test runs). */
  limit?: number;
  /** Bounded worker-pool size; default 6 (or DAYONE_MEDIA_CONCURRENCY). */
  concurrency?: number;
  /** Media cache dir override (tests); default is the standard cache dir. */
  cacheDir?: string;
  onProgress?: (msg: string) => void;
}

const DEFAULT_MEDIA_CONCURRENCY = 6;

function resolveConcurrency(opts: MediaSyncOptions): number {
  if (opts.concurrency !== undefined) return Math.max(1, opts.concurrency);
  const fromEnv = Number(process.env.DAYONE_MEDIA_CONCURRENCY);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : DEFAULT_MEDIA_CONCURRENCY;
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

/**
 * Core fetch loop over a worklist, with the byte fetcher injected — so the
 * pool/limit/verify/cache logic is testable without network or crypto.
 * `fetchBytes` is called exactly once per attempted download.
 */
export async function runMediaJobs(
  jobs: MediaJob[],
  fetchBytes: (job: MediaJob) => Promise<Uint8Array>,
  opts: MediaSyncOptions = {},
): Promise<MediaSyncStats> {
  const stats: MediaSyncStats = {
    total: jobs.length,
    alreadyCached: 0,
    fetched: 0,
    skippedNoMd5: 0,
    md5Mismatch: 0,
    failed: 0,
    bytes: 0,
  };

  // Jobs that need no network round-trip (no md5 / already cached) are filtered
  // up front so they never occupy a worker slot; only real fetches go through
  // the bounded-concurrency pool below.
  const eligible: (MediaJob & { md5: string })[] = [];
  for (const job of jobs) {
    // A missing OR malformed md5 (not 32 lowercase hex) is skipped up front: the
    // md5 is both the verification target and the cache path, so a bad value can
    // never verify and must never reach `prepareMediaPath` (path-traversal guard).
    if (!isValidMd5(job.md5)) {
      stats.skippedNoMd5++;
      continue;
    }
    if (isMediaCached(job.md5, opts.cacheDir)) {
      stats.alreadyCached++;
      continue;
    }
    eligible.push(job as MediaJob & { md5: string });
  }

  // `limit` is an EXACT cap on download attempts: every eligible job triggers
  // exactly one fetch, so truncating the worklist before the pool starts
  // reserves the slots synchronously — concurrent workers can never start a
  // fetch beyond the cap (unlike gating on a post-completion counter).
  const work = opts.limit !== undefined ? eligible.slice(0, Math.max(0, opts.limit)) : eligible;

  await runPool(work, resolveConcurrency(opts), async (job) => {
    try {
      const bytes = await fetchBytes(job);
      if (md5hex(bytes) !== job.md5) {
        stats.md5Mismatch++;
        opts.onProgress?.(`md5 mismatch for ${job.kind} ${job.identifier.slice(0, 8)}… — not cached`);
        return;
      }
      const path = prepareMediaPath(job.md5, opts.cacheDir);
      installPrivateUmask();
      await writeFile(path, bytes, { mode: PRIVATE_FILE_MODE });
      hardenPrivateFile(path);
      stats.fetched++;
      stats.bytes += bytes.length;
      opts.onProgress?.(`cached ${job.kind} ${job.identifier.slice(0, 8)}… (${bytes.length} B)`);
    } catch (err) {
      // One failed download must not abort the rest of the pool.
      stats.failed++;
      opts.onProgress?.(`failed ${job.identifier.slice(0, 8)}…: ${(err as Error).message}`);
    }
  });
  return stats;
}

export async function syncMedia(masterKey: string, opts: MediaSyncOptions = {}): Promise<MediaSyncStats> {
  const jobs = loadJobs(opts.entryUuid);

  const api = new DayOneApi(apiConfigFromEnv());
  await api.ensureToken();
  const reader = new RestReader(api, masterKey);
  const keys = await reader.unlockKeys();

  return runMediaJobs(jobs, (job) => reader.fetchMedia(job.journalId, job.identifier, keys), opts);
}
