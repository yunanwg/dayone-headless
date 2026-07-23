# Security

`dayone-headless` decrypts your **entire** Day One journal. Treat any host that
runs it as a device that can read everything. This document is the threat model
and the rules the code follows.

## What it holds

To sync + decrypt, the process needs, from the environment:

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

- **Secrets come only from the environment**, are passed transiently, and are
  **never logged, printed, or written to disk** (only the derived plaintext mirror
  is persisted, by design). `dayone doctor` reports the *presence/shape* of secrets,
  never their values.
- **Everything sensitive is gitignored** — your `.env`, the decrypted mirror, and
  any exports never enter git. Secret scanning (gitleaks) runs in CI and pre-commit
  so a key can't be committed by accident.
- **Read-only.** There are no write paths to Day One.
- **Media bytes are never mirrored** — only metadata; blobs are fetched + decrypted
  on demand.
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

- Keep secrets in a `.env` with tight perms (or Docker/compose secrets), on the
  ingestion host only. Pin `DAYONE_DEVICE_ID` so you don't register a new device
  each run.
- **Give the read-only MCP server no secrets.** It only reads the mirror, so the
  compose `mcp` service has no `env_file` — the encryption key and password stay
  with `sync`, the only process that needs them.
- The image runs **non-root** and ships **no browser**.
- The sync and MCP processes that share a mirror must run as the same service
  UID (the Compose image uses the non-root `bun` user). For bind mounts, make
  that UID the owner rather than relaxing the mirror to group/world-readable.
  Filesystems that reject `chmod` remain usable when already accessible, but
  `doctor` reports the unresolved permission problem.
- **Do not expose the MCP server directly.** It binds to loopback (`127.0.0.1`) by
  default; front it with an authenticating proxy (e.g. a Cloudflare Access tunnel).
  Anyone who reaches it can read your journal. Behind that proxy, two optional
  in-process controls add defense-in-depth on the HTTP transport:
  - **`DAYONE_MCP_TOKEN`** — require `Authorization: Bearer <token>` on every
    request (constant-time compared; 401 otherwise). Unset = disabled.
  - **`DAYONE_MCP_ALLOWED_ORIGINS`** — comma-separated `Origin` allowlist
    (DNS-rebinding protection); a non-allowlisted browser `Origin` gets 403. The
    default (empty) rejects all browser origins; non-browser clients send none.
- Harden the host like any device holding a private key: least privilege, disk
  encryption, restricted network egress.

## Legal

This reads Day One's private web client against **your own account and data**
for personal use. It is not affiliated with or endorsed by Day One / Automattic,
and the private API may change or block access at any time. Use at your own risk.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
("Report a vulnerability") rather than a public issue.
