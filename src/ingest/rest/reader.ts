/**
 * Tier C reader — the full env-only pipeline, no browser:
 *
 *   master key + (token | email+password)  →  REST fetch ciphertext  →  decrypt
 *
 * Ties api.ts + crypto.ts + d1.ts together. Given the master encryption key
 * (`D1-<userId>-<code…>`) and API auth, it unlocks the user key, each journal's
 * content key, and streams decrypted entries. Secrets come only from the caller.
 */

import { DayOneApi } from "./api.ts";
import { rsaUnwrap } from "./crypto.ts";
import { decryptUserPrivateKey, decryptD1PrivateKey, decryptEntryContent, parseD1, entryD1Body } from "./d1.ts";

const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface DecryptedEntry {
  journalId: string;
  entryId: string; // 32-hex, the export uuid
  /** Decrypted content (the entry's stored representation; usually rich-text JSON). */
  content: string;
}

export interface JournalKeys {
  userPriv: CryptoKey;
  /** journal-key fingerprint (hex) → that journal's content RSA private key. */
  journalPrivByFingerprint: Map<string, CryptoKey>;
  journals: any[];
}

export class TierCReader {
  constructor(private readonly api: DayOneApi, private readonly masterKey: string) {}

  /** Unlock the user key and every journal's content private key. */
  async unlockKeys(): Promise<JournalKeys> {
    const userKey = await this.api.getUserKey();
    const userPriv = await decryptUserPrivateKey(this.masterKey, fromB64(userKey.encryptedPrivateKey));

    const journals = await this.api.getJournals();
    const journalPrivByFingerprint = new Map<string, CryptoKey>();
    for (const j of journals) {
      const vault = j?.encryption?.vault;
      if (!vault?.grants?.length || !vault?.keys?.length) continue; // skip empty/foreign vaults
      // The vault key is RSA-wrapped to our public key in a grant (owner: any grant).
      const vaultKey = await rsaUnwrap(userPriv, fromB64(vault.grants[0].encrypted_vault_key) as BufferSource);
      for (const k of vault.keys) {
        const jp = await decryptD1PrivateKey(vaultKey, fromB64(k.encrypted_private_key));
        if (k.fingerprint) journalPrivByFingerprint.set(String(k.fingerprint).toLowerCase(), jp);
      }
    }
    return { userPriv, journalPrivByFingerprint, journals };
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
      const plain = await decryptEntryContent(jp, blob);
      yield { journalId, entryId: f.revision.entryId, content: new TextDecoder().decode(plain) };
    }
  }
}
