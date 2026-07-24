/**
 * REST reader — the full env-only pipeline, no browser:
 *
 *   master key + (token | email+password)  →  REST fetch ciphertext  →  decrypt
 *
 * Ties api.ts + crypto.ts + d1.ts together. Given the master encryption key
 * (`D1-<userId>-<code…>`) and API auth, it unlocks the user key, each journal's
 * content key, and streams decrypted entries. Secrets come only from the caller.
 */

import { DecryptError } from "../../errors.ts";
import type { DayOneApi } from "./api.ts";
import { rsaUnwrap } from "./crypto.ts";
import {
  type D1Envelope,
  type D1SignatureOutcome,
  decryptAttachment,
  decryptD1PrivateKey,
  decryptD1Symmetric,
  decryptEntryContent,
  decryptUserPrivateKey,
  entryD1Body,
  importJournalVerifyKey,
  parseD1,
  verifyD1Signature,
} from "./d1.ts";

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface DecryptedEntry {
  journalId: string;
  entryId: string; // 32-hex, the export uuid
  /** Feed edit timestamp (epoch ms), for freshness / modifiedDate fallback. */
  editDate?: number;
  /** Decrypted content JSON string (the entry's full private representation). */
  content: string;
  /** Envelope signature verification outcome for this entry. */
  signature: D1SignatureOutcome;
}

/** One decrypted entry's content plus its envelope-signature verification outcome. */
export interface DecryptedEntryContent {
  content: string;
  signature: D1SignatureOutcome;
}

/** Lightweight per-entry sync metadata from the feed (no decryption). */
export interface EntryRef {
  entryId: string;
  revisionId: string;
  deleted: boolean;
  editDate?: number;
}

export interface JournalKeys {
  userPriv: CryptoKey;
  /** journal-key fingerprint (hex) → that journal's content RSA private key. */
  journalPrivByFingerprint: Map<string, CryptoKey>;
  /** journal-key fingerprint (hex) → that journal's RSA public key, for signature
   *  verification of the envelope `lockedKey`. */
  journalPubByFingerprint: Map<string, CryptoKey>;
  /** journal id → its raw vault key (decrypts type-00 blobs like the journal name). */
  vaultKeyByJournalId: Map<string, Uint8Array>;
  journals: any[];
}

export class RestReader {
  constructor(
    private readonly api: DayOneApi,
    private readonly masterKey: string,
    /** Fail-closed on entries/attachments whose signature is missing or invalid.
     *  Defaults from DAYONE_REQUIRE_SIGNATURES=1; the entry path also reads this
     *  policy in sync.ts, so both surfaces agree. */
    private readonly requireSignatures = process.env.DAYONE_REQUIRE_SIGNATURES === "1",
  ) {}

  /** Verify a parsed envelope against the journal public key selected by fingerprint. */
  private verifySignature(d: D1Envelope, keys: JournalKeys): Promise<D1SignatureOutcome> {
    const pub = d.fingerprint ? keys.journalPubByFingerprint.get(hex(d.fingerprint)) : undefined;
    return verifyD1Signature(d, pub);
  }

  /** Unlock the user key and every journal's content private key. */
  async unlockKeys(): Promise<JournalKeys> {
    const userKey = await this.api.getUserKey();
    const userPriv = await decryptUserPrivateKey(this.masterKey, fromB64(userKey.encryptedPrivateKey));

    const journals = await this.api.getJournals();
    const journalPrivByFingerprint = new Map<string, CryptoKey>();
    const journalPubByFingerprint = new Map<string, CryptoKey>();
    const vaultKeyByJournalId = new Map<string, Uint8Array>();
    for (const j of journals) {
      const vault = j?.encryption?.vault;
      if (!vault?.grants?.length || !vault?.keys?.length) continue; // skip empty/foreign vaults
      // The vault key is RSA-wrapped to our public key in a grant (owner: any grant).
      const vaultKey = await rsaUnwrap(
        userPriv,
        fromB64(vault.grants[0].encrypted_vault_key) as BufferSource,
      );
      vaultKeyByJournalId.set(String(j.id), vaultKey);
      for (const k of vault.keys) {
        if (!k.fingerprint) continue;
        const fp = String(k.fingerprint).toLowerCase();
        const jp = await decryptD1PrivateKey(vaultKey, fromB64(k.encrypted_private_key));
        journalPrivByFingerprint.set(fp, jp);
        // The matching PUBLIC key verifies the envelope signature over `lockedKey`.
        // A malformed/absent public key is non-fatal: verification then reports
        // "failed" for signed content, which policy handles.
        if (k.public_key) {
          try {
            journalPubByFingerprint.set(fp, await importJournalVerifyKey(String(k.public_key)));
          } catch {
            /* leave this fingerprint without a verify key */
          }
        }
      }
    }
    return { userPriv, journalPrivByFingerprint, journalPubByFingerprint, vaultKeyByJournalId, journals };
  }

