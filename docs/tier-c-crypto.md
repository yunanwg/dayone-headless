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

## Open unknowns (before Tier C can be built)

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
