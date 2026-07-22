# CLAUDE.md — working in dayone-headless

Read `README.md` first — it holds the vision, architecture, and roadmap. This
file is the working guide for a coding session.

## What this project is

A headless, Mac-free, **read-only** Day One client shipped as a **CLI + MCP
server**, portable across Linux/macOS, designed to run in a homelab container and
be reached remotely. It exists because Day One's only Mac-free read surface is the
web app (client-side E2EE decryption in JS), and we want that as a clean MCP.

## The one architectural rule

**Decouple ingestion from serving.** Three parts, never welded together:

1. **Serving layer** (`src/serve/…`, CLI + MCP) — pure TS + SQLite. Reads a local
   mirror. Knows nothing about Day One, the web, or crypto. Portable and testable
   in isolation.
2. **Mirror** — SQLite shaped like Day One's official JSON export schema (stable
   contract). Also the portable backup.
3. **Ingestion engine** (`src/ingest/…`) — gets + decrypts data into the mirror.
   Swappable (Tier A headless web app → Tier C pure client). Swapping it must
   never require touching the serving layer.

If a change to the web/crypto side forces an edit in the serving layer, the
decoupling has leaked — stop and fix the boundary.

## Build order (see README roadmap)

1. **Phase 0 recon** — DevTools/CDP against the live web app: auth chain, entry
   endpoints, `crypto.subtle.*` call inputs. Decides how hard Tier C is. **The
   real unknown is auth anti-automation — probe it first.**
2. **Phase 1** — serving layer against a manual JSON export. Zero risk.
3. **Phase 2** — Tier A ingestion.
4. **Phase 3** — Tier C, built under A as oracle + golden conformance tests.

Prefer Phase 1 as the first code: it's decoupled, portable, and needs nothing
from Day One but one hand-exported JSON file.

## Hard rules

- **Secrets never touch git or logs.** Master key, session/refresh tokens, browser
  profiles, the mirror DB, exported JSON — all git-ignored. Never print key/iv/
  plaintext outside a local, gitignored recon scratch dir.
- **Read-only.** No write paths until read is done and explicitly re-scoped.
- **No Mac / Day One desktop dependency**, ever. That's the whole point.
- Toolchain: **pnpm** / **bun**, never npm/yarn. English for code, comments,
  commits, PRs.
- Commits may keep the `Co-Authored-By: Claude` trailer. PRs/issues: no AI
  signature (per the author's global convention).

## Test data & open-source hygiene

The mirror DB and real exports are gitignored, but **test code and fixtures are
committed** — so they are a leak surface too. Two rules:

- **Never hardcode real journal tokens** (names, places, real entry text, device
  display names like `<Name>'s iPhone`) in tests, fixtures, comments, or commit
  messages. Use synthetic placeholders only. Committed fixtures must be produced
  by `scripts/redact-export.ts` from a gitignored real export; the redactor is
  Unicode-aware (redacts CJK/accented text, not just ASCII) and default-denies
  unmodeled string leaves. The real export never enters git.
- **Before any public open-sourcing, start git history fresh.** Even redacted or
  synthetic-looking data — and schema/field shapes derived from real entries —
  accumulate across dev-stage commits. Treat the current history as
  **private-only**: squash to a single clean initial commit (or re-init the repo)
  and audit the tree for stray tokens before pushing anywhere public. Do not rely
  on "it was redacted at the time."

## Verifying crypto (Tier C)

Correctness is proven by **byte-identical conformance against the web app oracle**,
not by "it looks decrypted." Same entries via our client and via the web app →
assert equal. This is the OmniFocus codec-cross-validation discipline; keep it.
