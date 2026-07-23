/**
 * Mirror-level sync completeness contract shared by ingestion and serving.
 *
 * `synced_at` remains the backwards-compatible timestamp of the last complete
 * sync. A later degraded/failed attempt must never move it forward.
 */

import type { Database } from "bun:sqlite";
import {
  isVerificationPolicy,
  REST_CONTENT_VERIFICATION_VERSION,
  type VerificationPolicy,
} from "./verification.ts";

export type SyncState = "running" | "complete" | "degraded" | "failed" | "unknown";

export interface SyncStatus {
  status: SyncState;
  last_attempt_at: string | null;
  last_complete_at: string | null;
  failed_entries: number;
  /** Monotonic attempt generation, incremented atomically at recordSyncStart. */
  sync_generation: number;
}

export interface SyncOutcome {
  status: Exclude<SyncState, "unknown" | "running">;
  attemptedAt: string;
  failedEntries: number;
  source?: string;
  /** Written only for a complete REST attempt that revalidated the full corpus. */
  verificationVersion?: number;
  /** Minimum D1 signature policy satisfied by the completed REST corpus. */
  verificationPolicy?: VerificationPolicy;
}

export class StaleSyncAttemptError extends Error {
  constructor(
    public readonly expectedGeneration: number,
    public readonly actualGeneration: number,
    public readonly actualStatus: SyncState,
  ) {
    super(
      `stale sync attempt: expected running generation ${expectedGeneration}, ` +
        `found ${actualStatus} generation ${actualGeneration}`,
    );
    this.name = "StaleSyncAttemptError";
  }
}

const META_KEYS = {
  syncedAt: "synced_at",
  source: "source",
  status: "sync_status",
  lastAttemptAt: "sync_last_attempt_at",
  lastCompleteAt: "sync_last_complete_at",
  failedEntries: "sync_failed_entries",
  generation: "sync_generation",
  verificationVersion: "rest_content_verification_version",
  verificationPolicy: "rest_content_verification_policy",
  verificationRequiredPolicy: "rest_content_verification_required_policy",
  mediaVerificationRequiredPolicy: "media_verification_required_policy",
} as const;

const isStoredState = (value: string | undefined): value is Exclude<SyncState, "unknown"> =>
  value === "running" || value === "complete" || value === "degraded" || value === "failed";

