/**
 * REST reader — fetch ciphertext, establish the available key material, verify
 * D1 envelopes, and decrypt. The serving layer never depends on this module.
 */

import { ConfigError, DecryptError } from "../../errors.ts";
import type { VerificationPolicy } from "../../verification.ts";
import { ByteBudget, type DayOneApi, ENDPOINT_BODY_LIMITS } from "./api.ts";
import { keyFingerprint, rsaUnwrap } from "./crypto.ts";
import {
  type D1Envelope,
  type D1SignatureDisposition,
  decryptAttachment,
  decryptD1PrivateKey,
  decryptD1Symmetric,
  decryptEntryContent,
  decryptUserPrivateKey,
  entryD1Body,
  parseD1,
  pemToDer,
  type VerifiedJournalKey,
} from "./d1.ts";

const subtle = globalThis.crypto.subtle;
const td = new TextDecoder();
const D1_DECRYPT_COPY_FACTOR = 3;
const DEFAULT_DECRYPT_INFLIGHT_BYTES = 768 * 1024 * 1024;

function fromB64(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) throw new DecryptError(`missing ${field}`);
  try {
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    if (!bytes.length) throw new Error("empty");
    return bytes;
  } catch {
    throw new DecryptError(`invalid base64 in ${field}`);
  }
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function normalizedFingerprint(value: unknown, field: string): string {
  const fingerprint = typeof value === "string" ? value.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new DecryptError(`invalid ${field}`);
  return fingerprint;
}

function stringField(value: unknown, ...names: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    if (typeof record[name] === "string") return record[name] as string;
  }
  return undefined;
}

export type D1SignaturePolicy = VerificationPolicy;

export interface D1AuthenticityStatus {
  policy: D1SignaturePolicy;
  verified: number;
  unsignedAccepted: number;
}

export function d1SignaturePolicyFromEnv(
  value = process.env.DAYONE_REQUIRE_D1_SIGNATURES,
): D1SignaturePolicy {
  if (value === undefined || value === "" || value === "0" || value.toLowerCase() === "false") {
    return "compatible";
  }
  if (value === "1" || value.toLowerCase() === "true") return "strict";
  throw new ConfigError("DAYONE_REQUIRE_D1_SIGNATURES must be 0/1 or false/true");
}

export interface DecryptedEntry {
  journalId: string;
  entryId: string;
  editDate?: number;
  content: string;
}

export interface EntryRef {
  entryId: string;
  revisionId: string;
  deleted: boolean;
  editDate?: number;
}

export interface JournalKeys {
  userPriv: CryptoKey;
  /** Journal id → verified DER fingerprint → matching decrypt/verification keys. */
  journalKeyByJournalId: Map<string, Map<string, VerifiedJournalKey>>;
  /** Journal id → raw vault key for binary-format-0 values such as journal names. */
  vaultKeyByJournalId: Map<string, Uint8Array>;
  authenticity: D1AuthenticityStatus;
  journals: any[];
}

export interface RestReaderOptions {
  signaturePolicy?: D1SignaturePolicy;
}

