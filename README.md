# dayone-headless

A **headless, Mac-free, read-only** client for [Day One](https://dayoneapp.com)
journals, shipped as a **CLI and an MCP server**. Runs anywhere [Bun](https://bun.sh)
runs (Linux / macOS), so it can live in a homelab container and be reached
remotely by an AI agent or from the command line.

> **Unofficial, read-only, personal-use.** Not affiliated with or endorsed by
> Day One / Automattic. It reads Day One's private, undocumented web API against
> your own account — that API may change or stop working at any time.

## Why this exists

Day One has no public remote read API. Every existing integration (the official
MCP, the `dayone` CLI, community MCP servers) reads Day One's **local Core Data
SQLite store on a Mac that has the app installed** — useless without an always-on
Mac.

The one Mac-free surface that can *read* an end-to-end-encrypted journal is the
**Day One web app**: it fetches ciphertext from a private REST backend and
decrypts it **client-side in JavaScript** using the encryption key you paste in.
`dayone-headless` reimplements that read path in portable TypeScript — pure
HTTPS + a WebCrypto reimplementation of Day One's E2EE, no browser — and exposes
it as a clean CLI and MCP server over a local, decrypted **mirror**.

## Features

- **Read-only MCP server** — `get_stats`, `list_journals`, `list_tags`,
  `search_entries`, `list_entries`, `sample_entries`, `get_entry`, `get_entries`,
  `on_this_day`, plus media tools. Analysis-grade: `get_stats` maps a decade
  without reading a word; `sample_entries` returns a deterministic, evenly
  stratified slice of the corpus to read next. Every result carries `synced_at`
  so an agent knows how fresh the data is.
- **CLI** — the same reads plus `sync` and a `doctor` health check.
- **No Mac, no browser in production** — the shipping ingester is pure HTTPS +
  our own crypto. The Docker image contains no Chromium.
- **Incremental, completeness-aware sync** — first sync is full; after that only
  entries whose server revision changed are re-fetched and re-decrypted. A
  per-entry failure marks the attempt degraded without advancing the last
  complete freshness timestamp, and the unchanged revision is retried next run.
- **Full-text search** over entry bodies (SQLite FTS5), with a CJK-capable
  substring fallback so Chinese/Japanese/Korean queries recall correctly (FTS5's
  `unicode61` tokenizer does not segment CJK words — see *Search* below).
- **Portable, decoupled mirror** — a local SQLite DB shaped like Day One's JSON
  export. It is also your portable backup, and nothing it can't yet model is lost
  (every row keeps the verbatim source in a `raw` column).
- **Secrets from env or secret files** — direct values and Docker-style `_FILE`
  inputs are mutually exclusive, never logged, never committed; secret scanning
  runs in CI and pre-commit.

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
git clone <your-fork-url> dayone-headless
cd dayone-headless
bun install

cp .env.example .env        # then fill in the secrets below
chmod 600 .env              # owner-only: it holds the master key and account auth
```

Set at minimum, in `.env`:

- `DAYONE_ENCRYPTION_KEY` — your Day One encryption key, format `D1-<userId>-<code…>`
  (in the app: Settings → Encryption; it is the key you'd type into the web app).
- Auth — either `DAYONE_API_TOKEN`, **or** `DAYONE_EMAIL` + `DAYONE_PASSWORD`
  (the client self-mints a token from these).
- `DAYONE_DEVICE_ID` — recommended; pin a 32-hex value so repeat runs register as
  the same device instead of a new one each time.

Then build the mirror and use it:

```bash
bun run sync                 # fetch + decrypt + write data/mirror.db
bun run cli doctor           # config + mirror health check

bun run cli journals
bun run cli search "coffee" 10
bun run cli on-this-day      # or: on-this-day 12-25

bun run mcp                  # start the read-only MCP server (stdio)
```

Docker path (always-on service):

```bash
docker compose up -d         # after provisioning file secrets; see Deployment
```

See [Deployment](#deployment) for the container details and how to expose it
safely.

## Commands

The single `daytwo` dispatcher (`src/serve/cli.ts`; also the `daytwo` bin):

| Command | What it does |
|---|---|
| `daytwo sync` | Fetch, decrypt, and write the mirror (needs env). |
| `daytwo sync-status` | Show whether the latest attempt is running, complete, degraded, or failed, with last-attempt / last-complete timestamps and aggregate failed-entry count. |
| `daytwo media-fetch [uuid]` | Fetch + decrypt attachment **bytes** into `data/media/` (all, or one entry's). |
| `daytwo mcp` | Run the read-only MCP server. stdio by default; streamable-HTTP if `DAYONE_MCP_PORT` is set. |
| `daytwo doctor` | Config, mirror health, and local plaintext-permission check (reports secret *presence/shape*, never values). |
| `daytwo doctor --fix-permissions` | Explicitly tighten existing mirror/cache paths after reviewing the diagnostic. |
| `daytwo journals` | List journals with entry counts and freshness. |
| `daytwo stats <year\|month\|journal> [filters]` | Corpus map: entry counts, date span, and text volume per bucket. The cheap first look for a longitudinal question. |
| `daytwo sample [n] [--stratify-by year\|month\|none] [filters]` | Deterministic, metadata-only stratified coverage sample (default 48, max 200) — evenly spread across years for longitudinal reading. Feed the uuids to `get`/`get_entries`. |
| `daytwo search <q> [limit] [filters]` | Full-text search (CJK-capable), optionally narrowed by the `list` filters. |
| `daytwo list [filters]` | Structured browse — filter/paginate without a text query. `--include-text` returns bounded bodies with explicit truncation metadata; `--order-by date\|length\|editing_time`. |
| `daytwo tags` | All tags with entry counts, most-used first. |
| `daytwo get <uuid> [--rich-text] [--raw]` | One entry, curated. `--rich-text` / `--raw` add the heavy fields. |
| `daytwo media <uuid>` | Media metadata attached to an entry (never bytes). |
| `daytwo media-file <id>` | Resolve a media identifier to its cached bytes path (after `media-fetch`). |
| `daytwo on-this-day [MM-DD]` | Entries for a month-day across years (defaults to today). |

`list` filters are all optional and ANDed together:

```
daytwo list --journal <name> --tag <name> --starred \
            --from <ISO> --to <ISO> --place <substr> \
            --limit <n> --offset <n> \
            --include-text --max-chars-per-entry <n> --max-total-chars <n>
```

`--from`/`--to` bound `creation_date` (both inclusive; a bare `YYYY-MM-DD` `--to`
covers the whole day). `--place` is a case-insensitive substring over place /
locality / country. Newest first; page with `--limit`/`--offset`. List output
includes `page_info` with `returned`, `has_more`, and `next_offset`; this avoids
guessing whether a page covered the filtered result set.

The same flags narrow `search`, so keyword and structure compose:

```
daytwo search "coffee" --from 2021-01-01 --to 2021-12-31 --journal Trips
```

Run via `bun run src/serve/cli.ts <cmd>`, the `daytwo` bin, or the package
scripts: `bun run sync | mcp | cli | import | check | lint | format | typecheck | test`.

The mirror stores media **metadata** only; attachment **bytes** are fetched on
request by `media-fetch` into a content-addressed, gitignored cache
(`data/media/<md5>`, override with `DAYONE_MEDIA_DIR`). It is idempotent
(already-cached files are skipped without a download) and each file is
md5-verified before it is written, so a wrong decrypt is never cached.

Decrypted local state is owner-only by default: the mirror database and its
SQLite WAL/SHM sidecars, plus cached media files, are created as `0600`; their
dedicated directories are `0700`. The process installs a restrictive `077`
umask before creating them and normal opens tighten legacy group/world bits
without adding owner permissions. `daytwo doctor` also checks the project-local
`.env` when present and diagnoses the full cache without printing media
identifiers; use the explicit `--fix-permissions` option to repair those existing
paths in one pass.

## Search

`search_entries` is a hybrid over one query string:

- **Latin queries** go through **SQLite FTS5** — relevance ranking, `snippet()`
  highlighting, phrase/`AND`/`OR`/`NOT`/prefix operators.
- **CJK queries** (any term containing a Chinese / Japanese / Korean codepoint)
  fall back to a **`LIKE` substring** scan: every whitespace-split term must
  appear in the body (`AND`-combined), newest first, with a hand-built snippet.

Why the split, stated honestly: FTS5's `unicode61` tokenizer does not segment
CJK — it treats a run of ideographs as one token — so `MATCH '咖啡'` matches only
entries where that exact 2-char run is a whole "word", missing almost everything.
The trigram tokenizer is not a fix either: the dominant Chinese search terms are
2-character words, below trigram's 3-character minimum. Substring match is the
only correct recall path for short CJK terms, and at this corpus size a `LIKE`
scan is milliseconds. The trade-off is that CJK results are ordered by date, not
relevance, and boolean/phrase operators apply to Latin queries only. Structured
filters (journal / tag / date / place / starred) work identically on both paths.

## MCP usage

`daytwo mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io).
By default it serves over **stdio** (for a local client that spawns the process);
set `DAYONE_MCP_PORT` to serve **streamable-HTTP** instead (for an always-on
service). The HTTP server binds to **loopback `127.0.0.1`** by default
(`DAYONE_MCP_HOST` overrides it) — always keep it behind an authenticating proxy.
The HTTP transport is stateless: every POST gets a fresh MCP server/transport,
with no retained session map or session IDs. Request bodies are capped at 256
KiB by Bun before JSON parsing. The only HTTP route is **`POST /mcp`**; responses
are non-cacheable and excess concurrent requests receive `429` with
`Retry-After`.

The HTTP boundary requires an exact `Host` allowlist and offers three explicit
authentication modes: `none` for a literal loopback bind only, `static` for a
high-entropy bearer (not OAuth), and `cloudflare-access` to verify the Access JWT
assertion injected by Cloudflare. A Host allowlist is routing validation, not
authentication; startup rejects `none` on wildcard, LAN, container-network, or
public binds. An exact `Origin` allowlist separately blocks browser rebinding;
the default rejects all browser origins. See
[docs/deployment.md](docs/deployment.md) before enabling remote access.

Add it to a stdio MCP client (e.g. Claude Desktop / Claude Code) roughly like:

```json
{
  "mcpServers": {
    "daytwo": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/dayone-headless/src/serve/cli.ts", "mcp"],
      "env": { "DAYONE_MIRROR": "/absolute/path/to/data/mirror.db" }
    }
  }
}
```

The reading MCP process needs only the mirror and, optionally, its own transport
credential — never the Day One encryption key or upstream account credential.

Tools exposed (all read-only):

- `get_sync_status` — check completeness before analysis: latest attempt status,
  aggregate failed-entry count, and separate last-attempt / last-complete
  timestamps. Running/degraded/failed attempts never advance `last_complete_at`;
  `running` may also mean the previous process was interrupted before finalizing.
- `get_stats` — the corpus map: entry counts, date span, and text volume grouped
  by year / month / journal (same filters as `list_entries`). The cheap first
  call for any longitudinal or overview question — no entry text is read.
- `sample_entries` — the deterministic, metadata-only complement to `get_stats`
  for longitudinal reading. `get_stats` shows the *shape* of the corpus;
  `sample_entries` hands back an even, reproducible slice of it to read. It
  allocates `n` entries (default 48, max 200) across strata — by year (default),
  month, or `none` — proportionally to each stratum's size, giving every
  non-empty stratum at least one while the budget allows (oldest first), and
  within each stratum picks evenly spaced entries in `(creation_date, uuid)`
  order. No randomness: the same mirror and arguments always return the same
  uuids, in chronological order. Results are ordinary metadata-only summaries
  (`uuid`, `creation_date`, `journal`, `tags`, `starred`, `text_length`,
  `place_name`) with no body or snippet — feed the uuids straight to
  `get_entries`. The same journal / tag / starred / date / place filters as
  `list_entries` scope the sample.
- `list_journals` — journals + entry counts + `synced_at`.
- `list_tags` — every tag with its entry count, most-used first.
- `search_entries` — keyword search over bodies (CJK-capable; see *Search*),
  optionally narrowed by the same filters as `list_entries`; each hit returns
  uuid, date, place, journal, tags, `text_length`, and a snippet.
- `list_entries` — structured browse: filter by journal / tag / date range /
  place / starred, paginated. `include_text` returns bounded bodies for bulk
  reading; defaults are 4,000 Unicode characters per entry and 24,000 across the
  page. Every body reports `text_truncation`, while `page_info` reports
  `returned`, `has_more`, and `next_offset`. `order_by` = `date` | `length` |
  `editing_time`. The complement to `search_entries`.
- `get_entry` — one entry as a curated, token-lean object (typed fields + inlined
  media metadata + `text_length`); `include_rich_text` / `include_raw` opt back
  into the heavy fields.
- `get_entries` — batch curated read of up to 50 uuids in one call, in order.
  Bodies default to 12,000 Unicode characters per entry and 60,000 across the
  batch; each item reports exact original/returned counts and which budget
  truncated it. Unknown uuids are returned in `missing`. Heavy rich-text/raw
  fields stay on single-entry `get_entry` so a batch cannot silently multiply
  them into an unbounded response; legacy batch flags are rejected with a
  migration message instead of being silently ignored. Pair it with
  `sample_entries` for longitudinal reading: sample the uuids, then read them here.
- `get_entry_media` — media attached to an entry, as metadata only (never bytes).
- `get_media` — the decrypted **bytes** of one attachment by identifier (small
  photos inline as an image; larger/other files return metadata only, never a
  server-local path). Serves from the cache only — populate it with
  `media-fetch`; never fetches or decrypts.
- `on_this_day` — entries matching a month-day across years.

Read results keep the backwards-compatible top-level `synced_at` (the last
complete snapshot) and add a `sync_status` object. If the latest attempt is
degraded, successfully updated entries remain available, failed revisions stay
pending for retry, and callers can avoid treating the mirror as complete.
The ingester records `running` before network, decryption, or entry writes, so
concurrent readers and post-crash readers never mistake an in-flight partial
mirror for the last complete snapshot.

## Deployment

The Compose stack defines two services sharing one mirror volume:

- **`sync`** — runs the REST ingester on an interval (`DAYONE_SYNC_INTERVAL`,
  default 1h; incremental, so cheap).
- **`mcp`** — an always-on read-only MCP server over streamable-HTTP, bound to
  a container wildcard and published only on host **loopback
  `127.0.0.1:8477`**. Configure static or Cloudflare Access authentication
  before starting it; `none` is rejected because the process bind is not
  loopback.

The image is a multi-stage, version-pinned `oven/bun` build and ships **no
browser**. A minimal root entrypoint accepts only the fixed, non-symlink
`/run/secrets/<known-name>` mounts and copies them into a private tmpfs so
owner-only files work across arbitrary Linux host UIDs; it then starts the
application as `bun` with an empty capability bounding set and
`no-new-privileges`. Compose makes each root filesystem read-only, limits PIDs,
uses service-specific readiness checks, and mounts upstream credentials only
into `sync`.

**Never expose the MCP port raw.** It reads your entire decrypted journal; anyone
who reaches it can read everything. Front it with an authenticating proxy — e.g. a
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) tunnel —
the usual self-hosted-MCP bridge pattern. The compose `mcp` service receives no
Day One upstream credentials (only `sync` gets those). For defense-in-depth,
choose an explicit MCP auth mode and configure exact Host/Origin allowlists.