  /** Stream the latest revision of each (non-deleted) entry in a journal, decrypted. */
  async *decryptJournal(journalId: string, keys: JournalKeys): AsyncGenerator<DecryptedEntry> {
    const feed = await this.api.getEntriesFeed(journalId);
    const latest = new Map<string, (typeof feed)[number]>();
    for (const f of feed) {
      if (f.revision.deletionRequested) continue;
      const cur = latest.get(f.revision.entryId);
      if (!cur || f.revision.saveDate > cur.revision.saveDate) latest.set(f.revision.entryId, f);
    }
    for (const f of latest.values()) {
      const blob = await this.api.getEntryContent(journalId, f.revision.entryId);
      const d = parseD1(entryD1Body(blob));
      const jp = d.fingerprint ? keys.journalPrivByFingerprint.get(hex(d.fingerprint)) : undefined;
      if (!jp) continue; // key for this entry not available
      const signature = await this.verifySignature(d, keys);
      const plain = await decryptEntryContent(jp, blob);
      yield {
        journalId,
        entryId: f.revision.entryId,
        editDate: f.revision.editDate,
        content: new TextDecoder().decode(plain),
        signature,
      };
    }
  }

  /**
   * List a journal's entries from the feed (latest revision each) — metadata only,
   * NO decryption. Cheap; used to decide what changed since the last sync.
   */
  async listEntries(journalId: string): Promise<EntryRef[]> {
    const feed = await this.api.getEntriesFeed(journalId);
    const latest = new Map<string, (typeof feed)[number]>();
    for (const f of feed) {
      const cur = latest.get(f.revision.entryId);
      if (!cur || f.revision.saveDate > cur.revision.saveDate) latest.set(f.revision.entryId, f);
    }
    return [...latest.values()].map((f) => ({
      entryId: f.revision.entryId,
      revisionId: String(f.revision.revisionId),
      deleted: !!f.revision.deletionRequested,
      editDate: f.revision.editDate,
    }));
  }

  /**
   * Fetch + decrypt one attachment's bytes (photo/video/audio/pdf) given its
   * journal id and media `identifier`. Returns the original file bytes.
   */
  async fetchMedia(journalId: string, identifier: string, keys: JournalKeys): Promise<Uint8Array> {
    const blob = await this.api.getAttachment(journalId, identifier);
    const d = parseD1(blob);
    const jp = d.fingerprint ? keys.journalPrivByFingerprint.get(hex(d.fingerprint)) : undefined;
    if (!jp) throw new Error(`no journal key for attachment ${identifier}`);
    // Attachments ride the same envelope; under fail-closed policy an unverified
    // attachment is refused (its bytes never reach the cache). No cache
    // bookkeeping — the caller already treats a throw as a redacted failure.
    if (this.requireSignatures && (await this.verifySignature(d, keys)) !== "verified") {
      throw new DecryptError("attachment signature not verified");
    }
    return decryptAttachment(jp, blob);
  }

  /**
   * Fetch + decrypt one entry's content (UTF-8 JSON string) together with its
   * envelope-signature outcome, or null if the journal key is unavailable. Policy
   * (warn-and-keep vs. skip) is applied by the caller (sync.ts), not here.
   */
  async decryptEntry(
    journalId: string,
    entryId: string,
    keys: JournalKeys,
  ): Promise<DecryptedEntryContent | null> {
    const blob = await this.api.getEntryContent(journalId, entryId);
    const d = parseD1(entryD1Body(blob));
    const jp = d.fingerprint ? keys.journalPrivByFingerprint.get(hex(d.fingerprint)) : undefined;
    if (!jp) return null;
    const signature = await this.verifySignature(d, keys);
    const content = new TextDecoder().decode(await decryptEntryContent(jp, blob));
    return { content, signature };
  }

  /**
   * Decrypt a journal's (encrypted) display name — itself a D1 blob. The name is
   * type-00 (symmetric, unlocked by the journal's vault key); type-02 (RSA-hybrid)
   * is handled too for robustness. Returns null when unavailable.
   */
  async decryptJournalName(
    nameB64: string | null | undefined,
    journalId: string,
    keys: JournalKeys,
  ): Promise<string | null> {
    if (!nameB64) return null;
    let blob: Uint8Array;
    try {
      blob = Uint8Array.from(atob(nameB64), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
    if (blob[0] !== 0x44 || blob[1] !== 0x31) return null; // not a "D1" blob
    try {
      const d = parseD1(blob); // may reject a malformed/short envelope or bad checksum
      let plain: Uint8Array;
      if (d.type === 0) {
        const vaultKey = keys.vaultKeyByJournalId.get(journalId);
        if (!vaultKey) return null;
        plain = await decryptD1Symmetric(vaultKey, blob);
      } else {
        const jp = d.fingerprint ? keys.journalPrivByFingerprint.get(hex(d.fingerprint)) : undefined;
        if (!jp) return null;
        plain = await decryptEntryContent(jp, blob);
      }
      const raw = new TextDecoder().decode(plain).trim();
      try {
        const o = JSON.parse(raw);
        return typeof o === "object" && o?.name ? String(o.name) : raw;
      } catch {
        return raw || null;
      }
    } catch {
      return null;
    }
  }
}
