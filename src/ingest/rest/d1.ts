/**
 * Day One "D1" envelope + the full content-decryption chain — a from-scratch,
 * browser-free reimplementation. Validated end-to-end against a known-plaintext
 * entry fetched via the REST client: recovers the exact plaintext.
 *
 * Envelope: "D1"(2) ‖ ver(0x01)(1) ‖ type(1) ‖ [type≠0: fingerprint(32) ‖
 * sigLen(uint16 BE)(2) ‖ signature(sigLen) ‖ lockedKey(256)] ‖ iv(12) ‖
 * cipherText ‖ gcmTag(16) ‖ md5(16). The trailing 16-byte MD5 covers bytes
 * [0..len-16) and must be stripped before AES-GCM (the GCM tag authenticates).
 *
 *   type 0x00 — symmetric: AES-256-GCM with the raw 32-byte vault key (no KDF).
 *   type 0x01 — PBKDF2/passphrase (the user key; salt in payload).
 *   type 0x02 — RSA-hybrid: RSA-OAEP unwrap the 256-byte lockedKey → 32-byte
 *               content key → AES-256-GCM the body. Plaintext may be gzip'd.
 */

import { gunzipSync } from "node:zlib";
import { deriveMasterAesKey, importAesKey, rsaUnwrap } from "./crypto.ts";

const subtle = globalThis.crypto.subtle;
const td = new TextDecoder();
const MD5_LEN = 16;

export interface D1Envelope {
  type: number;
  iv: Uint8Array;
  /** cipherText ‖ gcmTag, ready for WebCrypto AES-GCM (trailing md5 already removed). */
  body: Uint8Array;
  /** type≠0 only: the RSA-wrapped content key (256B). */
  lockedKey?: Uint8Array;
  /** type≠0 only: SHA-256 fingerprint of the journal key that wraps `lockedKey`. */
  fingerprint?: Uint8Array;
}

export function parseD1(b: Uint8Array): D1Envelope {
  if (b[0] !== 0x44 || b[1] !== 0x31) throw new Error(`not a D1 envelope (magic ${b[0]},${b[1]})`);
  const type = b[3]!;
  let off = 4;
  let fingerprint: Uint8Array | undefined;
  let lockedKey: Uint8Array | undefined;
  if (type !== 0) {
    fingerprint = b.slice(off, off + 32);
    off += 32;
    const sigLen = (b[off]! << 8) | b[off + 1]!;
    off += 2;
    off += sigLen; // signature (unused for decryption)
    lockedKey = b.slice(off, off + 256);
    off += 256;
  }
  const iv = b.slice(off, off + 12);
  off += 12;
  const body = b.slice(off, b.length - MD5_LEN); // strip trailing md5; keep ct ‖ tag
  return { type, iv, body, lockedKey, fingerprint };
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

/** Un-gzip transparently (Day One binaryFormat≥2 gzips content; up to 3 passes). */
export function maybeGunzip(u: Uint8Array): Uint8Array {
  let out = u;
  for (let i = 0; i < 3 && out[0] === 0x1f && out[1] === 0x8b; i++) out = new Uint8Array(gunzipSync(out));
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
