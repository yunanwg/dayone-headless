# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/); this project aims to follow
[Semantic Versioning](https://semver.org/) once it cuts its first tagged release.

## [Unreleased]

### Added

- **Read-only Day One access with no Mac**, as a `dayone` CLI and an MCP server.
- **REST ingester** (production): pure HTTPS + a from-scratch WebCrypto
  reimplementation of Day One's E2EE. Self-mints and auto-renews the API token
  from `DAYONE_EMAIL`/`DAYONE_PASSWORD`; decrypts with `DAYONE_ENCRYPTION_KEY`.
  Incremental sync (only changed entries are re-fetched); upstream deletions are
  removed. No browser.
- **Browser ingester** (dev/oracle): drives the web app in headless Chromium as a
  byte-for-byte conformance oracle for the REST path and a break-glass fallback.
- **JSON-export importer** for a hand-exported Day One JSON file.
- **SQLite mirror** shaped like the Day One JSON export (the stable contract), with
  FTS5 search. Media stores metadata only — bytes are never mirrored.
- **MCP tools** (read-only): `list_journals`, `search_entries`, `get_entry`,
  `on_this_day`; every result surfaces `synced_at` freshness. stdio or
  streamable-HTTP transport.
- **CLI**: `sync`, `mcp`, `doctor`, `journals`, `search`, `get`, `on-this-day`.
- **Docker**: minimal non-root image (no browser) + `docker compose` for an
  always-on MCP + periodic sync.
- **Toolchain**: Bun, TypeScript, Biome, lefthook, gitleaks; GitHub Actions CI and
  a signed-image (GHCR + SBOM + cosign) release workflow.
