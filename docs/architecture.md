# Architecture

How `dayone-headless` is put together, and the one design rule that everything
else follows. For the wire protocol and crypto, see
[protocol.md](protocol.md).

## The one rule: decouple ingestion from serving

Getting data out of Day One is fragile (a private API, E2E crypto, an upstream
that can change without notice). Serving it is not. So the two are never welded
together. There is a **stable contract** in the middle — a local decrypted
mirror — and each side only ever touches that contract.

```
[ ingester ]  --writes-->  [ decrypted mirror ]  <--reads--  [ CLI / MCP serving layer ]
 fragile, heavy,            stable contract:                  thin, fast, portable,
 runs occasionally          Day One JSON-export shape         zero Day One / crypto deps
 (REST / browser / json)    in SQLite (bun:sqlite)
```

**The test of the boundary:** if a change to the web or crypto side ever forces
an edit in the serving layer, the decoupling has leaked — stop and fix the
boundary, don't paper over it.

## Part 1 — the serving layer (`src/serve/…`)

Pure TypeScript + `bun:sqlite`. It opens the mirror read-only and answers
queries. It knows nothing about Day One, HTTP, or crypto, so it is portable and
testable in isolation.

- `queries.ts` — the single definition of every read: `listJournals`,
  `searchEntries` (FTS5), `getEntry`, `onThisDay`, `getSyncedAt`. Both the CLI
  and the MCP server call these — one source of truth.
- `cli.ts` — the `daytwo` dispatcher (`journals`, `search`, `get`,
  `on-this-day`, plus `sync`, `mcp`, `doctor`).
- `mcp.ts` — the read-only MCP server. Same queries, exposed as tools
  (`list_journals`, `search_entries`, `get_entry`, `on_this_day`). Every result
  includes `synced_at`. stdio by default; streamable-HTTP when `DAYONE_MCP_PORT`
  is set.
- `doctor.ts` — config + mirror health, reporting secret *presence/shape* only.

## Part 2 — the mirror as contract (`src/serve/db/schema.sql`, `src/types.ts`)

A local SQLite database **shaped like Day One's official JSON export** (a stable,
community-documented format). The export shape — not Day One's internal model,
and not whatever an ingester finds easiest to emit — is the contract every
ingester targets.

Design rules baked into the schema:

- **Typed columns for querying, `raw` for fidelity.** Every row keeps the
  verbatim source object in a `raw` JSON column. Queries read the typed columns;
  the mirror never loses a field it didn't model yet. This also makes the mirror
  a lossless **portable backup**.
- **Media is metadata only.** The `media` table stores identifier / md5 / kind /
  type — never the photo, video, audio, or PDF bytes. Blobs are fetched and
  decrypted on demand, so the mirror stays small and the serving layer stays
  byte-free.
- **Full-text search** via an FTS5 virtual table over entry bodies, rebuilt on
  import.
- **Per-entry sync state** (`entry_sync`) so the REST ingester can skip unchanged
  entries (see below). This is ingestion bookkeeping the serving layer ignores.
- **Freshness** lives in a `meta` table (`synced_at`, `source`); the serving
  layer surfaces it on every result.

## Part 3 — the ingesters (`src/ingest/…`)

All three produce the export shape and feed the same importer
(`json-export/import.ts` → `importExport()`), so **swapping an ingester never
touches the serving layer.**

### REST ingester (`src/ingest/rest/`) — production

Pure HTTPS + our own WebCrypto reimplementation of Day One's E2EE. **No browser.**
This is what the Docker image ships.

- `api.ts` — a plain `fetch` client for Day One's sync API. Self-mints and
  auto-renews the auth token.
- `crypto.ts` — the WebCrypto primitives (PBKDF2, RSA-OAEP, AES-256-GCM,
  fingerprints).
- `d1.ts` — the "D1" envelope parser and the key-unwrap steps.
- `reader.ts` — ties them together: master key + auth → unlock the user key →
  per-journal content keys → stream decrypted entries.
- `sync.ts` — **incremental** sync into the mirror. The entry feed is
  metadata-only and cheap; only entries whose server `revisionId` changed since
  the last sync are re-fetched and re-decrypted, and entries deleted upstream are
  removed. First sync is full; subsequent syncs are cheap deltas.
- `map.ts` — maps decrypted content to the export shape.

The full protocol and crypto framing is documented in [protocol.md](protocol.md).

### Browser ingester (`src/ingest/browser/`) — dev / oracle only

Drives the official Day One web app in headless Chromium (Playwright) and dumps
its already-decrypted IndexedDB (`DODexie`) into the mirror. Because the web app
decrypts client-side, this ingester needs **no crypto of its own**.

- `run.ts` — the pipeline: launch a persistent Chromium profile → ensure
  authenticated → force-load every journal → dump the stores → completeness gate
  → map → import.
- `login.ts`, `extract.ts`, `map.ts` — auth, extraction + the completeness gate,
  and the IndexedDB→export field mapping.

`playwright-core` is a **devDependency** and is excluded from the production
image (`.dockerignore`). See [browser-extractor.md](browser-extractor.md) and
[browser-crosswalk.md](browser-crosswalk.md).

### JSON-export importer (`src/ingest/json-export/`)

The simplest ingester: reads a hand-exported Day One JSON file into the mirror.
No Day One, browser, or crypto — so the serving layer can be validated
end-to-end against real data with zero risk. `importExport()` here is the shared
write path all ingesters use.

## ADR: why keep two live ingesters (REST *and* browser)?

They **coexist in code but diverge at runtime**, and each earns its place.

- **REST is production.** Pure HTTPS + our own crypto, no browser: small,
  unattended, containerizable. It is the only ingester in the shipped image.
- **The browser ingester is the conformance oracle** (and a break-glass
  fallback). The web app's own JavaScript is, by definition, the correct
  decryption of your data. So it is the ground truth we check our REST crypto
  against: decrypt the same entries both ways and byte-diff them. When Day One
  changes its envelope, crypto, or API, that diff is what tells us *what* broke —
  black-box byte-guessing is exactly what it replaces (see the "former blocker"
  note in [protocol.md](protocol.md): a subagent finding a trailing MD5 checksum
  in the app bundle is what unblocked the REST path).

The E2EE framing REST reimplements is also its **durable** part — encryption
schemes almost never change once shipped — while the web UI churns often but
shallowly. So the split is deliberate: ship the durable, dependency-free path;
keep the churny-but-authoritative path as the test oracle. If we deleted the
browser ingester we'd lose the only independent check that our crypto still
matches Day One; if we shipped it we'd drag Chromium into every deployment.

**Cross-ingester identity caveat:** the web app keys entries by an 18-char web id
with no relation to the 32-hex export uuid, so identity across a browser-sourced
mirror and a REST/JSON-export mirror is **content-based** (e.g. creation date +
text), not by primary key. Keep this in mind when diffing the two.
