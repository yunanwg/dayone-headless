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
   Swappable (REST ingester = production, pure HTTPS + own crypto; JSON-export
   importer = proven manual fallback + conformance oracle; browser ingester =
   experimental/unproven, see below). Swapping it must never require touching the
   serving layer.

If a change to the web/crypto side forces an edit in the serving layer, the
decoupling has leaked — stop and fix the boundary.

## Build order (see README roadmap)

1. **Phase 0 — protocol study.** Understand the web app's auth chain, entry
   endpoints, and `crypto.subtle.*` inputs to gauge how hard the pure-REST path
   is. Auth is the main unknown. **Done.**
2. **Phase 1** — serving layer against a manual JSON export. Zero risk. **Done**,
   and since expanded (structured filters, media metadata, filterable search).
3. **Phase 3** — REST ingestion. **Done and proven correct** by byte-identical
   conformance against a JSON-export oracle (`scripts/conformance.ts`), run
   against a real account with zero critical diffs.
4. **Browser ingestion** (was "Phase 2") — **experimental / unproven, deprioritized.**
   The JSON export turned out to be a stronger, simpler independent oracle than
   the browser, so the browser ingester is no longer on the critical path. It has
   open gaps (scaffold login, unmapped tags, divergent id space) and is not a
   working fallback. Do not treat it as the oracle.

## Hard rules

- **Secrets never touch git or logs.** Master key, session/refresh tokens, browser
  profiles, the mirror DB, exported JSON — all git-ignored. Never print key/iv/
  plaintext outside a local, gitignored scratch dir.
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
- **Keep account-derived specifics out of committed docs too** — real entry/media
  counts, per-journal sizes, place names. Describe shapes and mappings generically;
  use synthetic numbers in examples.

## Verifying crypto (REST ingester)

Correctness is proven by **byte-identical conformance against an independent
oracle**, not by "it looks decrypted." The oracle is Day One's own **JSON export**
(a separate serialization of the same journal): build a mirror from it, build a
mirror via REST, and byte-diff the decryption-critical fields — see
`scripts/conformance.ts` and README → *Verifying decryption*. This is the
OmniFocus codec-cross-validation discipline; keep it. (The browser ingester was
the intended oracle but is experimental/unproven; the export superseded it.)
