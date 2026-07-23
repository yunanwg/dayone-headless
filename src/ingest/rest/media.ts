/**
 * REST media ingester — fetch + decrypt attachment BYTES into a content-addressed
 * cache. Metadata already lives in the mirror (from `sync`); this populates the
 * actual photo/video/audio/pdf bytes on request, so the 9-figure-MB blob store is
 * never pulled unless asked for.
 *
 * Worklist comes from the mirror (`media` ⨝ `entry_sync` for the Day One journal
 * id); bytes are written to `data/media/<md5>` keyed by the plaintext md5 the
 * mirror already stores. Idempotent: a cache file carrying the current
 * verification generation is skipped without a download; legacy generations are
 * refetched. Each fetched file is md5-verified against the mirror before caching.
 *
 * Secrets (master key + API creds) come only from the environment/caller.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { hardenPrivateFile, installPrivateUmask, PRIVATE_FILE_MODE } from "../../local-permissions.ts";
import { isMediaCached, isValidMd5, prepareMediaPath } from "../../media-cache.ts";
import { boundedPositiveInteger, MEDIA_CONCURRENCY_BOUNDS } from "../../runtime-config.ts";
import { openMirror } from "../../serve/db/open.ts";
import { recordMediaVerificationRequirement } from "../../sync-status.ts";
import {
  MEDIA_CACHE_VERIFICATION_VERSION,
  type VerificationPolicy,
  verificationPolicySatisfies,
} from "../../verification.ts";
import { apiConfigFromEnv, DayOneApi } from "./api.ts";
import { runPool } from "./pool.ts";
import { RestReader } from "./reader.ts";

const md5hex = (b: Uint8Array): string => createHash("md5").update(b).digest("hex");
export const MAX_MEDIA_JOBS = 100_000;

export interface MediaJob {
  identifier: string;
  md5: string | null;
  kind: string;
  journalId: string;
  /** Persisted verification generation for the cached plaintext bytes. */
  verificationVersion?: number;
  /** Strongest D1 signature policy satisfied by the cached plaintext bytes. */
  verificationPolicy?: VerificationPolicy;
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
  /** Internal verification-generation contract used by syncMedia. */
  requiredVerificationVersion?: number;
  /** Internal minimum D1 signature policy required to reuse a cache file. */
  requiredVerificationPolicy?: VerificationPolicy;
  /** Invalidates any prior marker before network/file work begins. */
  onBeforeFetch?: (md5: string) => void;
  /** Called only after verified plaintext bytes have been written successfully. */
  onVerified?: (md5: string, policy: VerificationPolicy) => void;
}

const FILE_COMPARE_CHUNK_BYTES = 64 * 1024;

function resolveConcurrency(opts: MediaSyncOptions): number {
  return boundedPositiveInteger(
    "DAYONE_MEDIA_CONCURRENCY",
    opts.concurrency ?? process.env.DAYONE_MEDIA_CONCURRENCY,
    MEDIA_CONCURRENCY_BOUNDS,
  );
}

/** Read the media worklist (identifier + plaintext md5 + Day One journal id). */
function loadJobs(db: Database, entryUuid?: string): MediaJob[] {
  const where = entryUuid ? "WHERE m.entry_uuid = $uuid" : "";
  const jobs = db
    .query(
      `SELECT m.identifier, m.md5, m.kind, es.journal_id AS journalId,
              COALESCE(mv.verification_version, 0) AS verificationVersion,
              mv.verification_policy AS verificationPolicy
       FROM media m JOIN entry_sync es ON es.uuid = m.entry_uuid
       LEFT JOIN media_verification mv ON mv.md5 = m.md5
       ${where}
       LIMIT $limit`,
    )
    .all(
      entryUuid ? { $uuid: entryUuid, $limit: MAX_MEDIA_JOBS + 1 } : { $limit: MAX_MEDIA_JOBS + 1 },
    ) as MediaJob[];
  if (jobs.length > MAX_MEDIA_JOBS) {
    throw new RangeError(`media worklist exceeded the ${MAX_MEDIA_JOBS}-item safety limit`);
  }
  return jobs;
}

