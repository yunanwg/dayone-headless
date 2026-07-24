/**
 * Day One "D1" envelope + the full content-decryption chain — a from-scratch,
 * browser-free reimplementation. Validated end-to-end against a known-plaintext
 * entry fetched via the REST client: recovers the exact plaintext.
 *
 * Envelope: "D1"(2) ‖ ver(0x01)(1) ‖ type(1) ‖ [type≠0: fingerprint(32) ‖
 * sigLen(uint16 BE)(2) ‖ signature(sigLen) ‖ lockedKey(256)] ‖ iv(12) ‖
 * cipherText ‖ gcmTag(16) ‖ md5(16). The trailing 16-byte MD5 is a FORMAT
 * checksum over bytes [0..len-16) (not a security boundary — AES-GCM
 * authenticates the ciphertext). It is verified during parsing and stripped
 * before AES-GCM.
 *
 *   type 0x00 — symmetric: AES-256-GCM with the raw 32-byte vault key (no KDF).
 *   type 0x01 — PBKDF2/passphrase (the user key; salt in payload).
 *   type 0x02 — RSA-hybrid: RSA-OAEP unwrap the 256-byte lockedKey → 32-byte
 *               content key → AES-256-GCM the body. Plaintext may be gzip'd.
 *
 * SERVER AUTHENTICITY. For type 1/2 the envelope also carries a SHA256withRSA
 * (RSASSA-PKCS1-v1_5) signature over the 256-byte RSA-wrapped `lockedKey`. It is
 * verifiable with the journal's PUBLIC key (`vault.keys[].public_key`, PEM SPKI),
 * selected by the envelope `fingerprint` = SHA-256 of that key's SPKI DER. This
 * module parses/exposes the signature and offers `verifyD1Signature`; the read
 * path (reader.ts) decides policy. `lockedKey` bytes are copied out of the
 * network buffer so later reuse cannot change what is verified vs. decrypted.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { DecryptError } from "../../errors.ts";
import { deriveMasterAesKey, importAesKey, rsaUnwrap } from "./crypto.ts";

const subtle = globalThis.crypto.subtle;
const td = new TextDecoder();
const MD5_LEN = 16;
const GCM_TAG_LEN = 16;
const IV_LEN = 12;
const FINGERPRINT_LEN = 32;
const LOCKED_KEY_LEN = 256;
const RSA_2048_SIGNATURE_LEN = 256;
/** A single D1 blob larger than this is refused before any allocation. */
export const MAX_D1_ENVELOPE_BYTES = 512 * 1024 * 1024;
export const MAX_D1_PLAINTEXT_BYTES = 16 * 1024 * 1024;
export const MAX_D1_GZIP_LAYERS = 3;

/** The verification outcome for one type-1/2 envelope. */
export type D1SignatureOutcome = "verified" | "unsigned" | "failed";

export interface D1Envelope {
  type: number;
  iv: Uint8Array;
  /** cipherText ‖ gcmTag, ready for WebCrypto AES-GCM (trailing md5 already removed). */
  body: Uint8Array;
  /** type≠0 only: the RSA-wrapped content key (256B). */
  lockedKey?: Uint8Array;
  /** type≠0 only: SHA-256 fingerprint of the journal key that wraps `lockedKey`. */
  fingerprint?: Uint8Array;
  /** type≠0 only: the SHA256withRSA signature over `lockedKey`. Empty when the
   *  producer had only the public key (server-created content). */
  signature?: Uint8Array;
}

function fail(message: string): never {
  throw new DecryptError(`invalid D1 envelope: ${message}`);
}

/** Copy `[start, start+length)` out of `bytes`, refusing any out-of-range read. */
function checkedSlice(
  bytes: Uint8Array,
  start: number,
  length: number,
  end: number,
  field: string,
): Uint8Array {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
    fail(`invalid ${field} bounds`);
  }
  const next = start + length;
  if (next > end || next < start) fail(`truncated ${field}`);
  return bytes.slice(start, next);
}

/**
 * Strictly parse and checksum one complete D1 blob. Every returned byte field is
 * a copy, so later mutation of the source network buffer cannot change what is
 * verified or decrypted.
 */
