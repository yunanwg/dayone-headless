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

## STATUS (2026-07-22) — TIER C WORKS END-TO-END

**Pure REST + env + own crypto: DECRYPTS REAL ENTRIES, no browser.** Validated
against a known-plaintext new entry: fetched its ciphertext via `api.ts` and
recovered the exact text with `d1.ts` + `crypto.ts`, entirely in Node.

- `api.ts` — pure `fetch` client (env: `DAYONE_API_TOKEN`/`X_USER_AGENT`/`DEVICE_INFO`):
  `getJournals()`, `getEntriesFeed(jid)`, `getEntryContent(jid, entryId)`.
- `crypto.ts` — WebCrypto primitives (RSA-OAEP/SHA-1, AES-256-GCM, PBKDF2, fingerprints).
- `d1.ts` — the D1 envelope parser + `decryptJournalPrivateKey` + `decryptEntryContent`.

**The former blocker was a trailing 16-byte MD5 checksum** after the GCM tag (found
by reading the app bundle). Stripping it before AES-GCM made the whole chain work.
There is **no key derivation** — the 32-byte vault key is used raw as the AES-GCM key.

## D1 envelope format

Full layout (offsets from the start of the blob), implemented in `d1.ts`:

```
"D1"(44 31)  0..2
ver 0x01     2..3
type         3..4
[type != 0]  fingerprint 32B ‖ sigLen(uint16 BE) 2B ‖ signature(sigLen) ‖ lockedKey(RSA-wrapped) 256B
iv           12B
cipherText   (len - 16 - ivEnd) ... up to len-32
gcmTag       len-32 .. len-16
md5          len-16 .. len    ← MD5(bytes[0..len-16]); STRIP before AES-GCM
```

- **type `01`** — PBKDF2/passphrase (user key, `content_keys.encryptedPrivateKey`; salt in payload).
- **type `00`** — AES-256-GCM with the **raw** 32-byte vault key (no KDF); plaintext = the journal RSA private key as PKCS#8 PEM.
- **type `02`** — RSA-hybrid: RSA-OAEP(SHA-1) unwrap the 256-byte `lockedKey` with the journal private key → 32-byte content key → AES-256-GCM the body. Plaintext may be gzip'd (magic `1f8b`, up to 3 passes).

WebCrypto AES-GCM wants `cipherText ‖ gcmTag` as data + `iv` separate. AAD = none.
An entry content blob = `<JSON revision header>` ‖ `\n` ‖ `<D1 type-02>` (`contentLength` = the D1 part).

## How the former blocker was solved

The oracle-validated vault key kept failing to AES-GCM-decrypt the type-00 journal
key at every iv offset. Two live-capture attempts (clear cache + reload; create a
new entry + capture) both saw only init-time local decrypts — because the content
decryption runs elsewhere and the main-thread `crypto.subtle` hook missed it.

A subagent then read the app bundle (`analytics.*.js`) directly and found it: **the
last 16 bytes of every D1 blob are an MD5 checksum, after the GCM tag** — feeding
them into AES-GCM guaranteed failure. No key derivation exists; the vault key is
used raw. With the MD5 stripped, the full chain decrypted a known-plaintext new
entry byte-for-byte. Lesson: reading the code beat black-box byte-guessing.

## Remaining open (Tier C is otherwise complete)

1. **Login → the 32-char `authorization` token.** Content decryption + REST fetch
   both work with a token in env; how the email/password login *mints* that token
   is the one un-reversed step (the session was reused from the profile). Needs a
   login recon (email/password only — no Apple/Google 2FA, per the fixed-passphrase
   path). Until then, the token is supplied via env like any other credential.
2. **PBKDF2 salt provenance** — 22B salt; where stored/derived (near
   `encryptedPrivateKey`? per-user?).
4. **AES-GCM AAD** — absent on observed calls; confirm across entry vs attachment.
5. **Envelope byte order** — IV‖ciphertext‖tag concatenation in stored blobs.

Resolved by recon: the vault/grant key hierarchy (above) and the API auth header.

## Build plan

Reimplement the chain with Node/bun WebCrypto (same primitives, our keys), then
prove **byte-identical** decryption against the Tier A mirror: same entries via
Tier C and via Tier A → assert equal. Tier A stays the golden oracle; a red
conformance test tells us exactly what diverged.
