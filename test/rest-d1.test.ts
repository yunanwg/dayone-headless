/**
 * Synthetic D1 framing, checksum, signature, and decrypt-chain tests.
 * No account-derived bytes or identifiers are used.
 */

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { deriveMasterAesKey, keyFingerprint, parseMasterKey } from "../src/ingest/rest/crypto.ts";
import {
  decryptAttachment,
  decryptEntryContent,
  decryptJournalPrivateKey,
  decryptUserPrivateKey,
  entryD1Body,
  gunzipD1Format2,
  MAX_D1_GZIP_LAYERS,
  MAX_ENTRY_PLAINTEXT_BYTES,
  maybeGunzip,
  parseD1,
  type VerifiedJournalKey,
} from "../src/ingest/rest/d1.ts";

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

const cat = (...parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};
const bytes = (...values: number[]) => new Uint8Array(values);
const rand = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const md5 = (value: Uint8Array) => new Uint8Array(createHash("md5").update(value).digest());
const seal = (...parts: Uint8Array[]) => {
  const payload = cat(...parts);
  return cat(payload, md5(payload));
};

async function gcmEncrypt(keyRaw: Uint8Array, iv: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", keyRaw as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  return new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource),
  );
}

async function generateRsaMaterial() {
  const pair = (await subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const verifyKey = await subtle.importKey(
    "spki",
    spki,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingKey = await subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const fingerprint = await keyFingerprint(spki);
  const verified: VerifiedJournalKey = {
    fingerprint,
    decryptKey: pair.privateKey,
    verifyKey,
  };
  return { pair, spki, pkcs8, signingKey, verified };
}

function toPem(der: Uint8Array, label: "PRIVATE KEY" | "PUBLIC KEY"): string {
  const b64 = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

async function hybridBlob(
  material: Awaited<ReturnType<typeof generateRsaMaterial>>,
  format: 1 | 2,
  plaintext: Uint8Array,
  signed = true,
) {
  const contentKey = rand(32);
  const lockedKey = new Uint8Array(
    await subtle.encrypt({ name: "RSA-OAEP" }, material.pair.publicKey, contentKey),
  );
  const signature = signed
    ? new Uint8Array(
        await subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, material.signingKey, lockedKey as BufferSource),
      )
    : new Uint8Array();
  const iv = rand(12);
  const body = await gcmEncrypt(contentKey, iv, plaintext);
  const sigLength = bytes((signature.length >>> 8) & 0xff, signature.length & 0xff);
  return seal(
    bytes(0x44, 0x31, 0x01, format),
    Uint8Array.from(Buffer.from(material.verified.fingerprint, "hex")),
    sigLength,
    signature,
    lockedKey,
    iv,
    body,
  );
}

test("parseD1 validates and preserves every current format field", async () => {
  const iv = rand(12);
  const body = rand(40);
  const symmetric = seal(bytes(0x44, 0x31, 0x01, 0x00), iv, body);
  const parsedSymmetric = parseD1(symmetric);
  expect(parsedSymmetric).toMatchObject({ cryptoVersion: 1, type: 0 });
  expect([...parsedSymmetric.iv]).toEqual([...iv]);
  expect([...parsedSymmetric.body]).toEqual([...body]);

  const material = await generateRsaMaterial();
  const signed = await hybridBlob(material, 1, te.encode("synthetic attachment"));
  const parsedSigned = parseD1(signed);
  expect(parsedSigned.type).toBe(1);
  expect(parsedSigned.signature).toHaveLength(256);
  expect(parsedSigned.lockedKey).toHaveLength(256);
  expect(parsedSigned.fingerprint).toHaveLength(32);
  expect(parsedSigned.checksum).toHaveLength(16);
});

test("parseD1 rejects bad magic/version/type/length/truncation and checksum tampering", () => {
  const iv = rand(12);
  const body = rand(24);
  const valid = seal(bytes(0x44, 0x31, 0x01, 0x00), iv, body);
  const corruptChecksum = valid.slice();
  corruptChecksum[corruptChecksum.length - 1] = corruptChecksum[corruptChecksum.length - 1]! ^ 1;
  expect(() => parseD1(corruptChecksum)).toThrow("checksum mismatch");

  expect(() => parseD1(seal(bytes(0x00, 0x31, 0x01, 0x00), iv, body))).toThrow("bad magic");
  expect(() => parseD1(seal(bytes(0x44, 0x31, 0x02, 0x00), iv, body))).toThrow(
    "unsupported crypto schema version",
  );
  expect(() => parseD1(seal(bytes(0x44, 0x31, 0x01, 0x03), iv, body))).toThrow("unsupported binary format");
  expect(() =>
    parseD1(seal(bytes(0x44, 0x31, 0x01, 0x02), rand(32), bytes(0, 1), bytes(0), rand(256), iv, body)),
  ).toThrow("unsupported signature length");
  expect(() => parseD1(seal(bytes(0x44, 0x31, 0x01, 0x02), rand(28)))).toThrow("truncated fingerprint");
});

test("valid signed entry and attachment verify before decrypting", async () => {
  const material = await generateRsaMaterial();
  const entryText = "rest-synthetic-entry-plaintext-日记";
  const entryBlob = await hybridBlob(material, 2, new Uint8Array(gzipSync(te.encode(entryText))));
  const prefixed = cat(te.encode('{"revision":{"entryId":"SYNTHETIC"}}\n'), entryBlob);
  const entry = await decryptEntryContent(material.verified, parseD1(entryD1Body(prefixed)), false);
  expect(entry.signature).toBe("verified");
  expect(td.decode(entry.plain)).toBe(entryText);

  const mediaText = "synthetic attachment bytes";
  const attachment = await decryptAttachment(
    material.verified,
    parseD1(await hybridBlob(material, 1, te.encode(mediaText))),
    false,
  );
  expect(attachment.signature).toBe("verified");
  expect(td.decode(attachment.plain)).toBe(mediaText);
});

test("signature and fingerprint tampering fail closed even with a recomputed MD5", async () => {
  const material = await generateRsaMaterial();
  const valid = await hybridBlob(material, 2, new Uint8Array(gzipSync(te.encode("signed"))));

  const tamperedSignaturePayload = valid.slice(0, -16);
  tamperedSignaturePayload[40] = tamperedSignaturePayload[40]! ^ 1;
  await expect(
    decryptEntryContent(
      material.verified,
      parseD1(cat(tamperedSignaturePayload, md5(tamperedSignaturePayload))),
      false,
    ),
  ).rejects.toThrow("signature verification failed");

  const tamperedFingerprintPayload = valid.slice(0, -16);
  tamperedFingerprintPayload[4] = tamperedFingerprintPayload[4]! ^ 1;
  await expect(
    decryptEntryContent(
      material.verified,
      parseD1(cat(tamperedFingerprintPayload, md5(tamperedFingerprintPayload))),
      false,
    ),
  ).rejects.toThrow("fingerprint mismatch");
});

test("unsigned D1 is explicit: compatible accepts, strict rejects", async () => {
  const material = await generateRsaMaterial();
  const unsigned = parseD1(
    await hybridBlob(material, 2, new Uint8Array(gzipSync(te.encode("server-created"))), false),
  );
  const compatible = await decryptEntryContent(material.verified, unsigned, false);
  expect(compatible.signature).toBe("unsigned");
  expect(td.decode(compatible.plain)).toBe("server-created");
  await expect(decryptEntryContent(material.verified, unsigned, true)).rejects.toThrow(
    "unsigned D1 envelope rejected by strict policy",
  );
});

test("decryptJournalPrivateKey format 0 recovers a usable RSA key", async () => {
  const material = await generateRsaMaterial();
  const vaultKey = rand(32);
  const iv = rand(12);
  const blob = seal(
    bytes(0x44, 0x31, 0x01, 0x00),
    iv,
    await gcmEncrypt(vaultKey, iv, te.encode(toPem(material.pkcs8, "PRIVATE KEY"))),
  );
  const recovered = await decryptJournalPrivateKey(vaultKey, blob);
  const secret = rand(32);
  const wrapped = await subtle.encrypt({ name: "RSA-OAEP" }, material.pair.publicKey, secret);
  const output = new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, recovered, wrapped));
  expect([...output]).toEqual([...secret]);
});

