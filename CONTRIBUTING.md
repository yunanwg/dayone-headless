# Contributing

Thanks for helping improve `dayone-headless`. Please read
[docs/architecture.md](docs/architecture.md) first — the whole project hinges on
one rule (decouple ingestion from serving), and most review feedback comes back
to it.

## Dev setup

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install          # also installs git hooks via `prepare` (lefthook)
```

The [lefthook](https://lefthook.dev) hooks run [Biome](https://biomejs.dev)
(lint + format) and [gitleaks](https://gitleaks.io) (secret scan) before commits,
mirroring CI.

Before pushing, run the same gate CI runs:

```bash
bun run check        # typecheck + lint + test
```

Individual scripts: `bun run typecheck | lint | format | test`. Tests run with
`bun test`.

## Project layout

```
src/
  serve/            the serving layer — pure TS + bun:sqlite, no Day One/crypto
    cli.ts          the `daytwo` dispatcher
    mcp.ts          read-only MCP server
    queries.ts      every read query (CLI + MCP share these)
    doctor.ts       config + mirror health check
    db/             schema.sql + mirror open helper
  ingest/           swappable ingesters, all producing the export shape
    rest/           production: pure HTTPS + our own WebCrypto (no browser)
    browser/        dev/oracle: drives the web app in headless Chromium
    json-export/    imports a hand-exported Day One JSON file (shared importer)
  types.ts          the Day One JSON-export shape — the stable contract
docs/               architecture + protocol/design references
test/               bun tests; fixtures in test/fixtures/
```

## The boundary is the rule

The serving layer must never learn about Day One, HTTP, or crypto. If a change to
the web/crypto side forces an edit under `src/serve/…`, the decoupling has
leaked — fix the boundary instead. Ingesters talk to the serving layer only
through the mirror (the export shape in `src/types.ts` / `schema.sql`) and the
shared `importExport()`.

## Adding an ingester

An ingester's only job is to **produce export-shaped objects and hand them to
`importExport()`**. It must not touch the serving layer or the schema.

1. Add a directory under `src/ingest/<name>/`.
2. Get your data however you like (API, file, browser, …) and map it to
   `DayOneExport` / `DayOneEntry` / `DayOneMedia` (`src/types.ts`). Keep the
   verbatim source available so the mirror's `raw` column stays lossless.
3. Call `importExport(db, data, journalName)` to write it.
4. If your source is lazy or partial (as the web cache is), add a completeness
   gate that refuses to write a short mirror — never silently ship a partial one.
5. Media is metadata only. Do not put bytes in the mirror.

## The conformance-oracle discipline

Correctness of the crypto path is proven by **byte-identical conformance against
the web app oracle**, not by "it looks decrypted." The web app's own JavaScript
is, by definition, the correct decryption of your data, so the browser ingester
is the ground truth: decrypt the same entries via the REST path and via the
browser path and assert they are equal. When Day One changes something, that diff
tells you *what* diverged. (This is the OmniFocus codec-cross-validation
discipline; keep it.) Note that identity across a browser-sourced mirror and a
REST/JSON-export mirror is **content-based** — the web id and the export uuid are
unrelated id spaces.

## No real data in tests or fixtures

Tests and fixtures must contain **no real journal content and no secrets** — use
synthetic data, generated keys, and placeholder journal names (e.g. `J1`–`J4`,
`Personal`, `Work`). Anything sensitive (`.env`, `mirror.db*`, exports, browser
`profile*/`) is git-ignored, and gitleaks will block an accidental
key commit — but the first line of defense is not putting real data in the repo.

## Commit & PR conventions

- English for code, comments, commits, and PRs.
- Toolchain is **Bun** (never npm/yarn/pnpm here).
- Commit messages may keep the `Co-Authored-By: Claude` trailer.
- **PRs and issues carry no AI signature** — no "Generated with Claude", no
  `Co-Authored-By` in the PR/issue body. Those are human-to-human channels.
- Report security issues privately via GitHub Security Advisories, not a public
  issue (see [SECURITY.md](SECURITY.md)).
