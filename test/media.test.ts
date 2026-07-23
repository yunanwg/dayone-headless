/**
 * Media byte fetch + decrypt tests.
 *   1. Cache path helpers — pure, always run.
 *   2. decryptAttachment — a synthetic D1 type-2 envelope round-trips, always run.
 *   3. Live fetch — opt-in via DAYONE_MEDIA_LIVE_TEST=1 (needs a synced mirror +
 *      creds); skipped in CI so no real data is required.
 */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptAttachment } from "../src/ingest/rest/d1.ts";
import { isMediaCached, mediaCachePath, prepareMediaPath } from "../src/media-cache.ts";

test("mediaCachePath keys by md5 under the given dir", () => {
  expect(mediaCachePath("abc123", "/tmp/m")).toBe("/tmp/m/abc123");
});

test("isMediaCached reflects presence; prepareMediaPath makes the dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "media-"));
  const md5 = "deadbeef";
  expect(isMediaCached(md5, dir)).toBe(false);
  const path = prepareMediaPath(md5, dir); // mkdirs the parent
  await Bun.write(path, new Uint8Array([1, 2, 3]));
  expect(isMediaCached(md5, dir)).toBe(true);
  expect(existsSync(path)).toBe(true);
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
    new Uint8Array(16), // trailing md5, stripped by parseD1
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const blob = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    blob.set(p, off);
    off += p.length;
  }

  const out = await decryptAttachment(kp.privateKey, blob);
  expect(new TextDecoder().decode(out)).toBe("the original file bytes \u{1F4F7}");
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