async function verifiedPublicKey(
  publicKeyPem: string,
  declaredFingerprint: unknown,
  field: string,
): Promise<{ fingerprint: string; verifyKey: CryptoKey }> {
  const der = pemToDer(publicKeyPem, "PUBLIC KEY");
  const fingerprint = normalizedFingerprint(declaredFingerprint, `${field} fingerprint`);
  if ((await keyFingerprint(der as BufferSource)) !== fingerprint) {
    throw new DecryptError(`${field} public-key fingerprint mismatch`);
  }
  try {
    const verifyKey = await subtle.importKey(
      "spki",
      der as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return { fingerprint, verifyKey };
  } catch {
    throw new DecryptError(`invalid ${field} RSA public key`);
  }
}

export class RestReader {
  readonly signaturePolicy: D1SignaturePolicy;
  private readonly decryptBudget = new ByteBudget(DEFAULT_DECRYPT_INFLIGHT_BYTES);

  constructor(
    private readonly api: DayOneApi,
    private readonly masterKey: string,
    options: RestReaderOptions = {},
  ) {
    this.signaturePolicy = options.signaturePolicy ?? d1SignaturePolicyFromEnv();
  }

  /** Unlock the user key and import every self-consistent journal key pair. */
  async unlockKeys(): Promise<JournalKeys> {
    const userKey = await this.api.getUserKey();
    const userPublicPem = stringField(userKey, "publicKey", "public_key");
    if (!userPublicPem) throw new DecryptError("user key response had no public key");
    const userPublic = await verifiedPublicKey(userPublicPem, stringField(userKey, "fingerprint"), "user");
    const encryptedUserPrivate = stringField(userKey, "encryptedPrivateKey", "encrypted_private_key");
    const userPriv = await decryptUserPrivateKey(
      this.masterKey,
      fromB64(encryptedUserPrivate, "encrypted user private key"),
    );

    const journals = await this.api.getJournals();
    const journalKeyByJournalId = new Map<string, Map<string, VerifiedJournalKey>>();
    const vaultKeyByJournalId = new Map<string, Uint8Array>();
    for (const journal of journals) {
      const vault = journal?.encryption?.vault;
      if (!vault?.grants?.length || !vault?.keys?.length) continue;

      const grant = vault.grants.find((candidate: unknown) => {
        try {
          return (
            normalizedFingerprint(
              stringField(candidate, "fingerprint", "public_key_fingerprint"),
              "journal grant fingerprint",
            ) === userPublic.fingerprint
          );
        } catch {
          return false;
        }
      });
      if (!grant) throw new DecryptError("journal vault had no grant for the unlocked user key");
      let vaultKey: Uint8Array;
      try {
        vaultKey = await rsaUnwrap(
          userPriv,
          fromB64(
            stringField(grant, "encrypted_vault_key", "lockedKey", "locked_key"),
            "encrypted journal vault key",
          ) as BufferSource,
        );
      } catch {
        throw new DecryptError("journal vault-key unwrap failed");
      }
      if (vaultKey.length !== 32) throw new DecryptError("journal vault key was not 256 bits");
      const journalId = String(journal.id);
      if (journalKeyByJournalId.has(journalId)) throw new DecryptError("duplicate journal id");
      vaultKeyByJournalId.set(journalId, vaultKey);
      const journalKeys = new Map<string, VerifiedJournalKey>();

      for (const rawKey of vault.keys) {
        const publicPem = stringField(rawKey, "public_key", "publicKey");
        if (!publicPem) throw new DecryptError("journal key had no public key");
        const publicKey = await verifiedPublicKey(
          publicPem,
          stringField(rawKey, "fingerprint", "public_key_fingerprint"),
          "journal",
        );
        const encryptedPrivate = stringField(
          rawKey,
          "encrypted_private_key",
          "lockedPrivateKey",
          "locked_private_key",
        );
        const decryptKey = await decryptD1PrivateKey(
          vaultKey,
          fromB64(encryptedPrivate, "encrypted journal private key"),
        );
        const existing = journalKeys.get(publicKey.fingerprint);
        if (existing) throw new DecryptError("duplicate journal-key fingerprint");
        journalKeys.set(publicKey.fingerprint, {
          fingerprint: publicKey.fingerprint,
          decryptKey,
          verifyKey: publicKey.verifyKey,
        });
      }
      journalKeyByJournalId.set(journalId, journalKeys);
    }
    return {
      userPriv,
      journalKeyByJournalId,
      vaultKeyByJournalId,
      authenticity: {
        policy: this.signaturePolicy,
        verified: 0,
        unsignedAccepted: 0,
      },
      journals,
    };
  }

  private keyFor(envelope: D1Envelope, keys: JournalKeys, journalId: string): VerifiedJournalKey | undefined {
    return envelope.fingerprint
      ? keys.journalKeyByJournalId.get(journalId)?.get(hex(envelope.fingerprint))
      : undefined;
  }

  private recordSignature(keys: JournalKeys, disposition: D1SignatureDisposition): void {
    if (disposition === "verified") keys.authenticity.verified++;
    else keys.authenticity.unsignedAccepted++;
  }

  async *decryptJournal(journalId: string, keys: JournalKeys): AsyncGenerator<DecryptedEntry> {
    const feed = await this.api.getEntriesFeed(journalId);
    const latest = new Map<string, (typeof feed)[number]>();
    for (const item of feed) {
      if (item.revision.deletionRequested) continue;
      const current = latest.get(item.revision.entryId);
      if (!current || item.revision.saveDate > current.revision.saveDate) {
        latest.set(item.revision.entryId, item);
      }
    }
    for (const item of latest.values()) {
      const release = await this.decryptBudget.acquire(
        ENDPOINT_BODY_LIMITS.entryContent * D1_DECRYPT_COPY_FACTOR,
      );
      try {
        const body = entryD1Body(await this.api.getEntryContent(journalId, item.revision.entryId));
        const envelope = parseD1(body);
        const key = this.keyFor(envelope, keys, journalId);
        if (!key) continue;
        const result = await decryptEntryContent(key, envelope, this.signaturePolicy === "strict");
        this.recordSignature(keys, result.signature);
        yield {
          journalId,
          entryId: item.revision.entryId,
          editDate: item.revision.editDate,
          content: td.decode(result.plain),
        };
      } finally {
        release();
      }
    }
  }

  async listEntries(journalId: string): Promise<EntryRef[]> {
    const feed = await this.api.getEntriesFeed(journalId);
    const latest = new Map<string, (typeof feed)[number]>();
    for (const item of feed) {
      const current = latest.get(item.revision.entryId);
      if (!current || item.revision.saveDate > current.revision.saveDate) {
        latest.set(item.revision.entryId, item);
      }
    }
    return [...latest.values()].map((item) => ({
      entryId: item.revision.entryId,
      revisionId: String(item.revision.revisionId),
      deleted: !!item.revision.deletionRequested,
      editDate: item.revision.editDate,
    }));
  }

  async fetchMedia(journalId: string, identifier: string, keys: JournalKeys): Promise<Uint8Array> {
    const release = await this.decryptBudget.acquire(
      ENDPOINT_BODY_LIMITS.attachment * D1_DECRYPT_COPY_FACTOR,
    );
    try {
      const envelope = parseD1(await this.api.getAttachment(journalId, identifier));
      const key = this.keyFor(envelope, keys, journalId);
      if (!key) throw new DecryptError("no journal key for attachment");
      const result = await decryptAttachment(key, envelope, this.signaturePolicy === "strict");
      this.recordSignature(keys, result.signature);
      return result.plain;
    } finally {
      release();
    }
  }

  async decryptEntry(journalId: string, entryId: string, keys: JournalKeys): Promise<string | null> {
    const release = await this.decryptBudget.acquire(
      ENDPOINT_BODY_LIMITS.entryContent * D1_DECRYPT_COPY_FACTOR,
    );
    try {
      const body = entryD1Body(await this.api.getEntryContent(journalId, entryId));
      const envelope = parseD1(body);
      const key = this.keyFor(envelope, keys, journalId);
      if (!key) return null;
      const result = await decryptEntryContent(key, envelope, this.signaturePolicy === "strict");
      this.recordSignature(keys, result.signature);
      return td.decode(result.plain);
    } finally {
      release();
    }
  }

  /**
   * Official journal-name blobs are binary format 0 under the journal vault key.
   * Invalid framing/checksums/decryption fail closed; null is reserved for absent
   * names or an unavailable vault key.
   */
  async decryptJournalName(
    nameB64: string | null | undefined,
    journalId: string,
    keys: JournalKeys,
  ): Promise<string | null> {
    if (!nameB64) return null;
    const vaultKey = keys.vaultKeyByJournalId.get(journalId);
    if (!vaultKey) return null;
    const envelope = parseD1(fromB64(nameB64, "encrypted journal name"));
    const plain = await decryptD1Symmetric(vaultKey, envelope);
    const raw = td.decode(plain).trim();
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed?.name ? String(parsed.name) : raw || null;
    } catch {
      return raw || null;
    }
  }
}
