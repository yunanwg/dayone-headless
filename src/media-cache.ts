/**
 * Media byte cache — a content-addressed store of decrypted attachment bytes,
 * keyed by the media md5 (which is the md5 of the *plaintext* file, the same id
 * the mirror stores in `media.md5` and the JSON export names files by). Pure
 * filesystem + path logic: no Day One, no crypto — so both the ingester (which
 * writes it after decrypting) and the serving layer (which only reads it) can use
 * it without breaking the decoupling rule.
 *
 * Gitignored, like the mirror: decrypted personal media never enters git.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Cache root. Defaults under the mirror's `data/` dir; override for tests/homelab. */
export const MEDIA_DIR = process.env.DAYONE_MEDIA_DIR ?? "data/media";

/** Absolute-ish path where the decrypted bytes for a given md5 live (no extension;
 *  the content-type comes from the mirror's media metadata). */
export function mediaCachePath(md5: string, dir: string = MEDIA_DIR): string {
  return join(dir, md5);
}

/** True if the decrypted bytes for this md5 are already cached. */
export function isMediaCached(md5: string, dir: string = MEDIA_DIR): boolean {
  return existsSync(mediaCachePath(md5, dir));
}

/** Ensure the cache directory for a given md5 exists; returns its file path. The
 *  caller writes the bytes (e.g. `Bun.write`) so the I/O stays async. */
export function prepareMediaPath(md5: string, dir: string = MEDIA_DIR): string {
  const path = mediaCachePath(md5, dir);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
