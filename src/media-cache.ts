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

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { preparePrivateDirectory } from "./local-permissions.ts";

/** Cache root. Defaults under the mirror's `data/` dir; override for tests/homelab. */
export const MEDIA_DIR = process.env.DAYONE_MEDIA_DIR ?? "data/media";

/**
 * A well-formed Day One media md5: exactly 32 lowercase hex chars. Real values are
 * `createHash("md5").digest("hex")` output (see `src/ingest/rest/media.ts`), i.e.
 * always lowercase — so we require lowercase rather than normalizing case. This is
 * the path-traversal guard: the md5 is a DB-sourced string joined into a filesystem
 * path, so anything with `/`, `..`, or NUL must never reach `join`.
 */
const MD5_RE = /^[0-9a-f]{32}$/;

/** True iff `md5` is a well-formed 32-char lowercase-hex md5 (see `MD5_RE`). */
export function isValidMd5(md5: unknown): md5 is string {
  return typeof md5 === "string" && MD5_RE.test(md5);
}

/** Absolute-ish path where the decrypted bytes for a given md5 live (no extension;
 *  the content-type comes from the mirror's media metadata). Throws on a malformed
 *  md5 rather than joining an attacker-controlled string into a path. */
export function mediaCachePath(md5: string, dir: string = MEDIA_DIR): string {
  if (!isValidMd5(md5)) throw new Error("invalid media md5");
  return join(dir, md5);
}

/** True if the decrypted bytes for this md5 are already cached. A malformed md5 is
 *  never cached (and never joined into a path) — it reads as "not cached". */
export function isMediaCached(md5: string, dir: string = MEDIA_DIR): boolean {
  if (!isValidMd5(md5)) return false;
  return existsSync(mediaCachePath(md5, dir));
}

/** Ensure the cache directory for a given md5 exists; returns its file path. The
 *  caller writes the bytes (e.g. `Bun.write`) so the I/O stays async. */
export function prepareMediaPath(md5: string, dir: string = MEDIA_DIR): string {
  const path = mediaCachePath(md5, dir);
  preparePrivateDirectory(dirname(path));
  return path;
}