Full walkthrough (env/secrets handling, pinning the device id, sync cadence,
Cloudflare Access, backups): [docs/deployment.md](docs/deployment.md).

## Architecture

The one rule: **decouple ingestion from serving.** Three parts with a stable
contract between them:

```
[ ingester ]  --writes-->  [ decrypted mirror ]  <--reads--  [ CLI / MCP serving layer ]
 gets + decrypts             stable contract:                 pure TS + bun:sqlite,
 (REST, or browser,          Day One JSON-export shape         zero Day One / crypto deps
  or a JSON export)          in SQLite                         — the portable CLI/MCP
```

1. **Serving layer** (`src/serve/…`) — pure TS + `bun:sqlite`, knows nothing about
   Day One, the web, or crypto.
2. **Mirror** — SQLite shaped like Day One's JSON export (`src/types.ts`,
   `src/serve/db/schema.sql`). Media is metadata only; bytes are fetched on demand.
3. **Ingesters** (`src/ingest/…`) — the production **REST ingester** (pure HTTPS +
   our own crypto), a **JSON-export importer** (the proven manual fallback and the
   independent conformance oracle), and an experimental, unproven **browser
   ingester**. All produce the export shape, so the serving layer never changes.

Details, and the rationale for keeping two ingesters:
[docs/architecture.md](docs/architecture.md). Protocol / crypto reference:
[docs/protocol.md](docs/protocol.md).

