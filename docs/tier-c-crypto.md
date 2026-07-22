# Tier C — crypto framing & REST map (recon)

North-star: a pure client that fetches ciphertext over REST and decrypts it in
our own code (no browser). This is the framing captured by hooking
`crypto.subtle.*` in the live web app and mapping its network — **algorithm
shapes and endpoints only; no key/plaintext/token values were recorded** (full
byte-safe logs in gitignored `recon/`). Every claim here must be re-proven
byte-identical against the Tier A mirror oracle before it is trusted.

## Key hierarchy (observed)

```
passphrase (fixed, user-supplied)
  └─ PBKDF2(salt=22B, iterations=10000, hash=SHA-256)  → AES-256-GCM key  K_pass
       └─ AES-256-GCM(IV=12B) decrypt  content_keys.encryptedPrivateKey
            → USER RSA private key  (PKCS8, ~1217B, RSA-OAEP, MGF hash=SHA-1)
                 └─ per journal, from vault_json.vault:
                      grants[].encrypted_vault_key  (b64 344 ≈ RSA-2048 ct)
                        └─ RSA-OAEP decrypt (user priv key)      → VAULT key (AES)
                             └─ AES decrypt keys[].encrypted_private_key (b64 2336)
                                  → JOURNAL content private key
                                       └─ AES-256-GCM(IV=12B) decrypt entry bodies & attachment blobs
```

The `vaults` store / `/journals` response carry `vault_json.vault = { keys[], grants[] }`:
`grants[]` hold the vault key RSA-wrapped to each user's public key; `keys[]` hold
the journal content keypair with its private key wrapped by the vault key. This
matches the observed op counts (RSA-OAEP ×10 for grants/keys, AES-GCM ×25).

Observed `crypto.subtle` calls on one forced decrypt (Media view): `deriveKey`
PBKDF2 ×1, `decrypt` AES-GCM ×25, `importKey` pkcs8 (RSA-OAEP/SHA-1) ×2,
`decrypt` RSA-OAEP ×10, `importKey` raw (PBKDF2) ×11, `digest` SHA-512 ×1.

### Primitive parameters
- **KDF**: PBKDF2, salt **22 bytes**, **10000** iterations, **SHA-256**, derives a
  256-bit AES-GCM key.
- **RSA**: RSA-OAEP, MGF/OAEP hash **SHA-1**, 2048-bit (256B ciphertext), private
  key imported as **PKCS8**.
- **AEAD**: AES-256-GCM, **12-byte IV**. No `additionalData` was passed on the
  observed calls (AAD appears unused — must confirm). GCM tag is the trailing 16B.

## Key-material stores (IndexedDB `DODexie`, shapes only)

- `content_keys`: `publicKey` (str), `signature` (str), `fingerprint` (64 hex),
  **`encryptedPrivateKey`** (str ~3064) — the passphrase-wrapped RSA private key.
- `user_keys`: **`private_key`** (bytes ~1217 = the unlocked PKCS8 RSA key),
  `public_key` (bytes ~294), `public_key_fingerprint` (64), `user_id`, `local_id`.
- `vaults`: `journal_id`, **`vault_json`** (str ~4506) — per-journal vault holding
  the RSA-wrapped content key(s).

Note: IndexedDB caches these post-unlock; a pure Tier C client fetches the
equivalents over REST (below) and runs the same chain.

## Auth (API access)