export function parseD1(input: Uint8Array): D1Envelope {
  if (input.byteLength > MAX_D1_ENVELOPE_BYTES) fail("exceeds the supported size limit");
  const b = input.slice();
  if (b.length < 4 + IV_LEN + GCM_TAG_LEN + MD5_LEN) fail("too short");
  if (b[0] !== 0x44 || b[1] !== 0x31) fail(`bad magic (${b[0]},${b[1]})`);
  if (b[2] !== 0x01) fail("unsupported crypto schema version");
  const type = b[3]!;
  if (type !== 0 && type !== 1 && type !== 2) fail("unsupported binary format");

  const checksumStart = b.length - MD5_LEN;
  const checksum = b.subarray(checksumStart);
  const calculated = createHash("md5").update(b.subarray(0, checksumStart)).digest();
  if (!timingSafeEqual(calculated, Buffer.from(checksum))) fail("checksum mismatch");

  let off = 4;
  let fingerprint: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  let lockedKey: Uint8Array | undefined;
  if (type !== 0) {
    fingerprint = checkedSlice(b, off, FINGERPRINT_LEN, checksumStart, "fingerprint");
    off += FINGERPRINT_LEN;
    const sigLenBytes = checkedSlice(b, off, 2, checksumStart, "signature length");
    off += 2;
    const sigLen = (sigLenBytes[0]! << 8) | sigLenBytes[1]!;
    if (sigLen !== 0 && sigLen !== RSA_2048_SIGNATURE_LEN) fail("unsupported signature length");
    signature = checkedSlice(b, off, sigLen, checksumStart, "signature");
    off += sigLen;
    lockedKey = checkedSlice(b, off, LOCKED_KEY_LEN, checksumStart, "locked key");
    off += LOCKED_KEY_LEN;
  }

  const iv = checkedSlice(b, off, IV_LEN, checksumStart, "IV");
  off += IV_LEN;
  const bodyLength = checksumStart - off;
  if (bodyLength < GCM_TAG_LEN) fail("ciphertext has no complete GCM tag");
  const body = checkedSlice(b, off, bodyLength, checksumStart, "ciphertext");

  return { type, iv, body, lockedKey, fingerprint, signature };
}

async function aesGcm(keyRaw: Uint8Array, iv: Uint8Array, body: Uint8Array): Promise<Uint8Array> {
  const key = await importAesKey(keyRaw as BufferSource);
  return new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, body as BufferSource),
  );
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Import a journal PUBLIC key (PEM SPKI, `vault.keys[].public_key`) for
 * RSASSA-PKCS1-v1_5 / SHA-256 signature verification.
 */
export function importJournalVerifyKey(spkiPem: string): Promise<CryptoKey> {
  return subtle.importKey(
    "spki",
    pemToDer(spkiPem) as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Verify a type-1/2 envelope's signature over its `lockedKey`, given the journal
 * verify key selected by fingerprint. Returns a disposition instead of throwing
 * so the caller can apply policy (warn-and-keep vs. fail-closed):
 *   - "unsigned"  — no signature present (server-created content is documented
 *                   to carry `sigLen=0`), or a type-0 envelope with no signature.
 *   - "failed"    — a signature is present but does not verify, or no verify key
 *                   is available for its fingerprint (a present claim we cannot
 *                   check is not trustworthy).
 *   - "verified"  — the signature verifies against the journal public key.
 */
export async function verifyD1Signature(
  envelope: D1Envelope,
  verifyKey: CryptoKey | undefined,
): Promise<D1SignatureOutcome> {
  if (envelope.type === 0 || !envelope.lockedKey) return "unsigned";
  if (!envelope.signature || envelope.signature.length === 0) return "unsigned";
  if (!verifyKey) return "failed";
  try {
    const valid = await subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      verifyKey,
      envelope.signature as BufferSource,
      envelope.lockedKey as BufferSource,
    );
    return valid ? "verified" : "failed";
  } catch {
    return "failed";
  }
}

function isGzip(u: Uint8Array): boolean {
  return u[0] === 0x1f && u[1] === 0x8b;
}

/** Inflate one gzip layer without allowing the decoded output to exceed a hard ceiling. */
export function gunzipBounded(u: Uint8Array, maximumBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximum gunzip bytes must be a positive safe integer");
  }
  try {
    const out = new Uint8Array(gunzipSync(u, { maxOutputLength: maximumBytes }));
    if (out.byteLength > maximumBytes) throw new Error("limit");
    return out;
  } catch {
    throw new Error(`D1 gzip output is invalid or exceeded the ${maximumBytes}-byte safety limit`);
  }
}

