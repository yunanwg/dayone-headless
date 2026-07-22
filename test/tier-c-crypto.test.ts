/**
 * Tier C crypto primitive tests — synthetic roundtrips only (generated keys /
 * random data), never real Day One key material. The byte-identical conformance
 * against the live vault fingerprint oracle is exercised separately (needs a
 * session), not here.
 */

import { test, expect } from "bun:test";
import {
  PARAMS, keyFingerprint, rsaUnwrap, importAesKey,
  aesGcmDecryptEnvelope, aesGcmDecrypt, derivePassphraseKey,
} from "../src/ingest/tier-c/crypto.ts";

const subtle = globalThis.crypto.subtle;

test("RSA-OAEP/SHA-1 unwrap round-trips a 32-byte key", async () => {
  const kp = (await subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true, ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const vaultKey = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await subtle.encrypt({ name: "RSA-OAEP" }, kp.publicKey, vaultKey);
  const out = await rsaUnwrap(kp.privateKey, wrapped);
  expect([...out]).toEqual([...vaultKey]);
});

test("keyFingerprint is SHA-256 hex (64 chars, deterministic)", async () => {
  const raw = new Uint8Array(32).fill(7);
  const fp = await keyFingerprint(raw);
  expect(fp).toMatch(/^[0-9a-f]{64}$/);
  expect(await keyFingerprint(raw)).toBe(fp);
});

test("AES-256-GCM envelope (iv‖ct‖tag) decrypts to the plaintext", async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await importAesKey(raw);
  const iv = crypto.getRandomValues(new Uint8Array(PARAMS.aes.ivBytes));
  const plain = new TextEncoder().encode("synthetic content — not a real journal entry");
  const ctTag = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const envelope = new Uint8Array(iv.length + ctTag.length);
  envelope.set(iv, 0);
  envelope.set(ctTag, iv.length);

  expect([...(await aesGcmDecryptEnvelope(key, envelope))]).toEqual([...plain]);
  expect([...(await aesGcmDecrypt(key, iv, ctTag))]).toEqual([...plain]);
});

test("derivePassphraseKey (PBKDF2) yields a usable AES-GCM key", async () => {
  const salt = crypto.getRandomValues(new Uint8Array(PARAMS.pbkdf2.saltBytes));
  const key = await derivePassphraseKey("correct horse battery staple", salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode("wrapped private key bytes");
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const back = await aesGcmDecrypt(key, iv, ct);
  expect([...back]).toEqual([...plain]);

  // Same passphrase+salt derives the same key; a different salt does not.
  const key2 = await derivePassphraseKey("correct horse battery staple", salt);
  expect([...(await aesGcmDecrypt(key2, iv, ct))]).toEqual([...plain]);
});
