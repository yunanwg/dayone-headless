/**
 * D1 envelope + decrypt-chain tests. Synthetic only: we generate keys, BUILD D1
 * blobs the way Day One does, then assert our parser/decryptor recovers them.
 */

import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { deriveMasterAesKey, parseMasterKey } from "../src/ingest/rest/crypto.ts";
import {
  decryptEntryContent,
  decryptJournalPrivateKey,
  decryptUserPrivateKey,
  entryD1Body,
  MAX_D1_GZIP_LAYERS,
  maybeGunzip,
  parseD1,
} from "../src/ingest/rest/d1.ts";

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

async function gcmEncrypt(keyRaw: Uint8Array, iv: Uint8Array, pt: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", keyRaw as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  return new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, k, pt as BufferSource),
  ); // ct ‖ tag
}
async function genRsa() {
  return (await subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
}
async function toPem(priv: CryptoKey): Promise<string> {
  const der = new Uint8Array(await subtle.exportKey("pkcs8", priv));
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}
const md5pad = bytes(...new Array(16).fill(0)); // parser strips it; content irrelevant

test("parseD1 slices type-00 and type-02 layouts correctly", () => {
  const iv = rand(12),
    body = rand(40);
  const t0 = cat(bytes(0x44, 0x31, 0x01, 0x00), iv, body, md5pad);
  const p0 = parseD1(t0);
  expect(p0.type).toBe(0);
  expect([...p0.iv]).toEqual([...iv]);
  expect([...p0.body]).toEqual([...body]);

  const fp = rand(32),
    locked = rand(256);
  const t2 = cat(bytes(0x44, 0x31, 0x01, 0x02), fp, bytes(0x00, 0x00), locked, iv, body, md5pad);
  const p2 = parseD1(t2);
  expect(p2.type).toBe(2);
  expect(p2.lockedKey).toHaveLength(256);
  expect([...p2.iv]).toEqual([...iv]);
  expect([...p2.body]).toEqual([...body]);
});

test("decryptJournalPrivateKey (type-00) recovers a usable RSA key", async () => {
  const journal = await genRsa();
  const vaultKey = rand(32);
  const iv = rand(12);
  const pem = new TextEncoder().encode(await toPem(journal.privateKey));
  const blob = cat(bytes(0x44, 0x31, 0x01, 0x00), iv, await gcmEncrypt(vaultKey, iv, pem), md5pad);

  const recovered = await decryptJournalPrivateKey(vaultKey, blob);
  // Prove it's the same key: unwrap something wrapped to the journal's public key.
  const secret = rand(32);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, journal.publicKey, secret));
  const out = new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, recovered, wrapped));
  expect([...out]).toEqual([...secret]);
});

test("decryptEntryContent (type-02) recovers plaintext, incl. gzip + JSON-header prefix", async () => {
  const journal = await genRsa();
  const contentKey = rand(32);
  const lockedKey = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, journal.publicKey, contentKey));
  const iv = rand(12);
  const known = "rest-synthetic-entry-plaintext-日记";
  const gz = new Uint8Array(gzipSync(new TextEncoder().encode(known)));
  const d1 = cat(
    bytes(0x44, 0x31, 0x01, 0x02),
    rand(32),
    bytes(0, 0),
    lockedKey,
    iv,
    await gcmEncrypt(contentKey, iv, gz),
    md5pad,
  );
  // Prepend a JSON header ‖ \n like getEntryContent() returns.
  const blob = cat(new TextEncoder().encode('{"revision":{"entryId":"X"}}'), bytes(0x0a), d1);

  expect(entryD1Body(blob)[0]).toBe(0x44); // header stripped
  const out = await decryptEntryContent(journal.privateKey, blob);
  expect(new TextDecoder().decode(out)).toBe(known);
});

test("parseMasterKey splits D1-<userId>-<code…> into userId + password bytes", () => {
  const { userId, passwordBytes } = parseMasterKey("D1-user123456-ABCDE-FGHJK");
  expect(userId).toBe("user123456");
  expect(new TextDecoder().decode(passwordBytes)).toBe("ABCDEFGHJK"); // groups joined, dashes stripped
  expect(() => parseMasterKey("not-a-key")).toThrow();
});

test("decryptUserPrivateKey (master key → PBKDF2 → type-00) recovers the user key", async () => {
  const user = await genRsa();
  const masterKey = "D1-user123456-ABCDE-FGHJK-LMNPQ-RTUVW-XYZ23-46789";
  const { keyRaw, userId } = await deriveMasterAesKey(masterKey);
  expect(userId).toBe("user123456");
  expect(keyRaw).toHaveLength(32);

  const iv = rand(12);
  const pem = new TextEncoder().encode(await toPem(user.privateKey));
  const blob = cat(bytes(0x44, 0x31, 0x01, 0x00), iv, await gcmEncrypt(keyRaw, iv, pem), md5pad);

  const recovered = await decryptUserPrivateKey(masterKey, blob);
  const secret = rand(32);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, user.publicKey, secret));
  const out = new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, recovered, wrapped));
  expect([...out]).toEqual([...secret]); // proves the recovered key is the user's
});

test("maybeGunzip passes plain bytes through and inflates gzip", () => {
  const plain = new TextEncoder().encode("not gzipped");
  expect([...maybeGunzip(plain)]).toEqual([...plain]);
  const gz = new Uint8Array(gzipSync(new TextEncoder().encode("hello")));
  expect(new TextDecoder().decode(maybeGunzip(gz))).toBe("hello");
});

test("maybeGunzip bounds gzip bombs and nested layers before retaining plaintext", () => {
  const bomb = new Uint8Array(gzipSync(new Uint8Array(4096)));
  expect(() => maybeGunzip(bomb, 64)).toThrow(/safety limit/);

  let nested = new TextEncoder().encode("synthetic");
  for (let i = 0; i <= MAX_D1_GZIP_LAYERS; i++) nested = new Uint8Array(gzipSync(nested));
  expect(() => maybeGunzip(nested, 4096)).toThrow(/nesting limit/);
});
