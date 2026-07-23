import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { DayOneApi } from "../src/ingest/rest/api.ts";
import { deriveMasterAesKey, keyFingerprint } from "../src/ingest/rest/crypto.ts";
import { d1SignaturePolicyFromEnv, RestReader } from "../src/ingest/rest/reader.ts";

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();
const masterKey = "D1-syntheticuser-ABCDE-FGHJK-LMNPQ-RTUVW-XYZ23-46789";

const cat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
const md5 = (bytes: Uint8Array) => new Uint8Array(createHash("md5").update(bytes).digest());
const seal = (...parts: Uint8Array[]) => {
  const payload = cat(...parts);
  return cat(payload, md5(payload));
};
const rand = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const pem = (der: Uint8Array, label: "PUBLIC KEY" | "PRIVATE KEY") =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64")}\n-----END ${label}-----\n`;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function rsa() {
  const pair = (await subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const signer = await subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return { pair, spki, pkcs8, signer, fingerprint: await keyFingerprint(spki) };
}

async function gcm(keyRaw: Uint8Array, iv: Uint8Array, plain: Uint8Array) {
  const key = await subtle.importKey("raw", keyRaw as BufferSource, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource),
  );
}

async function symmetric(key: Uint8Array, plain: Uint8Array) {
  const iv = rand(12);
  return seal(Uint8Array.of(0x44, 0x31, 0x01, 0x00), iv, await gcm(key, iv, plain));
}

async function hybrid(key: Awaited<ReturnType<typeof rsa>>, format: 1 | 2, plain: Uint8Array) {
  const contentKey = rand(32);
  const locked = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, key.pair.publicKey, contentKey));
  const signature = new Uint8Array(await subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key.signer, locked));
  const iv = rand(12);
  return seal(
    Uint8Array.of(0x44, 0x31, 0x01, format),
    Uint8Array.from(Buffer.from(key.fingerprint, "hex")),
    Uint8Array.of(0x01, 0x00),
    signature,
    locked,
    iv,
    await gcm(contentKey, iv, plain),
  );
}

async function fixture(journalFingerprint?: string, options: { prependForeignGrant?: boolean } = {}) {
  const user = await rsa();
  const journal = await rsa();
  const vaultKey = rand(32);
  const { keyRaw: masterAes } = await deriveMasterAesKey(masterKey);
  const encryptedUserPrivate = await symmetric(masterAes, te.encode(pem(user.pkcs8, "PRIVATE KEY")));
  const encryptedJournalPrivate = await symmetric(vaultKey, te.encode(pem(journal.pkcs8, "PRIVATE KEY")));
  const encryptedVault = new Uint8Array(
    await subtle.encrypt({ name: "RSA-OAEP" }, user.pair.publicKey, vaultKey),
  );
  const entry = await hybrid(
    journal,
    2,
    new Uint8Array(gzipSync(te.encode('{"id":"SYNTHETIC","body":"verified"}'))),
  );
  const attachment = await hybrid(journal, 1, te.encode("synthetic-media"));
  const journalName = await symmetric(vaultKey, te.encode('{"name":"Synthetic Journal"}'));
  const api = {
    getUserKey: async () => ({
      publicKey: pem(user.spki, "PUBLIC KEY"),
      fingerprint: user.fingerprint,
      encryptedPrivateKey: b64(encryptedUserPrivate),
    }),
    getJournals: async () => [
      {
        id: "SYNTHETIC-JOURNAL",
        name: b64(journalName),
        encryption: {
          vault: {
            grants: [
              ...(options.prependForeignGrant
                ? [
                    {
                      fingerprint: "f".repeat(64),
                      encrypted_vault_key: b64(rand(256)),
                    },
                  ]
                : []),
              { fingerprint: user.fingerprint, encrypted_vault_key: b64(encryptedVault) },
            ],
            keys: [
              {
                fingerprint: journalFingerprint ?? journal.fingerprint,
                public_key: pem(journal.spki, "PUBLIC KEY"),
                encrypted_private_key: b64(encryptedJournalPrivate),
              },
            ],
          },
        },
      },
    ],
    getEntryContent: async () => entry,
    getAttachment: async () => attachment,
  } as unknown as DayOneApi;
  return { api };
}

test("reader validates full-DER fingerprints and uses one verified path for names, entries, and media", async () => {
  const { api } = await fixture();
  const reader = new RestReader(api, masterKey, { signaturePolicy: "strict" });
  const keys = await reader.unlockKeys();

  expect(keys.journalKeyByJournalId.get("SYNTHETIC-JOURNAL")?.size).toBe(1);
  expect(await reader.decryptJournalName(keys.journals[0].name, "SYNTHETIC-JOURNAL", keys)).toBe(
    "Synthetic Journal",
  );
  expect(await reader.decryptEntry("SYNTHETIC-JOURNAL", "SYNTHETIC-ENTRY", keys)).toBe(
    '{"id":"SYNTHETIC","body":"verified"}',
  );
  expect(td.decode(await reader.fetchMedia("SYNTHETIC-JOURNAL", "SYNTHETIC-MEDIA", keys))).toBe(
    "synthetic-media",
  );
  expect(keys.authenticity).toEqual({ policy: "strict", verified: 2, unsignedAccepted: 0 });
  expect(await reader.decryptEntry("OTHER-JOURNAL", "SYNTHETIC-ENTRY", keys)).toBeNull();
});

test("reader rejects a declared journal fingerprint that does not hash the full public-key DER", async () => {
  const { api } = await fixture("0".repeat(64));
  const reader = new RestReader(api, masterKey, { signaturePolicy: "compatible" });
  await expect(reader.unlockKeys()).rejects.toThrow("journal public-key fingerprint mismatch");
});

test("reader ignores a foreign first grant and selects the grant matching the user DER fingerprint", async () => {
  const { api } = await fixture(undefined, { prependForeignGrant: true });
  const reader = new RestReader(api, masterKey, { signaturePolicy: "strict" });
  const keys = await reader.unlockKeys();
  expect(keys.journalKeyByJournalId.get("SYNTHETIC-JOURNAL")?.size).toBe(1);
  expect(await reader.decryptEntry("SYNTHETIC-JOURNAL", "SYNTHETIC-ENTRY", keys)).toContain(
    '"body":"verified"',
  );
});

test("signature-policy parsing is explicit and rejects ambiguous values", () => {
  expect(d1SignaturePolicyFromEnv(undefined)).toBe("compatible");
  expect(d1SignaturePolicyFromEnv("0")).toBe("compatible");
  expect(d1SignaturePolicyFromEnv("false")).toBe("compatible");
  expect(d1SignaturePolicyFromEnv("1")).toBe("strict");
  expect(d1SignaturePolicyFromEnv("true")).toBe("strict");
  expect(() => d1SignaturePolicyFromEnv("sometimes")).toThrow(
    "DAYONE_REQUIRE_D1_SIGNATURES must be 0/1 or false/true",
  );
});