## Verifying decryption

Correctness of the REST ingester's own crypto is proven, not assumed: the same
entries decrypted by the REST path are compared against an **independent oracle**
— a mirror built from Day One's official JSON export — and must come out
identical on every decryption-critical field (entry text, rich text, tags, media
identifiers, flags, and timed-entry dates). This is codec cross-validation.

`scripts/conformance.ts` runs the comparison over two local mirrors (both
gitignored — real journal data never enters the repo):

```bash
# oracle: import a hand-exported JSON journal into its own mirror
DAYONE_MIRROR=exports/mirror-export.db bun run import path/to/Journal.json
# subject: the REST-synced mirror
bun run sync
# compare — exits non-zero on any critical diff
bun run conformance data/mirror.db exports/mirror-export.db
```

Fields that legitimately differ between the export and the live REST feed
(coordinate float precision, export-only reverse-geocoded place names, media
`type` naming, all-day-entry timezone anchoring) are classified as **benign** and
reported for information only. The same check runs in `test/conformance.test.ts`
when `CONFORMANCE_REST_DB` / `CONFORMANCE_EXPORT_DB` are set, and is skipped in CI
where no real data exists.

## Security

`dayone-headless` decrypts your **entire** journal. Secrets come only from direct
environment values or their `_FILE` companions and are never logged or
committed; the mirror, exports, and browser profile are all gitignored; reads are
the only paths. Full threat model and deployment rules:
[SECURITY.md](SECURITY.md).

## Contributing

Dev setup, project layout, how to add an ingester, and the conformance-oracle
discipline: [CONTRIBUTING.md](CONTRIBUTING.md). Toolchain: Bun, TypeScript,
[Biome](https://biomejs.dev) (lint + format), [lefthook](https://lefthook.dev)
git hooks, [gitleaks](https://gitleaks.io), GitHub Actions CI + release.

## License

MIT — see [LICENSE](LICENSE).