Every `/api/` request carries **`authorization: <32-char token>`** (no `Bearer`
prefix — a raw 32-char session token), plus `x-user-agent` and `device-info`
headers. A cookie-only `fetch()` gets **403** — the token header is required even
for reads. So a pure-REST client needs that 32-char token; producing it is the
login flow (below, unknown #1). Its shape is now known, which makes it scriptable.

## REST map (host `dayone.me`)

Data path:
- `GET /api/v6/sync/journals` — journal list (+ vault/key material).
- `GET /api/v6/sync/journals/stats` — per-journal counts (Tier A's completeness oracle).
- **`GET /api/v2/sync/entries/{journalId}/feed`** — the entry feed (ciphertext).
- `GET /api/v4/sync/changes/{device,namedRegion,template}` — incremental sync.
- `GET /api/journals/{journalId}/attachments/{attachmentId}/download` — 204 →
  redirects to the encrypted blob on S3 (`chocolate-prod.s3.amazonaws.com/...`,
  `application/octet-stream`); decrypt client-side with the content key.
- Account/config: `/api/v3/users`, `/api/user-settings`, `/api/v2/feature-flags`.

## STATUS (2026-07-22)

**REST + env: WORKING.** `src/ingest/tier-c/api.ts` is a pure-`fetch` (no browser)
client driven by env (`DAYONE_API_TOKEN`, `DAYONE_X_USER_AGENT`, `DAYONE_DEVICE_INFO`).
Verified from Node: `getJournals()`, `getEntriesFeed(jid)` (NDJSON revisions; each
`revision.entryId` is the 32-hex export uuid + `contentLength`), and
`getEntryContent(jid, entryId)` → the encrypted blob. This is the browser-free
data path.

**Content decryption: BLOCKED on the inner envelope layout.** Confirmed the
`crypto.ts` primitives and the outer unwrap (user RSA → vault key, oracle-validated).
But the innermost content decrypt is not yet cracked (see below).

## D1 envelope format

Every encrypted blob is `"D1"` (`44 31`) ‖ `ver`(`01`) ‖ `type`(1 byte) ‖ payload:
- **type `01`** — PBKDF2/passphrase-wrapped (the user key, `content_keys.encryptedPrivateKey`). Salt lives in the payload.
- **type `00`** — symmetric AES-GCM-wrapped (the journal content private key, `vault.keys[].encrypted_private_key`).
- **type `02`** — RSA-hybrid (per-entry content). Payload appears to be `wrappedKey ‖ iv ‖ ct ‖ tag`.

An entry content blob = `<JSON revision header>` ‖ `\n` ‖ `<D1 type-02 ciphertext>`
(`contentLength` = the D1 part).

## THE BLOCKER (content decryption)

The oracle-validated **vault key does NOT decrypt** `vault.keys[].encrypted_private_key`
(type 00) at any iv offset (scanned), nor the entry (type 02) directly. Tried for
the entry: vault-key-direct, user-RSA-unwrap of the leading 256B, offset scans —
all fail GCM tag validation. So the journal private key is wrapped by a key that
is *not* the raw vault key (a derived KEK? a different vault member?), and without
the journal private key the per-entry content key (type 02) can't be unwrapped.

Cracking this needs a **correlated byte capture**: hook `crypto.subtle.decrypt` and
record the exact (iv, ciphertext) while the app decrypts a KNOWN entry, then line
those bytes up against its D1 blob (iv is public, ciphertext is encrypted — safe).

Attempted trigger (2026-07-22): hook + **clear the DODexie `entries`/`moments`
stores + reload**. It did NOT force a re-decrypt — only 3 init-time local decrypts
fired (86→70, 65→49 byte secrets); no entry content decrypt. Reason: `sync_states`
still holds the cursor, so the app considers the journal synced and does not
re-fetch/re-decrypt. Forcing it would require also clearing the sync cursor, which
risks disturbing account sync state — not attempted.

**Current stopping point.** Remaining options (need care / user go-ahead): clear
`sync_states` too and re-capture; or reverse the minified decryption module in the
bundle to read the exact key-derivation for D1 type-00/02.

## Open unknowns (before Tier C content decryption works)

1. **Login → the 32-char `authorization` token.** The token SHAPE is known; how the
   email/password login mints it is not (the session was reused from the profile).
   Needs a login recon (email/password only — no Apple/Google). The last
   anti-automation question.
2. **Entry-feed ciphertext envelope** — `/api/v2/sync/entries/{id}/feed` is an
   INCREMENTAL sync; on an already-synced profile it returns nothing (304/empty),
   so the per-entry framing (ciphertext ‖ IV ‖ tag ‖ content-key ref) was not yet
   captured. Capture via a from-zero cursor, a sync reset, or a fresh-profile first
   sync. (Alternatively validate the AES-GCM path first on an **attachment** blob
   from S3, which is fetched fresh each view.)
3. **PBKDF2 salt provenance** — 22B salt; where stored/derived (near
   `encryptedPrivateKey`? per-user?).
4. **AES-GCM AAD** — absent on observed calls; confirm across entry vs attachment.
5. **Envelope byte order** — IV‖ciphertext‖tag concatenation in stored blobs.

Resolved by recon: the vault/grant key hierarchy (above) and the API auth header.

## Build plan

Reimplement the chain with Node/bun WebCrypto (same primitives, our keys), then
prove **byte-identical** decryption against the Tier A mirror: same entries via
Tier C and via Tier A → assert equal. Tier A stays the golden oracle; a red
conformance test tells us exactly what diverged.