async function fileEqualsBytes(path: string, expected: Uint8Array): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    if ((await handle.stat()).size !== expected.byteLength) return false;
    const chunk = Buffer.allocUnsafe(Math.min(FILE_COMPARE_CHUNK_BYTES, expected.byteLength || 1));
    let offset = 0;
    while (offset < expected.byteLength) {
      const length = Math.min(chunk.byteLength, expected.byteLength - offset);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead !== length) return false;
      for (let i = 0; i < length; i++) {
        if (chunk[i] !== expected[offset + i]) return false;
      }
      offset += length;
    }
    return true;
  } finally {
    await handle.close();
  }
}

/**
 * Cache paths are write-once. Concurrent verification attempts may validate the
 * same plaintext, but a weaker attempt must never overwrite bytes already
 * associated with a stronger marker. Exact comparison (not MD5 alone) handles
 * the create race without accepting a collision.
 */
async function writeCacheOnce(path: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      // Hard-linking a complete same-directory temporary file is an atomic,
      // no-overwrite create of the final content-addressed path.
      await link(temporaryPath, path);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error as { code?: unknown }).code !== "EEXIST"
      ) {
        throw error;
      }
      if (!(await fileEqualsBytes(path, bytes))) {
        throw new Error("existing cache bytes do not match verified plaintext");
      }
    }
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
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
    const verificationCurrent =
      (opts.requiredVerificationVersion === undefined ||
        job.verificationVersion === opts.requiredVerificationVersion) &&
      (opts.requiredVerificationPolicy === undefined ||
        verificationPolicySatisfies(job.verificationPolicy, opts.requiredVerificationPolicy));
    if (verificationCurrent && isMediaCached(job.md5, opts.cacheDir)) {
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
      // Production removes any older marker in a committed SQLite write before
      // bytes can be fetched or created. A crash thereafter leaves the path
      // hidden rather than carrying a stale stronger policy.
      opts.onBeforeFetch?.(job.md5);
      const bytes = await fetchBytes(job);
      if (md5hex(bytes) !== job.md5) {
        stats.md5Mismatch++;
        opts.onProgress?.("one media item failed its plaintext checksum and was not cached");
        return;
      }
      const path = prepareMediaPath(job.md5, opts.cacheDir);
      installPrivateUmask();
      await writeCacheOnce(path, bytes);
      hardenPrivateFile(path);
      opts.onVerified?.(job.md5, opts.requiredVerificationPolicy ?? "compatible");
      stats.fetched++;
      stats.bytes += bytes.length;
      opts.onProgress?.(`cached one media item (${bytes.length} B)`);
    } catch {
      // One failed download must not abort the rest of the pool.
      stats.failed++;
      opts.onProgress?.("one media item failed network, verification, or decryption checks");
    }
  });
  return stats;
}

export async function syncMedia(masterKey: string, opts: MediaSyncOptions = {}): Promise<MediaSyncStats> {
  const db = openMirror(undefined, { writable: true });
  try {
    const jobs = loadJobs(db, opts.entryUuid);
    const markVerified = db.query(
      `INSERT INTO media_verification (md5, verification_version, verification_policy)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(md5) DO UPDATE SET
         verification_version = excluded.verification_version,
         verification_policy = excluded.verification_policy`,
    );
    const invalidateVerification = db.query("DELETE FROM media_verification WHERE md5 = ?");
    const api = new DayOneApi(apiConfigFromEnv());
    const reader = new RestReader(api, masterKey);
    recordMediaVerificationRequirement(db, reader.signaturePolicy);
    await api.ensureToken();
    const keys = await reader.unlockKeys();

    const stats = await runMediaJobs(jobs, (job) => reader.fetchMedia(job.journalId, job.identifier, keys), {
      ...opts,
      requiredVerificationVersion: MEDIA_CACHE_VERIFICATION_VERSION,
      requiredVerificationPolicy: keys.authenticity.policy,
      onBeforeFetch: (md5) => {
        invalidateVerification.run(md5);
      },
      onVerified: (md5, policy) => {
        markVerified.run(md5, MEDIA_CACHE_VERIFICATION_VERSION, policy);
      },
    });
    opts.onProgress?.(
      `D1 signatures: ${keys.authenticity.verified} verified, ` +
        `${keys.authenticity.unsignedAccepted} unsigned accepted (${keys.authenticity.policy})`,
    );
    return stats;
  } finally {
    db.close();
  }
}
