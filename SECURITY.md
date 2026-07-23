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

## Server authenticity (integrity vs. authenticity)

Content **integrity** is enforced: every entry/attachment is AES-GCM sealed under a
content key wrapped to your key, so tampered ciphertext fails to decrypt. What is
**not** yet enforced is server **authenticity**. The D1 envelope carries a signature
(`type ≠ 0`), but the current code parses and skips it (`src/ingest/rest/d1.ts`) —
it does not verify it. So a compromised or impersonated Day One server could serve
**forged content** that still decrypts cleanly under the wrapped content key; we
would not detect the forgery from the signature. The practical mitigations today
are transport trust (HTTPS to Day One) and the byte-identical JSON-export
conformance oracle. Verifying the envelope signature is a known gap.

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
