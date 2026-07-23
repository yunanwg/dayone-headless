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

### Browser ingester (`src/ingest/browser/`) — experimental / unproven

Drives the official Day One web app in headless Chromium (Playwright) and dumps
its already-decrypted IndexedDB (`DODexie`) into the mirror. Because the web app
decrypts client-side, this ingester needs **no crypto of its own**.

> **Status: experimental, not a working fallback.** The orchestration exists but
> has never been validated end-to-end here, and it has known gaps: automated
> login is a scaffold (`login.ts`) so every run needs a **manual** headed login;
> tags are **not mapped** (`map.ts`); and it keys entries by the web app's 18-char
> id, a **third id space** that does not line up with the 32-hex export/REST uuid.
> Its would-be unique value — an automated, Mac-free re-ingestion path — is
> exactly the unbuilt part. Do not rely on it. The **proven** independent oracle
> is the JSON export (see below); the **proven** manual fallback is the JSON-export
> importer.

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

## ADR: how REST correctness is proven, and what role each ingester plays

Three ingesters exist in code; only one ships, and correctness is proven by an
independent oracle.

- **REST is production.** Pure HTTPS + our own crypto, no browser: small,
  unattended, containerizable. It is the only ingester in the shipped image, and
  the E2EE it reimplements is the **durable** part — encryption schemes almost
  never change once shipped.
- **The JSON export is the conformance oracle.** Day One's own official JSON
  export is an independent serialization of the same journal, produced by a
  completely separate pipeline and needing no browser. Building a mirror from it
  and byte-diffing against the REST mirror is what proves our crypto is correct:
  every decryption-critical field (entry text, rich text, tags, media
  identifiers, flags, timed-entry dates) must match. This is implemented in
  `scripts/conformance.ts` / `test/conformance.test.ts` and has been run against a
  real account (zero critical diffs). See [README → Verifying decryption].
- **The JSON-export importer is the proven manual fallback.** If the REST API
  ever breaks, a hand-exported JSON re-ingests with `bun run import` — no browser,
  no crypto, already exercised end-to-end.
- **The browser ingester is experimental** (see its section above): a possible
  future *automated* fallback, but currently unproven and gap-ridden, so it is not
  counted on for either oracle or fallback duty.

Keeping the export as the oracle means we get an independent correctness check
without dragging Chromium — or an unvalidated browser-automation path — into the
project's trust story.

**Cross-ingester identity caveat:** the web app keys entries by an 18-char web id
with no relation to the 32-hex export uuid, so identity across a browser-sourced
mirror and a REST/JSON-export mirror is **content-based** (e.g. creation date +
text), not by primary key. Keep this in mind when diffing the two.
