# Security

`dayone-headless` decrypts your **entire** Day One journal. Treat any host that
runs it as a device that can read everything. This document is the threat model
and the rules the code follows.

## What it holds

To sync + decrypt, the process needs, from a direct environment value or a
Docker-style `_FILE` companion:

- **`DAYONE_ENCRYPTION_KEY`** — your Day One encryption key (`D1-<userId>-<code…>`).
  This is the master secret: it derives the key that unwraps your private key and,
  through it, every journal's content. Losing it to an attacker = full journal
  disclosure.
- **`DAYONE_EMAIL` + `DAYONE_PASSWORD`** (or a `DAYONE_API_TOKEN`) — account auth
  used only to mint the short-lived API token.

The **mirror** (`data/mirror.db`) contains your decrypted entry text + metadata,
and cached media contains decrypted attachment bytes. Both are as sensitive as
the journal itself.

## Rules the code follows

- **Secrets come only from direct environment values or secret files**, are
  passed transiently, and are **never logged or printed** (only the derived
  plaintext mirror is persisted, by design). A direct value and its `_FILE`
  companion are mutually exclusive and fail closed. Errors identify the
  variable, never its value or file path. `dayone doctor` reports only
  *presence/shape*.
- **Everything sensitive is gitignored** — your `.env`, the decrypted mirror, and
  any exports never enter git. Secret scanning (gitleaks) runs in CI and pre-commit
  so a key can't be committed by accident.
- **Read-only.** There are no write paths to Day One.
- **Media bytes are never mirrored** — only metadata; blobs are fetched + decrypted
  on demand.
- **External failures are redacted.** Media progress reports stable error
  categories rather than upstream exception messages, which may contain signed
  URLs or local paths. Unattended progress logs also omit decrypted journal
  names and entry/media identifiers. Each upstream REST request has a finite
  timeout, and every decoded response body is streamed through a fixed byte cap;
  journal/feed/worklist and retained mapped-entry counts or bytes have separate
  hard ceilings.
- **Decrypted files are owner-only by default.** A restrictive `077` umask
  protects creation; mirror/SQLite sidecar/media files target `0600` and their
  dedicated directories target `0700`. Normal opens remove legacy group/world
  bits without broadening owner permissions. `daytwo doctor` checks the exact
  project-local `.env` when present and otherwise only diagnoses;
  `daytwo doctor --fix-permissions` explicitly repairs that file, the complete
  existing mirror, and the flat media cache. It does not infer or modify other
  dotenv paths.

## D1 integrity and the remaining authenticity boundary

Every D1 blob processed by a current-generation REST ingestion is fail-closed on
framing, supported crypto/binary versions, field lengths, its MD5 format
checksum, and AES-GCM authentication. Format-2 plaintext must be exactly one gzip
layer and decompression is bounded. Journal public keys are imported only after
their declared fingerprint matches SHA-256 over the complete DER encoding. For
binary formats 1/2, a present signature must verify as SHA256withRSA over the
exact RSA-wrapped content-key bytes before that key is unwrapped.

The verification generation and satisfied signature-policy strength are
persisted. A REST mirror created by an older generation, or a compatible corpus
opened under strict policy, is reported as degraded until every retained entry
has been refetched, verified, and imported (or explicitly tombstoned); failures
cannot advance those markers or the complete timestamp. Cached media with an
older generation or weaker policy is not served and is refetched by
`media-fetch` before it receives the current markers. Entry sync and standalone
media fetch persist their requested policy before network processing, so
compatible-only state remains hidden even if a strict upgrade attempt later
fails.
Media refetch invalidates its prior marker before network or file work begins.
The content-addressed path is published from a synced same-directory temporary
file with collision-safe create semantics; concurrent fetches may reuse it only
after exact byte comparison. A crash therefore leaves bytes hidden instead of
retaining a stale stronger marker.

Day One's published format explicitly permits `signatureLength=0`: server-side
producers such as integrations may know the journal public key without knowing
the private key. The default **compatible** policy accepts those blobs and reports
verified/unsigned counts during sync. This preserves documented content, but it
also leaves a downgrade boundary: an attacker able to rewrite the blob can strip
a signature and recompute MD5. MD5 is only a corruption checksum, not a MAC.

Set **`DAYONE_REQUIRE_D1_SIGNATURES=1`** for the strict policy. It rejects all
unsigned entry/attachment blobs, closing signature stripping at the cost of
possibly rejecting legitimate server-created content. Strict rejection degrades
an entry sync without importing that revision; media is not cached. Journal
content keys are scoped to their owning journal, and decrypted entry identity
must exactly equal the feed identity before any content or revision is written.