test("parseMasterKey and user-private-key chain round-trip", async () => {
  const { userId, passwordBytes } = parseMasterKey("D1-user123456-ABCDE-FGHJK");
  expect(userId).toBe("user123456");
  expect(td.decode(passwordBytes)).toBe("ABCDEFGHJK");
  expect(() => parseMasterKey("not-a-key")).toThrow();

  const material = await generateRsaMaterial();
  const masterKey = "D1-user123456-ABCDE-FGHJK-LMNPQ-RTUVW-XYZ23-46789";
  const { keyRaw } = await deriveMasterAesKey(masterKey);
  const iv = rand(12);
  const blob = seal(
    bytes(0x44, 0x31, 0x01, 0x00),
    iv,
    await gcmEncrypt(keyRaw, iv, te.encode(toPem(material.pkcs8, "PRIVATE KEY"))),
  );
  const recovered = await decryptUserPrivateKey(masterKey, blob);
  const secret = rand(32);
  const wrapped = await subtle.encrypt({ name: "RSA-OAEP" }, material.pair.publicKey, secret);
  expect([...new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, recovered, wrapped))]).toEqual([
    ...secret,
  ]);
});

test("binary format 2 requires exactly one bounded gzip layer", () => {
  expect(() => gunzipD1Format2(te.encode("not gzipped"))).toThrow(
    "D1 binary format 2 plaintext was not gzip",
  );
  expect(td.decode(gunzipD1Format2(new Uint8Array(gzipSync(te.encode("hello")))))).toBe("hello");
  const oversized = new Uint8Array(MAX_ENTRY_PLAINTEXT_BYTES + 1);
  expect(() => gunzipD1Format2(new Uint8Array(gzipSync(oversized)))).toThrow("size limit");
});

test("nested gzip compatibility is bounded at every layer", () => {
  const bomb = new Uint8Array(gzipSync(new Uint8Array(4096)));
  expect(() => maybeGunzip(bomb, 64)).toThrow("size limit");

  let nested = te.encode("synthetic");
  for (let index = 0; index <= MAX_D1_GZIP_LAYERS; index++) {
    nested = new Uint8Array(gzipSync(nested));
  }
  expect(() => maybeGunzip(nested, 4096)).toThrow("gzip nesting limit");
});
