# dayone-headless

A **headless, Mac-free, read-only** client for [Day One](https://dayoneapp.com)
journals, shipped as a **CLI and an MCP server**. Runs anywhere [Bun](https://bun.sh)
runs (Linux / macOS), so it can live in a homelab container and be reached
remotely by an AI agent or from the command line.

> Read-only. Personal use. Not affiliated with Day One / Automattic. It talks to
> Day One's private web API, which may change or block access at any time — see
> [Status & disclaimer](#status--disclaimer).

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

- **Read-only MCP server** — `list_journals`, `search_entries`, `get_entry`,
  `on_this_day`. Every result carries `synced_at` so an agent knows how fresh the
  data is.
- **CLI** — the same reads plus `sync` and a `doctor` health check.
- **No Mac, no browser in production** — the shipping ingester is pure HTTPS +
  our own crypto. The Docker image contains no Chromium.
- **Incremental sync** — first sync is full; after that only entries whose server
  revision changed are re-fetched and re-decrypted.
- **Full-text search** over entry bodies (SQLite FTS5).
- **Portable, decoupled mirror** — a local SQLite DB shaped like Day One's JSON
  export. It is also your portable backup, and nothing it can't yet model is lost
  (every row keeps the verbatim source in a `raw` column).
- **Secrets from env only** — never logged, never committed; secret scanning in CI
  and pre-commit.

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
git clone <your-fork-url> dayone-headless
cd dayone-headless
bun install

cp .env.example .env        # then fill in the secrets below
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
docker compose up -d         # periodic sync + always-on MCP, sharing one mirror
```

See [Deployment](#deployment) for the container details and how to expose it
safely.

## Commands

The single `dayone` dispatcher (`src/serve/cli.ts`; also the `dayone` bin):

| Command | What it does |
|---|---|
| `dayone sync` | Fetch, decrypt, and write the mirror (needs env). |
| `dayone mcp` | Run the read-only MCP server. stdio by default; streamable-HTTP if `DAYONE_MCP_PORT` is set. |
| `dayone doctor` | Config + mirror health self-check (reports secret *presence/shape*, never values). |
| `dayone journals` | List journals with entry counts and freshness. |
| `dayone search <q> [limit]` | Full-text search over entry bodies. |
| `dayone get <uuid>` | One entry's full content + metadata. |
| `dayone on-this-day [MM-DD]` | Entries for a month-day across years (defaults to today). |

Run via `bun run src/serve/cli.ts <cmd>`, the `dayone` bin, or the package
scripts: `bun run sync | mcp | cli | import | check | lint | format | typecheck | test`.

## MCP usage

`dayone mcp` speaks the [Model Context Protocol](https://modelcontextprotocol.io).
By default it serves over **stdio** (for a local client that spawns the process);
set `DAYONE_MCP_PORT` to serve **streamable-HTTP** instead (for an always-on
service).

Add it to a stdio MCP client (e.g. Claude Desktop / Claude Code) roughly like:

```json
{
  "mcpServers": {
    "dayone": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/dayone-headless/src/serve/cli.ts", "mcp"],
      "env": { "DAYONE_MIRROR": "/absolute/path/to/data/mirror.db" }
    }
  }
}
```

The reading MCP process needs only the mirror — no secrets. (Keep the secrets on
whatever runs `sync`.)

Tools exposed (all read-only; media is returned as metadata only, never bytes):

- `list_journals` — journals + entry counts + `synced_at`.
- `search_entries` — FTS5 query over bodies; returns uuid, date, place, snippet.
- `get_entry` — full entry by uuid.
- `on_this_day` — entries matching a month-day across years.

## Deployment

`docker compose up -d` brings up two services sharing one mirror volume:

- **`sync`** — runs the REST ingester on an interval (`DAYONE_SYNC_INTERVAL`,
  default 1h; incremental, so cheap).
- **`mcp`** — an always-on read-only MCP server over streamable-HTTP, bound to
  **loopback `127.0.0.1:8477`**.

The image is a multi-stage `oven/bun` build, runs **non-root**, and ships **no
browser**.

**Never expose the MCP port raw.** It decrypts your entire journal; anyone who
reaches it can read everything. Front it with an authenticating proxy — e.g. a
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/) tunnel —
the usual self-hosted-MCP bridge pattern.

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
   our own crypto), a dev-only **browser ingester** (kept as a conformance oracle),
   and a **JSON-export importer**. All produce the export shape, so the serving
   layer never changes.

Details, and the rationale for keeping two ingesters:
[docs/architecture.md](docs/architecture.md). Protocol / crypto reference:
[docs/protocol.md](docs/protocol.md).

## Security

`dayone-headless` decrypts your **entire** journal. Secrets come only from the
environment and are never logged or committed; the mirror, exports, and browser
profile are all gitignored; reads are the only paths. Full threat model and
deployment rules: [SECURITY.md](SECURITY.md).

## Status & disclaimer

- **Read-only.** There are no write paths to Day One.
- **No Mac / Day One desktop dependency**, by design.
- This automates Day One's **private** web client against **your own account and
  data** for personal use. It is a ToS gray area, is **not affiliated with or
  endorsed by Day One / Automattic**, and the private API may change or block
  access at any time.

## Contributing

Dev setup, project layout, how to add an ingester, and the conformance-oracle
discipline: [CONTRIBUTING.md](CONTRIBUTING.md). Toolchain: Bun, TypeScript,
[Biome](https://biomejs.dev) (lint + format), [lefthook](https://lefthook.dev)
git hooks, [gitleaks](https://gitleaks.io), GitHub Actions CI + release.

## License

MIT — see [LICENSE](LICENSE).
