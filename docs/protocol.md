# Protocol — Day One E2EE crypto framing & REST map

> Design reference for the **REST ingester** (`src/ingest/rest/`). For how it
> fits the whole system, see [architecture.md](architecture.md).

This is the framing behind the REST ingester: a pure client that fetches
ciphertext over Day One's sync API and decrypts it in our own code (no browser).
It combines byte-safe protocol observation with Day One's published 2026
[technical details](https://dayoneapp.com/wp-content/uploads/2026/03/encryption-and-day-one-sync_-technical-details-1.pdf).
Decryption correctness is independently checked against the **JSON-export**
mirror (the conformance oracle, see [architecture.md](architecture.md)).

## Key hierarchy (observed)

```
passphrase (fixed, user-supplied)
  └─ PBKDF2(salt=account ID, iterations=100000, hash=SHA-256)  → AES-256-GCM key  K_pass
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
- **KDF**: PBKDF2, salt = UTF-8 account ID, **100000** iterations, **SHA-256**,
  derives a 256-bit AES-GCM key.
- **RSA**: RSA-OAEP, MGF/OAEP hash **SHA-1**, 2048-bit (256B ciphertext), private
  key imported as **PKCS8**. D1 locked-key signatures use
  **RSASSA-PKCS1-v1_5/SHA-256** (`SHA256withRSA`).
- **AEAD**: AES-256-GCM, **12-byte IV**. No `additionalData` was passed on the
  observed calls (AAD appears unused — must confirm). GCM tag is the trailing 16B.

## Key-material stores (IndexedDB `DODexie`, shapes only)

- `content_keys`: `publicKey` (str), `signature` (str), `fingerprint` (64 hex),
  **`encryptedPrivateKey`** (str ~3064) — the passphrase-wrapped RSA private key.
- `user_keys`: **`private_key`** (bytes ~1217 = the unlocked PKCS8 RSA key),
  `public_key` (bytes ~294), `public_key_fingerprint` (64), `user_id`, `local_id`.
- `vaults`: `journal_id`, **`vault_json`** (str ~4506) — per-journal vault holding
  the RSA-wrapped content key(s).

Note: IndexedDB caches these post-unlock; the pure REST client fetches the
equivalents over the sync API (below) and runs the same chain.

## Auth (API access)

Every `/api/` request carries **`authorization: <32-char token>`** (no `Bearer`
prefix — a raw 32-char session token), plus `x-user-agent` and `device-info`
headers. A cookie-only `fetch()` gets **403** — the token header is required even
for reads. So a pure-REST client needs that 32-char token; producing it is the
login flow (below, unknown #1). Its shape is now known, which makes it scriptable.

## REST map (host `dayone.me`)

Data path:
- `GET /api/v6/sync/journals` — journal list (+ vault/key material).
- `GET /api/v6/sync/journals/stats` — per-journal counts (the browser ingester's completeness oracle).
- **`GET /api/v2/sync/entries/{journalId}/feed`** — the entry feed (ciphertext).
- `GET /api/v4/sync/changes/{device,namedRegion,template}` — incremental sync.
- `GET /api/journals/{journalId}/attachments/{attachmentId}/download` — 204 →
  redirects to the encrypted blob on S3 (`chocolate-prod.s3.amazonaws.com/...`,
  `application/octet-stream`); decrypt client-side with the content key.
- Account/config: `/api/v3/users`, `/api/user-settings`, `/api/v2/feature-flags`.

## Status — the REST path works end-to-end

**Pure sync API + env + our own crypto: decrypts real entries, no browser.**
Validated against a known-plaintext entry: fetched its ciphertext via `api.ts`
and recovered the exact text with `d1.ts` + `crypto.ts`, entirely in Bun.

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
"D1"(44 31)   0..2
ver 0x01      2..3
binaryFormat  3..4
[format 1/2]  fingerprint 32B ‖ sigLen(uint16 BE) 2B ‖ signature(sigLen) ‖ lockedKey(RSA-wrapped) 256B
iv            12B
cipherText    (len - 16 - ivEnd) ... up to len-32
gcmTag        len-32 .. len-16
md5           len-16 .. len    ← MD5(bytes[0..len-16]); STRIP before AES-GCM
```

- **binary format `00`** — AES-256-GCM with an already-known raw 32-byte key;
  used for journal names and encrypted private keys.
- **binary format `01`** — RSA-hybrid binary content (attachments): fingerprint,
  optional locked-key signature, and a 256-byte RSA-wrapped content key.
- **binary format `02`** — RSA-hybrid gzipped JSON content (entries), with the
  same locked-key fields as format 1.

The parser accepts only crypto schema `0x01` and binary formats 0–2, validates
every offset before slicing, requires the complete GCM tag, and verifies
`md5(bytes[0..len-16])` before crypto. For formats 1/2 it retains the signature
and the exact `lockedKey` bytes. Journal fingerprints are SHA-256 over the full
DER public-key encoding. A present signature must verify as SHA256withRSA over
`lockedKey` before RSA-OAEP unwrap. Format 2 requires exactly one gzip layer and
the decompressed entry plaintext is capped.

Signature length may be zero. Day One documents this for content produced with
only the public journal key. Default compatible mode accepts and counts it;
`DAYONE_REQUIRE_D1_SIGNATURES=1` rejects it to prevent signature stripping. Even
strict D1 verification does not yet validate the vault's complete user-key
`SignedUpdate` chain, so it must not be described as a complete server trust root.

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

## Auth / token minting (RESOLVED — fully headless)

`POST /api/v3/users/login` with `{email, password}` → `{ token (32-char),
created_at, user{…} }`. No OAuth, no 2FA on the password path (the webauthn/QR
endpoints seen on the login page are alternative methods, unused). No
`refresh_token` and no token `expires_at` — it's a long-lived device-session token
(the response carries device management: `active_device`, `switch_allowed_interval`).
**Renewal = call login again.** `api.ts` mints/auto-renews the token from env
(`DAYONE_EMAIL`+`DAYONE_PASSWORD`) and retries once on 401 — so the whole client is
browser-free and unattended. (`GET /api/users/key` returns the passphrase-wrapped
user key `encryptedPrivateKey` for the full passphrase decrypt path.)

All requests have a bounded timeout and endpoint-specific byte cap covering
response consumption. Journals/feed records also have cardinality caps, and
concurrent responses plus decrypt copies are constrained by weighted aggregate
budgets. Encrypted attachment downloads are capped at 64 MiB.
Retryable network/HTTP failures are retried only for
idempotent GETs and only to a small configured budget
(`DAYONE_HTTP_RETRIES`, default 2). Login POST is never automatically replayed.
Malformed JSON or an incomplete entry cursor/revision shape rejects the whole
feed. Recognized non-entry framing records are ignored but still consume the
line budget. Public errors contain stable operation labels/statuses,
not response bodies, identifiers, raw URLs, query strings, or underlying
exception messages.

The feed does not expose an authenticated terminal record or expected count.
Consequently, absence is never interpreted as deletion: only
`deletionRequested` is authoritative. Omitted stored entries are preserved and
degrade the attempt, and an empty first feed cannot mark the mirror complete. A
non-empty prefix during the first-ever sync is not locally distinguishable from
a complete response; the official JSON-export comparison is the independent
completeness oracle.

## Master key → user private key (RESOLVED — the pure-passphrase path)

The "encryption key" the user types is Day One's **master key string**
`D1-<userId>-<code…>`. From it (implemented in `crypto.ts` / `d1.ts`):
- PBKDF2 **password** = the code groups joined (dashes stripped), UTF-8 — no
  decode/hash/truncate.
- PBKDF2 **salt** = `userId` (part [1]) as UTF-8 — external, not embedded.
- **100000** iterations, **SHA-256** → an AES-256-GCM key.
- That key decrypts the user's `encryptedPrivateKey` (a D1 **type-00** blob, from
  `GET /api/users/key`) → PKCS#8 PEM RSA private key.

So the whole pipeline is env-only (see `reader.ts`): master key + token/creds →
unlock user key → per journal unwrap vault key → journal key → per entry unwrap
content key → decrypt. Validated: the primitives + D1 chain by synthetic
roundtrips; the live end-to-end decrypt against a known-plaintext entry (with the
cached user key). Full validation is the conformance check — diff the REST mirror
against a JSON-export mirror (`scripts/conformance.ts`); this has been run against
a real account with zero critical diffs. See [README → Verifying decryption].

Everything else (envelope byte order, AAD=none, salt provenance) is resolved above.