The verification implemented here is still not a complete independent trust
root for the Day One server. The vault response supplies both each journal public
key and its fingerprint. Recomputing the fingerprint prevents mismatched or
truncated key material, and the D1 signature proves possession of the matching
private key, but this client does not yet verify the vault's complete user-key
`SignedUpdate` chain. HTTPS trust and byte-identical comparison with an official
JSON export remain part of the authenticity story; do not describe a successful
D1 signature as proving the server itself is uncompromised.

## Network failure handling

All Day One requests use a bounded timeout and endpoint-specific response-byte
limit. Transient network errors and selected retryable HTTP statuses receive a
small, bounded retry budget only for idempotent GETs. Login POST is a single
attempt and is never blindly replayed after an ambiguous timeout. An entry feed
is rejected as a whole when JSON is malformed or an entry record is missing
required cursor/revision fields; recognized non-entry framing records are
ignored but still consume the line budget. Absence never drives deletion: only an explicit
`deletionRequested` revision may remove a stored entry, while omitted stored rows
degrade the attempt and remain preserved. An empty feed or empty journal set
cannot mark a first snapshot complete. The protocol has no authenticated
terminal/count invariant,
so a non-empty first-sync prefix cannot be detected locally and official-export
conformance remains necessary.

Journals and feed records also have explicit cardinality limits. Concurrent
responses share a weighted byte budget, entry/attachment decrypts reserve for
ciphertext and plaintext copies, and mapped entries are flushed in bounded
batches. Encrypted attachments are capped at 64 MiB.

REST status `complete` therefore means API-reported/transport-observed
completeness under the checks above, not cryptographic corpus completeness. The
official JSON-export oracle is required for the latter claim.
Errors and progress messages use stable generic labels: response bodies, request
identifiers, journal names, raw URLs, credentials, query strings, local paths,
and underlying exception messages are not reflected.

## Deploying safely

- Keep secrets in an owner-only `.env` for local use or file-mounted
  Docker/Compose secrets on the ingestion host. Pin `DAYONE_DEVICE_ID` so you
  do not register a new device each run.
- **Give MCP no Day One upstream credentials.** It only reads the mirror; the
  encryption key and Day One API token/password stay with `sync`. An optional
  MCP transport credential is a separate secret with a separate purpose.
- The image ships **no browser**. A minimal root entrypoint accepts only fixed,
  non-symlink `/run/secrets/<known-name>` mounts, stages them, and executes the
  application as non-root `bun` with no capabilities and
  `no-new-privileges`. Compose limits PIDs and uses read-only container root
  filesystems.
- The sync and MCP processes that share a mirror must run as the same service
  UID (the Compose image uses the non-root `bun` user). For bind mounts, make
  that UID the owner rather than relaxing the mirror to group/world-readable.
  Filesystems that reject `chmod` remain usable when already accessible, but
  `doctor` reports the unresolved permission problem.
- **Do not expose the MCP server directly.** It binds to loopback (`127.0.0.1`) by
  default; front it with an authenticating proxy (e.g. a Cloudflare Access
  tunnel). Anyone who reaches it can read your journal. The origin accepts only
  `POST /mcp`, requires an exact Host allowlist, rejects unlisted browser
  Origins, bounds body size and concurrency, and disables response caching.
- Choose one explicit HTTP auth mode: `none` only when the application itself
  binds literal loopback; `static` for a high-entropy shared bearer; or
  `cloudflare-access` to verify the Access JWT assertion. Static mode is not
  OAuth. Cloudflare mode verifies issuer, audience, signature, and expiry rather
  than trusting a header. Host allowlisting is routing validation, not
  authentication; startup rejects `none` on wildcard or non-loopback binds.
- The shared data volume is writable for SQLite WAL/SHM compatibility. The MCP
  process instead opens SQLite with the read-only flag and `query_only`. A
  compromised MCP process could still bypass application policy and access the
  writable volume; container hardening reduces but does not eliminate that
  residual risk. Stronger filesystem isolation requires a separately published,
  checkpointed serving snapshot rather than sharing the writer's live WAL
  volume.
- Harden the host like any device holding a private key: least privilege, disk
  encryption, restricted network egress.

## Legal

This reads Day One's private web client against **your own account and data**
for personal use. It is not affiliated with or endorsed by Day One / Automattic,
and the private API may change or block access at any time. Use at your own risk.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
("Report a vulnerability") rather than a public issue.
