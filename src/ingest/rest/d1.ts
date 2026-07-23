/**
 * Day One "D1" envelope parsing, verification, and decryption.
 *
 * Current documented layout:
 * "D1" ‖ cryptoVersion(0x01) ‖ binaryFormat(0|1|2) ‖
 * [format 1/2: fingerprint(32) ‖ signatureLength(u16be) ‖ signature ‖
 * lockedKey(256)] ‖ iv(12) ‖ ciphertext ‖ gcmTag(16) ‖ md5(16).
 *
 * The MD5 is a format checksum, not a security boundary. AES-GCM authenticates
 * the ciphertext. For formats 1/2, a present SHA256withRSA signature authenticates
 * the RSA-wrapped content key against the journal public key.
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
export const MAX_D1_ENVELOPE_BYTES = 512 * 1024 * 1024;
export const MAX_ENTRY_PLAINTEXT_BYTES = 8 * 1024 * 1024;
export const MAX_D1_PLAINTEXT_BYTES = MAX_ENTRY_PLAINTEXT_BYTES;
export const MAX_D1_GZIP_LAYERS = 3;

export type D1BinaryFormat = 0 | 1 | 2;
export type D1SignatureDisposition = "verified" | "unsigned";

export interface D1Envelope {
  cryptoVersion: 1;
  type: D1BinaryFormat;
  iv: Uint8Array;
  /** ciphertext ‖ GCM tag, ready for WebCrypto (the trailing MD5 is excluded). */
  body: Uint8Array;
  /** Format 1/2 only: RSA-wrapped content key, and the exact signed bytes. */
  lockedKey?: Uint8Array;
  /** Format 1/2 only: SHA-256 fingerprint of the wrapping journal public key. */
  fingerprint?: Uint8Array;
  /** Format 1/2 only. Empty means the producer had only the public key. */
  signature?: Uint8Array;
  /** The verified format checksum carried by the blob. */
  checksum: Uint8Array;
}

export interface VerifiedJournalKey {
  fingerprint: string;
  decryptKey: CryptoKey;
  verifyKey: CryptoKey;
}

function fail(message: string): never {
  throw new DecryptError(`invalid D1 envelope: ${message}`);
}

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
 * Strictly parse and checksum one complete D1 blob. Returned byte fields are
 * copies, so later mutation of the network buffer cannot change what is verified
 * or decrypted.
 */
export function parseD1(input: Uint8Array): D1Envelope {
  if (input.byteLength > MAX_D1_ENVELOPE_BYTES) fail("exceeds the supported size limit");
  const bytes = input.slice();
  if (bytes.length < 4 + IV_LEN + GCM_TAG_LEN + MD5_LEN) fail("too short");
  if (bytes[0] !== 0x44 || bytes[1] !== 0x31) fail("bad magic");
  if (bytes[2] !== 0x01) fail("unsupported crypto schema version");
  const type = bytes[3];
  if (type !== 0 && type !== 1 && type !== 2) fail("unsupported binary format");

  const checksumStart = bytes.length - MD5_LEN;
  const checksum = bytes.slice(checksumStart);
  const calculated = createHash("md5").update(bytes.subarray(0, checksumStart)).digest();
  if (!timingSafeEqual(calculated, checksum)) fail("checksum mismatch");

  let off = 4;
  let fingerprint: Uint8Array | undefined;
  let signature: Uint8Array | undefined;
  let lockedKey: Uint8Array | undefined;
  if (type !== 0) {
    fingerprint = checkedSlice(bytes, off, FINGERPRINT_LEN, checksumStart, "fingerprint");
    off += FINGERPRINT_LEN;
    const sigLenBytes = checkedSlice(bytes, off, 2, checksumStart, "signature length");
    off += 2;
    const sigLen = (sigLenBytes[0]! << 8) | sigLenBytes[1]!;
    if (sigLen !== 0 && sigLen !== RSA_2048_SIGNATURE_LEN) {
      fail("unsupported signature length");
    }
    signature = checkedSlice(bytes, off, sigLen, checksumStart, "signature");
    off += sigLen;
    lockedKey = checkedSlice(bytes, off, LOCKED_KEY_LEN, checksumStart, "locked key");
    off += LOCKED_KEY_LEN;
  }

  const iv = checkedSlice(bytes, off, IV_LEN, checksumStart, "IV");
  off += IV_LEN;
  const bodyLength = checksumStart - off;
  if (bodyLength < GCM_TAG_LEN) fail("ciphertext has no complete GCM tag");
  const body = checkedSlice(bytes, off, bodyLength, checksumStart, "ciphertext");

  return {
    cryptoVersion: 1,
    type,
    iv,
    body,
    lockedKey,
    fingerprint,
    signature,
    checksum,
  };
}

