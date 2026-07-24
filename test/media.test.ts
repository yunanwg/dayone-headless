/**
 * Media byte fetch + decrypt tests.
 *   1. Cache path helpers — pure, always run.
 *   2. decryptAttachment — a synthetic D1 type-2 envelope round-trips, always run.
 *   3. runMediaJobs — pool/limit/verify/cache logic with an injected fake
 *      fetcher (no network/crypto), always run.
 *   4. Live fetch — opt-in via DAYONE_MEDIA_LIVE_TEST=1 (needs a synced mirror +
 *      creds); skipped in CI so no real data is required.
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptAttachment } from "../src/ingest/rest/d1.ts";
import { type MediaJob, runMediaJobs } from "../src/ingest/rest/media.ts";
import { isMediaCached, isValidMd5, mediaCachePath, prepareMediaPath } from "../src/media-cache.ts";

const MD5_A = "0123456789abcdef0123456789abcdef";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test("mediaCachePath keys by md5 under the given dir", () => {
  expect(mediaCachePath(MD5_A, "/tmp/m")).toBe(`/tmp/m/${MD5_A}`);
});

test("isMediaCached reflects presence; prepareMediaPath makes the dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-"));
  const md5 = "deadbeefdeadbeefdeadbeefdeadbeef";
  expect(isMediaCached(md5, dir)).toBe(false);
  const path = prepareMediaPath(md5, dir); // mkdirs the parent
  await Bun.write(path, new Uint8Array([1, 2, 3]));
  expect(isMediaCached(md5, dir)).toBe(true);
  expect(existsSync(path)).toBe(true);
});

test("md5 guard: valid 32-hex passes, everything else is rejected", () => {
  expect(isValidMd5(MD5_A)).toBe(true);
  // Wrong length, uppercase, non-hex, and non-string all fail.
  expect(isValidMd5("abc123")).toBe(false);
  expect(isValidMd5(MD5_A.toUpperCase())).toBe(false);
  expect(isValidMd5(`${MD5_A}0`)).toBe(false);
  expect(isValidMd5(null)).toBe(false);
  expect(isValidMd5(undefined)).toBe(false);
});

test("md5 path-traversal strings never join a path", () => {
  // A malformed / hostile md5 reads as "not cached" and never touches `join`.
  for (const evil of ["../../etc/passwd", "..", "a/../../secret", "abc\0", "/etc/hosts"]) {
    expect(isValidMd5(evil)).toBe(false);
    expect(isMediaCached(evil, "/tmp/m")).toBe(false);
    expect(() => mediaCachePath(evil, "/tmp/m")).toThrow("invalid media md5");
  }
});

test("decryptAttachment round-trips a synthetic D1 type-2 envelope", async () => {
  // Build the same envelope shape the S3 blob has: RSA-OAEP/SHA-1-wrapped 32-byte
  // content key, AES-256-GCM body, trailing (unverified-by-decrypt) 16-byte md5.
  const kp = (await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;

  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const lockedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: "RSA-OAEP" }, kp.publicKey, contentKey),
  );
  expect(lockedKey.length).toBe(256);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const plaintext = new TextEncoder().encode("the original file bytes \u{1F4F7}");
  const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext));

  // magic "D1" ‖ ver 1 ‖ type 2 ‖ fingerprint(32) ‖ sigLen(0) ‖ lockedKey(256) ‖ iv(12) ‖ ct‖tag ‖ md5(16)
  const parts = [
    Uint8Array.of(0x44, 0x31, 0x01, 0x02),
    new Uint8Array(32), // fingerprint (not consulted by decryptAttachment)
    Uint8Array.of(0x00, 0x00), // sigLen = 0
    lockedKey,
    iv,
    ctTag,
  ];
  const prefixLen = parts.reduce((n, p) => n + p.length, 0);
  const prefix = new Uint8Array(prefixLen);
  let off = 0;
  for (const p of parts) {
    prefix.set(p, off);
    off += p.length;
  }
  // Append the real trailing MD5 over bytes[0..len-16) that parseD1 now verifies.
  const md5 = new Uint8Array(createHash("md5").update(prefix).digest());
  const blob = new Uint8Array(prefixLen + md5.length);
  blob.set(prefix, 0);
  blob.set(md5, prefixLen);

  const out = await decryptAttachment(kp.privateKey, blob);
  expect(new TextDecoder().decode(out)).toBe("the original file bytes \u{1F4F7}");
});

/** Synthetic worklist: each job's bytes are derived from its index; md5 matches. */
function syntheticJobs(n: number): { jobs: MediaJob[]; bytesFor: (job: MediaJob) => Uint8Array } {
  const bytesFor = (job: MediaJob) => new TextEncoder().encode(`synthetic-bytes-${job.identifier}`);
  const jobs: MediaJob[] = Array.from({ length: n }, (_, i) => {
    const identifier = `SYNTH-${String(i).padStart(4, "0")}`;
    const bytes = new TextEncoder().encode(`synthetic-bytes-${identifier}`);
    return {
      identifier,
      md5: createHash("md5").update(bytes).digest("hex"),
      kind: "photo",
      journalId: "J1",
    };
  });
  return { jobs, bytesFor };
}