/** Read status from new or legacy mirrors without requiring a migration. */
export function readSyncStatus(db: Database): SyncStatus {
  try {
    const rows = db
      .query(
        `SELECT key, value FROM meta
         WHERE key IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .all(
        META_KEYS.syncedAt,
        META_KEYS.status,
        META_KEYS.lastAttemptAt,
        META_KEYS.lastCompleteAt,
        META_KEYS.failedEntries,
        META_KEYS.generation,
        META_KEYS.source,
        META_KEYS.verificationVersion,
        META_KEYS.verificationPolicy,
        META_KEYS.verificationRequiredPolicy,
      ) as { key: string; value: string | null }[];
    const meta = new Map(rows.map((row) => [row.key, row.value ?? ""]));
    const legacySyncedAt = meta.get(META_KEYS.syncedAt) || null;
    const storedState = meta.get(META_KEYS.status);
    const storedStatus: SyncState = isStoredState(storedState)
      ? storedState
      : legacySyncedAt
        ? "complete"
        : "unknown";
    const parsedVerificationVersion = Number(meta.get(META_KEYS.verificationVersion));
    const verificationVersion =
      Number.isSafeInteger(parsedVerificationVersion) && parsedVerificationVersion >= 0
        ? parsedVerificationVersion
        : 0;
    const verificationPolicy = meta.get(META_KEYS.verificationPolicy);
    const verificationRequiredPolicy = meta.get(META_KEYS.verificationRequiredPolicy);
    // A mirror produced by REST before the current verification generation must
    // not keep advertising a complete API-observed mirror before its one-time
    // revalidation run.
    const status: SyncState =
      storedStatus === "complete" &&
      meta.get(META_KEYS.source) === "rest" &&
      (verificationVersion < REST_CONTENT_VERIFICATION_VERSION ||
        !isVerificationPolicy(verificationPolicy) ||
        (isVerificationPolicy(verificationRequiredPolicy) &&
          verificationRequiredPolicy === "strict" &&
          verificationPolicy !== "strict"))
        ? "degraded"
        : storedStatus;
    const parsedFailures = Number(meta.get(META_KEYS.failedEntries));
    const parsedGeneration = Number(meta.get(META_KEYS.generation));
    return {
      status,
      last_attempt_at: meta.get(META_KEYS.lastAttemptAt) || (status === "complete" ? legacySyncedAt : null),
      last_complete_at: meta.get(META_KEYS.lastCompleteAt) || legacySyncedAt,
      failed_entries: Number.isSafeInteger(parsedFailures) && parsedFailures >= 0 ? parsedFailures : 0,
      sync_generation: Number.isSafeInteger(parsedGeneration) && parsedGeneration >= 0 ? parsedGeneration : 0,
    };
  } catch {
    // Mirrors predating the meta table are readable and explicitly unknown.
    return {
      status: "unknown",
      last_attempt_at: null,
      last_complete_at: null,
      failed_entries: 0,
      sync_generation: 0,
    };
  }
}

/**
 * Assert that a writer still owns the active attempt. Call this inside the same
 * SQLite transaction as each entry mutation so a newer overlapping start cannot
 * be followed by writes from the stale process.
 */
export function assertSyncAttempt(db: Database, expectedGeneration: number): void {
  const current = readSyncStatus(db);
  if (current.sync_generation !== expectedGeneration || current.status !== "running") {
    throw new StaleSyncAttemptError(expectedGeneration, current.sync_generation, current.status);
  }
}

/**
 * Atomically finalize an attempt. Only complete attempts advance both the
 * backwards-compatible `synced_at` and the explicit `last_complete_at`.
 */
export function recordSyncOutcome(
  db: Database,
  outcome: SyncOutcome,
  expectedGeneration?: number,
): SyncStatus {
  const setMeta = db.query(
    `INSERT INTO meta (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  return db
    .transaction(() => {
      if (expectedGeneration !== undefined) assertSyncAttempt(db, expectedGeneration);
      setMeta.run(META_KEYS.status, outcome.status);
      setMeta.run(META_KEYS.lastAttemptAt, outcome.attemptedAt);
      setMeta.run(META_KEYS.failedEntries, String(outcome.failedEntries));
      if (outcome.source) setMeta.run(META_KEYS.source, outcome.source);
      if (outcome.status === "complete") {
        if (outcome.verificationVersion !== undefined) {
          setMeta.run(META_KEYS.verificationVersion, String(outcome.verificationVersion));
        }
        if (outcome.verificationPolicy !== undefined) {
          setMeta.run(META_KEYS.verificationPolicy, outcome.verificationPolicy);
        }
        setMeta.run(META_KEYS.syncedAt, outcome.attemptedAt);
        setMeta.run(META_KEYS.lastCompleteAt, outcome.attemptedAt);
      }
      return readSyncStatus(db);
    })
    .immediate();
}

/** Missing/invalid values are generation zero and therefore require revalidation. */
export function readRestVerificationVersion(db: Database): number {
  try {
    const row = db.query("SELECT value FROM meta WHERE key = ?").get(META_KEYS.verificationVersion) as {
      value: string | null;
    } | null;
    const parsed = Number(row?.value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export interface RestVerificationState {
  version: number;
  policy?: VerificationPolicy;
  requiredPolicy?: VerificationPolicy;
  mediaRequiredPolicy?: VerificationPolicy;
}

/** Missing/invalid policy is untrusted and cannot satisfy either current policy. */
export function readRestVerificationState(db: Database): RestVerificationState {
  try {
    const rows = db
      .query("SELECT key, value FROM meta WHERE key IN (?1, ?2, ?3, ?4)")
      .all(
        META_KEYS.verificationVersion,
        META_KEYS.verificationPolicy,
        META_KEYS.verificationRequiredPolicy,
        META_KEYS.mediaVerificationRequiredPolicy,
      ) as {
      key: string;
      value: string | null;
    }[];
    const meta = new Map(rows.map((row) => [row.key, row.value]));
    const parsed = Number(meta.get(META_KEYS.verificationVersion));
    const policy = meta.get(META_KEYS.verificationPolicy);
    const requiredPolicy = meta.get(META_KEYS.verificationRequiredPolicy);
    const mediaRequiredPolicy = meta.get(META_KEYS.mediaVerificationRequiredPolicy);
    return {
      version: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0,
      policy: isVerificationPolicy(policy) ? policy : undefined,
      requiredPolicy: isVerificationPolicy(requiredPolicy) ? requiredPolicy : undefined,
      ...(isVerificationPolicy(mediaRequiredPolicy) ? { mediaRequiredPolicy } : {}),
    };
  } catch {
    return { version: 0 };
  }
}

/** Persist the standalone media-fetch policy floor before unlock/network work. */
export function recordMediaVerificationRequirement(db: Database, policy: VerificationPolicy): void {
  db.query(
    `INSERT INTO meta (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(META_KEYS.mediaVerificationRequiredPolicy, policy);
}

/**
 * Persist the policy requested by the active attempt before processing content.
 * Serving uses this floor immediately, even if strict revalidation later fails.
 */
export function recordRestVerificationRequirement(
  db: Database,
  expectedGeneration: number,
  policy: VerificationPolicy,
): void {
  db.transaction(() => {
    assertSyncAttempt(db, expectedGeneration);
    db.query(
      `INSERT INTO meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(META_KEYS.verificationRequiredPolicy, policy);
  }).immediate();
}

/**
 * Mark an attempt in-flight before ingestion starts. If the process crashes or
 * is killed after partially updating the mirror, readers keep seeing `running`
 * instead of a stale `complete` claim. The last complete timestamp is preserved.
 */
export function recordSyncStart(db: Database, attemptedAt: string, source?: string): SyncStatus {
  const setMeta = db.query(
    `INSERT INTO meta (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  return db
    .transaction(() => {
      // The first statement is a write, so concurrent processes queue on SQLite's
      // write lock instead of both taking read snapshots and then racing through a
      // read→write upgrade. RETURNING gives this attempt the exact generation it
      // owns without a post-commit read race.
      const generation = db
        .query(
          `INSERT INTO meta (key, value) VALUES (?1, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1
         WHERE meta.value <> ''
           AND meta.value NOT GLOB '*[^0-9]*'
           AND CAST(meta.value AS INTEGER) >= 0
           AND CAST(meta.value AS INTEGER) < ?2
         RETURNING value`,
        )
        .get(META_KEYS.generation, Number.MAX_SAFE_INTEGER) as { value: string } | null;
      if (!generation) {
        throw new RangeError("sync_generation is invalid or exhausted");
      }
      setMeta.run(META_KEYS.status, "running");
      setMeta.run(META_KEYS.lastAttemptAt, attemptedAt);
      setMeta.run(META_KEYS.failedEntries, "0");
      if (source) setMeta.run(META_KEYS.source, source);
      // Return the generation written by this transaction. Reading after commit
      // would let a second start race in and hand the first caller its generation.
      return readSyncStatus(db);
    })
    .immediate();
}