async function aesGcm(keyRaw: Uint8Array, iv: Uint8Array, body: Uint8Array): Promise<Uint8Array> {
  try {
    const key = await importAesKey(keyRaw as BufferSource);
    return new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, body as BufferSource),
    );
  } catch {
    throw new DecryptError("D1 AES-GCM decryption failed");
  }
}

export function pemToDer(pem: string, label: "PRIVATE KEY" | "PUBLIC KEY"): Uint8Array {
  const match = pem
    .trim()
    .match(new RegExp(`^-----BEGIN ${label}-----\\s*([A-Za-z0-9+/=\\s]+?)\\s*-----END ${label}-----$`));
  if (!match) throw new DecryptError(`invalid ${label.toLowerCase()} PEM`);
  const compact = match[1]!.replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0) throw new DecryptError(`invalid ${label.toLowerCase()} PEM`);
  try {
    const decoded = Uint8Array.from(atob(compact), (c) => c.charCodeAt(0));
    if (!decoded.length) throw new Error("empty");
    return decoded;
  } catch {
    throw new DecryptError(`invalid ${label.toLowerCase()} PEM`);
  }
}

function isGzip(input: Uint8Array): boolean {
  return input[0] === 0x1f && input[1] === 0x8b;
}

/** Inflate one gzip layer without allowing its decoded output past the ceiling. */
export function gunzipBounded(input: Uint8Array, maximumBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximum gunzip bytes must be a positive safe integer");
  }
  try {
    const output = new Uint8Array(gunzipSync(input, { maxOutputLength: maximumBytes }));
    if (output.byteLength > maximumBytes) throw new Error("limit");
    return output;
  } catch {
    throw new DecryptError("D1 gzip output is invalid or exceeded the size limit");
  }
}

/** Compatibility helper for historical nested content; every layer is bounded. */
export function maybeGunzip(
  input: Uint8Array,
  maximumBytes = MAX_D1_PLAINTEXT_BYTES,
  maximumLayers = MAX_D1_GZIP_LAYERS,
): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximum plaintext bytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maximumLayers) || maximumLayers < 0) {
    throw new RangeError("maximum gzip layers must be a non-negative safe integer");
  }
  if (input.byteLength > maximumBytes) {
    throw new DecryptError("D1 plaintext exceeded the size limit");
  }

  let output = input;
  let layers = 0;
  while (isGzip(output)) {
    if (layers >= maximumLayers) {
      throw new DecryptError("D1 content exceeded the gzip nesting limit");
    }
    output = gunzipBounded(output, maximumBytes);
    layers++;
  }
  return output;
}

/** Strictly decode the single gzip layer required by binary format 2. */
export function gunzipD1Format2(input: Uint8Array): Uint8Array {
  if (!isGzip(input)) throw new DecryptError("D1 binary format 2 plaintext was not gzip");
  const output = gunzipBounded(input, MAX_ENTRY_PLAINTEXT_BYTES);
  if (isGzip(output)) throw new DecryptError("D1 binary format 2 contained nested gzip");
  return output;
}

/** Decrypt a parsed binary-format-0 blob with its already-known AES key. */
export async function decryptD1Symmetric(aesKeyRaw: Uint8Array, envelope: D1Envelope): Promise<Uint8Array> {
  if (envelope.type !== 0) throw new DecryptError("expected D1 binary format 0");
  return aesGcm(aesKeyRaw, envelope.iv, envelope.body);
}

/**
 * Decrypt an RSA private key stored in a binary-format-0 D1 blob and import it
 * for RSA-OAEP/SHA-1 content-key unwraps.
 */
