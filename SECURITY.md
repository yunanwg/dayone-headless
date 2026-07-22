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

The **mirror** (`mirror.db`) contains your decrypted entry text + metadata. The
**device profile** used by the browser ingester (dev only) contains a live session
and decrypted cache. Both are as sensitive as the journal itself.

## Rules the code follows

- **Secrets come only from the environment**, are passed transiently, and are
  **never logged, printed, or written to disk** (only the derived plaintext mirror
  is persisted, by design). `dayone doctor` reports the *presence/shape* of secrets,
  never their values.
- **Everything sensitive is gitignored**: `.env`, `mirror.db*`, `recon/`,
  `profile*/`, `exports/`, `data/`, `*.sqlite`. Secret scanning (gitleaks) runs in
  CI and pre-commit so a key can't be committed by accident.
- **Read-only.** There are no write paths to Day One.
- **Media bytes are never mirrored** — only metadata; blobs are fetched + decrypted
  on demand.

## Deploying safely

- Keep secrets in a `.env` with tight perms (or Docker/compose secrets), on the
  ingestion host only. Pin `DAYONE_DEVICE_ID` so you don't register a new device
  each run.
- The image runs **non-root** and ships **no browser**.
- **Do not expose the MCP server directly.** Bind it to loopback and front it with
  an authenticating proxy (e.g. a Cloudflare Access tunnel). Anyone who reaches it
  can read your journal.
- Harden the host like any device holding a private key: least privilege, disk
  encryption, restricted network egress.

## Legal / ToS

This automates Day One's private web client against **your own account and data**
for personal use. It is not affiliated with or endorsed by Day One / Automattic,
and the private API may change or block access at any time. Use at your own risk.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
("Report a vulnerability") rather than a public issue.