test("runMediaJobs: `limit` is exact — exactly `limit` fetch calls even with wider concurrency", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-limit-"));
  const { jobs, bytesFor } = syntheticJobs(20);
  let fetchCalls = 0;
  const stats = await runMediaJobs(
    jobs,
    async (job) => {
      fetchCalls++;
      await new Promise((r) => setTimeout(r, 1)); // let workers interleave
      return bytesFor(job);
    },
    { limit: 10, concurrency: 6, cacheDir: dir },
  );
  expect(fetchCalls).toBe(10); // not 10..15: no over-fetch beyond the cap
  expect(stats.fetched).toBe(10);
  expect(stats.failed).toBe(0);
  expect(stats.total).toBe(20);
});

test("runMediaJobs: verifies md5 before caching and skips already-cached files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-verify-"));
  const { jobs, bytesFor } = syntheticJobs(4);
  // Pre-cache job 0; corrupt the fetcher for job 1.
  await Bun.write(prepareMediaPath(jobs[0]!.md5!, dir), bytesFor(jobs[0]!));
  let fetchCalls = 0;
  const stats = await runMediaJobs(
    jobs,
    async (job) => {
      fetchCalls++;
      return job === jobs[1] ? new TextEncoder().encode("wrong bytes") : bytesFor(job);
    },
    { concurrency: 2, cacheDir: dir },
  );
  expect(fetchCalls).toBe(3); // cached job never hits the fetcher
  expect(stats.alreadyCached).toBe(1);
  expect(stats.md5Mismatch).toBe(1);
  expect(stats.fetched).toBe(2);
  expect(isMediaCached(jobs[1]!.md5!, dir)).toBe(false); // wrong-decrypt never written
  expect(isMediaCached(jobs[2]!.md5!, dir)).toBe(true);
  expect(isMediaCached(jobs[3]!.md5!, dir)).toBe(true);
  expect(mode(dir)).toBe(0o700);
  expect(mode(mediaCachePath(jobs[2]!.md5!, dir))).toBe(0o600);
  expect(mode(mediaCachePath(jobs[3]!.md5!, dir))).toBe(0o600);
});

test("runMediaJobs: a missing or malformed md5 is skipped up front, never fetched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-badmd5-"));
  const { jobs, bytesFor } = syntheticJobs(2);
  const bad: MediaJob[] = [
    { identifier: "NO-MD5", md5: null, kind: "photo", journalId: "J1" },
    { identifier: "EVIL-MD5", md5: "../../etc/passwd", kind: "photo", journalId: "J1" },
  ];
  let fetchCalls = 0;
  const stats = await runMediaJobs(
    [...jobs, ...bad],
    async (job) => {
      fetchCalls++;
      return bytesFor(job);
    },
    { concurrency: 2, cacheDir: dir },
  );
  expect(fetchCalls).toBe(2); // only the two well-formed jobs hit the fetcher
  expect(stats.skippedNoMd5).toBe(2);
  expect(stats.fetched).toBe(2);
  expect(stats.failed).toBe(0);
});

test("runMediaJobs: one failed download does not abort the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-fail-"));
  const { jobs, bytesFor } = syntheticJobs(5);
  const progress: string[] = [];
  const stats = await runMediaJobs(
    jobs,
    async (job) => {
      if (job === jobs[2]) {
        throw new Error("https://token@private.synthetic.test/file /private/synthetic/cache");
      }
      return bytesFor(job);
    },
    { concurrency: 3, cacheDir: dir, onProgress: (message) => progress.push(message) },
  );
  expect(stats.failed).toBe(1);
  expect(stats.fetched).toBe(4);
  expect(progress.join("\n")).not.toContain("token@");
  expect(progress.join("\n")).not.toContain("/private/synthetic/cache");
  expect(progress.join("\n")).not.toContain(jobs[2]!.identifier);
  expect(progress.some((message) => message.includes("download or cache error"))).toBe(true);
});

const live = process.env.DAYONE_MEDIA_LIVE_TEST === "1";
test.skipIf(!live)("live: media-fetch caches at least one byte-correct attachment", async () => {
  const { syncMedia } = await import("../src/ingest/rest/media.ts");
  const key = process.env.DAYONE_ENCRYPTION_KEY as string;
  const stats = await syncMedia(key, { limit: 1 });
  expect(stats.md5Mismatch).toBe(0);
  expect(stats.failed).toBe(0);
  expect(stats.fetched + stats.alreadyCached).toBeGreaterThan(0);
});