export async function decryptD1PrivateKey(
  aesKeyRaw: Uint8Array,
  encryptedPrivateKey: Uint8Array,
): Promise<CryptoKey> {
  const envelope = parseD1(encryptedPrivateKey);
  const pem = td.decode(await decryptD1Symmetric(aesKeyRaw, envelope));
  const der = pemToDer(pem, "PRIVATE KEY");
  try {
    return await subtle.importKey("pkcs8", der as BufferSource, { name: "RSA-OAEP", hash: "SHA-1" }, false, [
      "decrypt",
    ]);
  } catch {
    throw new DecryptError("invalid decrypted RSA private key");
  }
}

export const decryptJournalPrivateKey = decryptD1PrivateKey;

export async function decryptUserPrivateKey(
  masterKey: string,
  encryptedPrivateKey: Uint8Array,
): Promise<CryptoKey> {
  const { keyRaw } = await deriveMasterAesKey(masterKey);
  return decryptD1PrivateKey(keyRaw, encryptedPrivateKey);
}

/** Extract the D1 portion from `<JSON envelope>\\n<D1 blob>`, without aliases. */
export function entryD1Body(blob: Uint8Array): Uint8Array {
  if (blob[0] === 0x44 && blob[1] === 0x31) return blob.slice();
  const nl = blob.indexOf(0x0a);
  if (nl < 0 || blob[nl + 1] !== 0x44 || blob[nl + 2] !== 0x31) {
    throw new DecryptError("entry response did not contain a D1 body");
  }
  return blob.slice(nl + 1);
}

function fingerprintHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a format-1/2 envelope before unwrapping. Compatible mode accepts an
 * explicitly unsigned blob because Day One documents server-created content
 * with signatureLength=0. Strict mode rejects it, closing signature stripping.
 */
export async function verifyD1Signature(
  envelope: D1Envelope,
  key: VerifiedJournalKey,
  requireSignature: boolean,
): Promise<D1SignatureDisposition> {
  if (envelope.type === 0 || !envelope.fingerprint || !envelope.lockedKey || !envelope.signature) {
    throw new DecryptError("D1 signature verification requires binary format 1 or 2");
  }
  if (fingerprintHex(envelope.fingerprint) !== key.fingerprint) {
    throw new DecryptError("D1 journal-key fingerprint mismatch");
  }
  if (envelope.signature.length === 0) {
    if (requireSignature) throw new DecryptError("unsigned D1 envelope rejected by strict policy");
    return "unsigned";
  }
  let valid = false;
  try {
    valid = await subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key.verifyKey,
      envelope.signature as BufferSource,
      envelope.lockedKey as BufferSource,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new DecryptError("D1 locked-key signature verification failed");
  return "verified";
}

async function decryptHybrid(
  key: VerifiedJournalKey,
  envelope: D1Envelope,
  requireSignature: boolean,
): Promise<{ plain: Uint8Array; signature: D1SignatureDisposition }> {
  const signature = await verifyD1Signature(envelope, key, requireSignature);
  let contentKey: Uint8Array;
  try {
    contentKey = await rsaUnwrap(key.decryptKey, envelope.lockedKey as BufferSource);
  } catch {
    throw new DecryptError("D1 content-key unwrap failed");
  }
  if (contentKey.length !== 32) throw new DecryptError("D1 content key was not 256 bits");
  return { plain: await aesGcm(contentKey, envelope.iv, envelope.body), signature };
}

/** Decrypt one parsed entry body. Official entry JSON uses binary format 2. */
export async function decryptEntryContent(
  key: VerifiedJournalKey,
  envelope: D1Envelope,
  requireSignature: boolean,
): Promise<{ plain: Uint8Array; signature: D1SignatureDisposition }> {
  if (envelope.type !== 2) throw new DecryptError("entry content was not D1 binary format 2");
  const result = await decryptHybrid(key, envelope, requireSignature);
  return { plain: gunzipD1Format2(result.plain), signature: result.signature };
}

/** Decrypt one parsed attachment. Official binary content uses format 1. */
export async function decryptAttachment(
  key: VerifiedJournalKey,
  envelope: D1Envelope,
  requireSignature: boolean,
): Promise<{ plain: Uint8Array; signature: D1SignatureDisposition }> {
  if (envelope.type !== 1) throw new DecryptError("attachment was not D1 binary format 1");
  return decryptHybrid(key, envelope, requireSignature);
}
