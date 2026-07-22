/**
 * Tier C crypto primitives — a from-scratch reimplementation of Day One's E2EE,
 * using WebCrypto (available in bun/Node/browser). These are the primitives
 * captured by CDP recon (docs/tier-c-crypto.md) and the RSA-OAEP unwrap +
 * fingerprint have been validated byte-identical against the app's own vault
 * fingerprint oracle.
 *
 * Nothing here holds secrets at rest — callers pass key material in transiently.
 *
 * Key hierarchy:
 *   passphrase --PBKDF2--> K_pass --AES-GCM--> user RSA private key (PKCS8)
 *     --RSA-OAEP--> per-journal vault key (32B) --AES-GCM--> entry/attachment content
 */

const subtle = globalThis.crypto.subtle;

/** Confirmed parameters (recon + oracle-validated where noted). */
export const PARAMS = {
  pbkdf2: { iterations: 10_000, hash: "SHA-256", saltBytes: 22 }, // → 256-bit AES-GCM
  rsa: { name: "RSA-OAEP", hash: "SHA-1" }, // validated against fingerprint oracle
  aes: { name: "AES-GCM", ivBytes: 12, tagBytes: 16, keyBits: 256 },
} as const;

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 fingerprint (hex) of raw key bytes — matches Day One's `*_fingerprint`. */
export async function keyFingerprint(raw: BufferSource): Promise<string> {
  return toHex(await subtle.digest("SHA-256", raw));
}

/** Import a PKCS8 RSA private key for OAEP/SHA-1 decryption (the user key). */
export function importRsaPrivateKey(pkcs8: BufferSource): Promise<CryptoKey> {
  return subtle.importKey("pkcs8", pkcs8, PARAMS.rsa, false, ["decrypt"]);
}

/** RSA-OAEP decrypt a wrapped key (e.g. a grant's `encrypted_vault_key`). */
export async function rsaUnwrap(privateKey: CryptoKey, wrapped: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await subtle.decrypt({ name: PARAMS.rsa.name }, privateKey, wrapped));
}

/** Import 32 raw bytes as an AES-256-GCM key. */
export function importAesKey(raw32: BufferSource): Promise<CryptoKey> {
  return subtle.importKey("raw", raw32, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * AES-256-GCM decrypt an envelope laid out as `iv(12) ‖ ciphertext ‖ tag(16)`
 * (WebCrypto expects `ciphertext ‖ tag` as the data and the iv separately).
 * NOTE: the iv/ct/tag concatenation order is the assumed stored layout — confirm
 * against a real blob before trusting (docs/tier-c-crypto.md unknown #5).
 */
export async function aesGcmDecryptEnvelope(key: CryptoKey, envelope: Uint8Array): Promise<Uint8Array> {
  const iv = envelope.subarray(0, PARAMS.aes.ivBytes) as BufferSource;
  const body = envelope.subarray(PARAMS.aes.ivBytes) as BufferSource; // ciphertext ‖ tag
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, body));
}

/** AES-256-GCM decrypt with an explicit iv (when iv is carried out-of-band). */
export async function aesGcmDecrypt(key: CryptoKey, iv: BufferSource, ctPlusTag: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, ctPlusTag));
}

/**
 * Derive K_pass from the passphrase (PBKDF2 → AES-256-GCM key). This unwraps the
 * user's RSA private key, removing the need for the cached copy (Tier C path #1).
 */
export async function derivePassphraseKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PARAMS.pbkdf2.iterations, hash: PARAMS.pbkdf2.hash },
    base,
    { name: "AES-GCM", length: PARAMS.aes.keyBits },
    false,
    ["encrypt", "decrypt"],
  );
}
