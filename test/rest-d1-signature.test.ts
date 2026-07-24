/**
 * D1 envelope SIGNATURE verification (server authenticity). Synthetic only: we
 * generate RSA-2048 signing keypairs in-test, build signed type-1/2 envelopes the
 * way Day One does (SHA256withRSA / RSASSA-PKCS1-v1_5 over the RSA-wrapped
 * `lockedKey`), and assert `parseD1` + `verifyD1Signature` classify each case.
 *
 * No real keys or real envelope bytes are ever committed.
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DecryptError } from "../src/errors.ts";
import { importJournalVerifyKey, parseD1, verifyD1Signature } from "../src/ingest/rest/d1.ts";

const subtle = globalThis.crypto.subtle;
const cat = (...a: Uint8Array[]) => {
  const n = a.reduce((s, x) => s + x.length, 0);
  const o = new Uint8Array(n);
  let p = 0;
  for (const x of a) {
    o.set(x, p);
    p += x.length;
  }
  return o;
};
const bytes = (...n: number[]) => new Uint8Array(n);
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const u16be = (n: number) => bytes((n >> 8) & 0xff, n & 0xff);
/** Append the trailing MD5(bytes[0..len)) checksum a real D1 blob carries. */
const seal = (withoutMd5: Uint8Array) =>
  cat(withoutMd5, new Uint8Array(createHash("md5").update(withoutMd5).digest()));

async function genSigningKey() {
  return (await subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}
async function spkiPem(pub: CryptoKey): Promise<string> {
  const der = new Uint8Array(await subtle.exportKey("spki", pub));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}
async function sign(priv: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, priv, data as BufferSource));
}

/** Build a type-1/2 D1 envelope carrying `signature` over `lockedKey`. */
function buildSigned(opts: {
  type: 1 | 2;
  fingerprint: Uint8Array;
  signature: Uint8Array;
  lockedKey: Uint8Array;
  iv?: Uint8Array;
  body?: Uint8Array;
}): Uint8Array {
  const iv = opts.iv ?? rand(12);
  const body = opts.body ?? rand(32); // ciphertext ‖ gcmTag (opaque here; verify only)
  return seal(
    cat(
      bytes(0x44, 0x31, 0x01, opts.type),
      opts.fingerprint,
      u16be(opts.signature.length),
      opts.signature,
      opts.lockedKey,
      iv,
      body,
    ),
  );
}

test("a valid signature over lockedKey verifies against the journal public key", async () => {
  const kp = await genSigningKey();
  const lockedKey = rand(256);
  const env = buildSigned({
    type: 2,
    fingerprint: rand(32),
    signature: await sign(kp.privateKey, lockedKey),
    lockedKey,
  });
  const verifyKey = await importJournalVerifyKey(await spkiPem(kp.publicKey));
  expect(await verifyD1Signature(parseD1(env), verifyKey)).toBe("verified");
});

test("a tampered lockedKey fails verification", async () => {
  const kp = await genSigningKey();
  const signed = rand(256);
  const signature = await sign(kp.privateKey, signed);
  const tampered = signed.slice();
  tampered[0] = tampered[0]! ^ 0xff; // flip a byte the signature no longer covers
  const env = buildSigned({ type: 1, fingerprint: rand(32), signature, lockedKey: tampered });
  const verifyKey = await importJournalVerifyKey(await spkiPem(kp.publicKey));
  expect(await verifyD1Signature(parseD1(env), verifyKey)).toBe("failed");
});

test("a signature made by the wrong key fails verification", async () => {
  const signer = await genSigningKey();
  const other = await genSigningKey();
  const lockedKey = rand(256);
  const env = buildSigned({
    type: 2,
    fingerprint: rand(32),
    signature: await sign(signer.privateKey, lockedKey),
    lockedKey,
  });
  const wrongKey = await importJournalVerifyKey(await spkiPem(other.publicKey));
  expect(await verifyD1Signature(parseD1(env), wrongKey)).toBe("failed");
});

test("a present signature with no available verify key is not trusted (failed)", async () => {
  const kp = await genSigningKey();
  const lockedKey = rand(256);
  const env = buildSigned({
    type: 2,
    fingerprint: rand(32),
    signature: await sign(kp.privateKey, lockedKey),
    lockedKey,
  });
  expect(await verifyD1Signature(parseD1(env), undefined)).toBe("failed");
});

test("a type-1/2 envelope carrying no signature (sigLen=0) counts as unsigned", async () => {
  const kp = await genSigningKey();
  const env = buildSigned({
    type: 1,
    fingerprint: rand(32),
    signature: new Uint8Array(0),
    lockedKey: rand(256),
  });
  const verifyKey = await importJournalVerifyKey(await spkiPem(kp.publicKey));
  expect(await verifyD1Signature(parseD1(env), verifyKey)).toBe("unsigned");
});

test("a format-0 (symmetric) envelope has no signature and counts as unsigned", async () => {
  const env = seal(cat(bytes(0x44, 0x31, 0x01, 0x00), rand(12), rand(40)));
  const parsed = parseD1(env);
  expect(parsed.type).toBe(0);
  expect(parsed.signature).toBeUndefined();
  expect(await verifyD1Signature(parsed, undefined)).toBe("unsigned");
});

test("parseD1 exposes fingerprint, signature, and lockedKey for a signed envelope", async () => {
  const kp = await genSigningKey();
  const fingerprint = rand(32);
  const lockedKey = rand(256);
  const signature = await sign(kp.privateKey, lockedKey);
  const parsed = parseD1(buildSigned({ type: 2, fingerprint, signature, lockedKey }));
  expect([...(parsed.fingerprint ?? [])]).toEqual([...fingerprint]);
  expect([...(parsed.lockedKey ?? [])]).toEqual([...lockedKey]);
  expect(parsed.signature).toHaveLength(256);
});

test("parseD1 rejects a truncated envelope cleanly", async () => {
  const kp = await genSigningKey();
  const lockedKey = rand(256);
  const full = buildSigned({
    type: 2,
    fingerprint: rand(32),
    signature: await sign(kp.privateKey, lockedKey),
    lockedKey,
  });
  // Cut inside the signed region: parsing must reject rather than read out of bounds.
  expect(() => parseD1(full.subarray(0, 100))).toThrow(DecryptError);
  expect(() => parseD1(bytes(0x44, 0x31, 0x01, 0x02))).toThrow(DecryptError);
});

test("parseD1 rejects a corrupted format checksum", () => {
  const env = seal(cat(bytes(0x44, 0x31, 0x01, 0x00), rand(12), rand(40)));
  env[env.length - 1] = env[env.length - 1]! ^ 0xff; // corrupt the trailing MD5
  expect(() => parseD1(env)).toThrow(/checksum mismatch/);
});

test("parseD1 rejects an unsupported binary format and bad magic", () => {
  expect(() => parseD1(seal(cat(bytes(0x44, 0x31, 0x01, 0x09), rand(12), rand(40))))).toThrow(DecryptError);
  expect(() => parseD1(seal(cat(bytes(0x00, 0x00, 0x01, 0x00), rand(12), rand(40))))).toThrow(/bad magic/);
});