/**
 * Un-gzip transparently (Day One binaryFormat≥2 gzips content), bounding every
 * layer before it can become retained decrypted source.
 */
export function maybeGunzip(
  u: Uint8Array,
  maximumBytes = MAX_D1_PLAINTEXT_BYTES,
  maximumLayers = MAX_D1_GZIP_LAYERS,
): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximum plaintext bytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maximumLayers) || maximumLayers < 0) {
    throw new RangeError("maximum gzip layers must be a non-negative safe integer");
  }
  if (u.byteLength > maximumBytes) {
    throw new Error(`D1 plaintext exceeded the ${maximumBytes}-byte safety limit`);
  }

  let out = u;
  let layers = 0;
  while (isGzip(out)) {
    if (layers >= maximumLayers) {
      throw new Error(`D1 content exceeded the ${maximumLayers}-layer gzip nesting limit`);
    }
    out = gunzipBounded(out, maximumBytes);
    layers++;
  }
  return out;
}

/** Decrypt a symmetric **D1 type-00** blob with a raw AES-256-GCM key → plaintext
 * bytes. Used for RSA private keys (below) and small values like journal names. */
export async function decryptD1Symmetric(aesKeyRaw: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  const d = parseD1(blob);
  return aesGcm(aesKeyRaw, d.iv, d.body);
}

/**
 * Decrypt an RSA private key stored as a **D1 type-00** blob (AES-256-GCM with a
 * raw key) → imported RSA-OAEP/SHA-1 key. Used for both the journal content key
 * (AES key = vault key) and the user key (AES key = K_pass from the master key).
 */
export async function decryptD1PrivateKey(
  aesKeyRaw: Uint8Array,
  encryptedPrivateKey: Uint8Array,
): Promise<CryptoKey> {
  const pem = td.decode(await decryptD1Symmetric(aesKeyRaw, encryptedPrivateKey)); // PKCS#8 PEM
  return subtle.importKey(
    "pkcs8",
    pemToDer(pem) as BufferSource,
    { name: "RSA-OAEP", hash: "SHA-1" },
    false,
    ["decrypt"],
  );
}

/** The journal content private key: D1 type-00, unlocked by the vault key. */
export const decryptJournalPrivateKey = decryptD1PrivateKey;

/**
 * The USER's private key: derive K_pass from the master key `D1-<userId>-<code…>`,
 * then decrypt the type-00 `encryptedPrivateKey` (from `GET /api/users/key`). This
 * is the pure-passphrase path — no cached key, no browser.
 */
export async function decryptUserPrivateKey(
  masterKey: string,
  encryptedPrivateKey: Uint8Array,
): Promise<CryptoKey> {
  const { keyRaw } = await deriveMasterAesKey(masterKey);
  return decryptD1PrivateKey(keyRaw, encryptedPrivateKey);
}

/** Strip the `<json header>\n` prefix an entry-content blob carries before its D1 body. */
export function entryD1Body(blob: Uint8Array): Uint8Array {
  const nl = blob.indexOf(0x0a);
  return nl >= 0 && blob[nl + 1] === 0x44 ? blob.slice(nl + 1) : blob;
}

/**
 * Decrypt one entry's content (D1 type 0x02) given the journal private key.
 * Returns the (un-gzipped) plaintext bytes.
 */
export async function decryptEntryContent(
  journalPriv: CryptoKey,
  entryBlob: Uint8Array,
): Promise<Uint8Array> {
  const d = parseD1(entryD1Body(entryBlob));
  if (!d.lockedKey) throw new Error(`entry D1 type ${d.type} has no lockedKey`);
  const contentKey = await rsaUnwrap(journalPriv, d.lockedKey as BufferSource);
  return maybeGunzip(await aesGcm(contentKey, d.iv, d.body));
}

/**
 * Decrypt one attachment (photo / video / audio / pdf) blob given the journal
 * content private key. Unlike entry content, an attachment blob is a bare D1
 * envelope — no `<json header>\n` prefix (so no `entryD1Body`) and NOT gzipped:
 * the AES-GCM plaintext IS the original file bytes. Returns those bytes.
 */
export async function decryptAttachment(journalPriv: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  const d = parseD1(blob);
  if (!d.lockedKey) throw new Error(`attachment D1 type ${d.type} has no lockedKey`);
  const contentKey = await rsaUnwrap(journalPriv, d.lockedKey as BufferSource);
  return aesGcm(contentKey, d.iv, d.body);
}
