/**
 * REST crypto primitives — a from-scratch reimplementation of Day One's E2EE,
 * using WebCrypto (available in bun/Node/browser). These are the primitives
 * captured by CDP recon (docs/protocol.md) and the RSA-OAEP unwrap +
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

/** Confirmed parameters (from the app bundle + oracle-validated where noted). */
export const PARAMS = {
  // master-key → user-key: PBKDF2(password=utf8(code groups), salt=utf8(userId),
  // 100k iters, SHA-256) → AES-256-GCM. (The 10k/SHA-512 seen at runtime was the
  // unrelated local secure-KV store.)
  pbkdf2: { iterations: 100_000, hash: "SHA-256" },
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
 * against a real blob before trusting (docs/protocol.md unknown #5).
 */
export async function aesGcmDecryptEnvelope(key: CryptoKey, envelope: Uint8Array): Promise<Uint8Array> {
  const iv = envelope.subarray(0, PARAMS.aes.ivBytes) as BufferSource;
  const body = envelope.subarray(PARAMS.aes.ivBytes) as BufferSource; // ciphertext ‖ tag
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, body));
}

/** AES-256-GCM decrypt with an explicit iv (when iv is carried out-of-band). */
export async function aesGcmDecrypt(
  key: CryptoKey,
  iv: BufferSource,
  ctPlusTag: BufferSource,
): Promise<Uint8Array> {
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, ctPlusTag));
}

/**
 * Derive K_pass from the passphrase (PBKDF2 → AES-256-GCM key). This unwraps the
 * user's RSA private key, removing the need for the cached copy (the passphrase path).
 */
export async function derivePassphraseKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const base = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PARAMS.pbkdf2.iterations, hash: PARAMS.pbkdf2.hash },
    base,
    { name: "AES-GCM", length: PARAMS.aes.keyBits },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface MasterKeyParts {
  userId: string;
  passwordBytes: Uint8Array;
}

/**
 * Parse Day One's master "encryption key" — the `D1-<userId>-<code…>` string the
 * user types on the decrypt screen. The PBKDF2 password is the code groups joined
 * (dashes stripped) as UTF-8; the userId (part [1]) is also the PBKDF2 salt.
 */
export function parseMasterKey(masterKey: string): MasterKeyParts {
  const parts = masterKey.trim().split("-");
  if (parts.length <= 2 || parts[0] !== "D1") {
    throw new Error("invalid master key — expected D1-<userId>-<code…>");
  }
  return { userId: parts[1]!, passwordBytes: new TextEncoder().encode(parts.slice(2).join("")) };
}

/**
 * Derive K_pass (raw 32-byte AES-256-GCM key) from the master key:
 * PBKDF2(password = utf8(code groups), salt = utf8(userId), 100k iters, SHA-256).
 * This key unwraps the user's private key (a D1 type-00 blob).
 */
export async function deriveMasterAesKey(masterKey: string): Promise<{ userId: string; keyRaw: Uint8Array }> {
  const { userId, passwordBytes } = parseMasterKey(masterKey);
  const base = await subtle.importKey("raw", passwordBytes as BufferSource, { name: "PBKDF2" }, false, [
    "deriveBits",
  ]);
  const bits = await subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(userId) as BufferSource,
      iterations: PARAMS.pbkdf2.iterations,
      hash: PARAMS.pbkdf2.hash,
    },
    base,
    PARAMS.aes.keyBits,
  );
  return { userId, keyRaw: new Uint8Array(bits) };
}
