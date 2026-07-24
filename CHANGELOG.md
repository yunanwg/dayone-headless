# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/); this project aims to follow
[Semantic Versioning](https://semver.org/) once it cuts its first tagged release.

## [0.1.2](https://github.com/yunanwg/dayone-headless/compare/v0.1.1...v0.1.2) (2026-07-24)


### Features

* **serve:** add CJK search, corpus stats, and batch reads ([#27](https://github.com/yunanwg/dayone-headless/issues/27)) ([c2c01c0](https://github.com/yunanwg/dayone-headless/commit/c2c01c0a9ccd7ec567a34bee5841c8c7fcbeab34))
* **serve:** plan snapshot-bound evidence coverage ([#36](https://github.com/yunanwg/dayone-headless/issues/36)) ([e54d9ad](https://github.com/yunanwg/dayone-headless/commit/e54d9ad46ea8ef65ba1e8c2c3659ba6e6da1a03d))


### Bug Fixes

* **ingest:** fully reconcile JSON re-imports ([#29](https://github.com/yunanwg/dayone-headless/issues/29)) ([ad4ce5e](https://github.com/yunanwg/dayone-headless/commit/ad4ce5e94909641231ab63077ba04fef2dadbfb2))
* **ingest:** tolerate inline binary in the entries feed ([#42](https://github.com/yunanwg/dayone-headless/issues/42)) ([c5bda48](https://github.com/yunanwg/dayone-headless/commit/c5bda48fb32f3cfb9c18e17dff81418b5c391abd))
* **ingest:** verify D1 envelope signatures ([#41](https://github.com/yunanwg/dayone-headless/issues/41)) ([837093f](https://github.com/yunanwg/dayone-headless/commit/837093feb583e1a3edf1e7d00de84cb953f555c3))
* **mcp:** bound and redact media responses ([#34](https://github.com/yunanwg/dayone-headless/issues/34)) ([443a54f](https://github.com/yunanwg/dayone-headless/commit/443a54f89b8cceb3b9bc89d1fa945b743c94fe94))
* **mcp:** make HTTP transport stateless ([#35](https://github.com/yunanwg/dayone-headless/issues/35)) ([d507614](https://github.com/yunanwg/dayone-headless/commit/d50761467c7dcc4dde6ebe26c9dd2effd3654959))
* **security:** harden HTTP transport, md5 path guard, query safety ([#24](https://github.com/yunanwg/dayone-headless/issues/24)) ([7eb5a44](https://github.com/yunanwg/dayone-headless/commit/7eb5a44c4da986c86a3879cd96499ada2b34ac79))
* **security:** harden remote MCP deployment ([#37](https://github.com/yunanwg/dayone-headless/issues/37)) ([16fd6a0](https://github.com/yunanwg/dayone-headless/commit/16fd6a0a346b12c3244a073fc314a38d5ced588d))
* **security:** make local plaintext storage owner-only ([#31](https://github.com/yunanwg/dayone-headless/issues/31)) ([06a44d9](https://github.com/yunanwg/dayone-headless/commit/06a44d948c1b166d039a236df9d605377f7f4066))
* **serve:** bound bulk journal responses ([#33](https://github.com/yunanwg/dayone-headless/issues/33)) ([cda9f4d](https://github.com/yunanwg/dayone-headless/commit/cda9f4df7ff9fa0b6898c1106b4f64e79dda4ec2))
* **sync:** surface degraded mirror completeness ([#30](https://github.com/yunanwg/dayone-headless/issues/30)) ([e9f7677](https://github.com/yunanwg/dayone-headless/commit/e9f7677190f3fe44b0edc7521c030c16e98d14b2))


### Performance Improvements

* **ingest:** batch FTS cleanup during re-import ([#32](https://github.com/yunanwg/dayone-headless/issues/32)) ([bc5f37e](https://github.com/yunanwg/dayone-headless/commit/bc5f37ecbd337e36b8d4b5b0434ac7fa8f8ec58e))
* quick-win fixes from the perf audit ([#23](https://github.com/yunanwg/dayone-headless/issues/23)) ([0a8851b](https://github.com/yunanwg/dayone-headless/commit/0a8851b6c91092485c4c6cb0f17daad37ccdaa84))
* **sync:** replace fixed-slice barrier with bounded worker pool ([#26](https://github.com/yunanwg/dayone-headless/issues/26)) ([dc2a16d](https://github.com/yunanwg/dayone-headless/commit/dc2a16d68b6cafc3abd7aebc4dab21fb726920a8))

## [0.1.1](https://github.com/yunanwg/dayone-headless/compare/v0.1.0...v0.1.1) (2026-07-23)


### Features

* fetch + decrypt attachment bytes (media-fetch) ([#22](https://github.com/yunanwg/dayone-headless/issues/22)) ([6efb180](https://github.com/yunanwg/dayone-headless/commit/6efb180c656d49603e9751e57490dcd5d83c3944))
* filterable full-text search ([#15](https://github.com/yunanwg/dayone-headless/issues/15)) ([08cc137](https://github.com/yunanwg/dayone-headless/commit/08cc137e1eeee1cf7ff2d8d69ff84e90447c00cc))
* REST decryption conformance harness (export oracle) ([#16](https://github.com/yunanwg/dayone-headless/issues/16)) ([e7d3577](https://github.com/yunanwg/dayone-headless/commit/e7d3577a37014bc585735e6d02bbcf17189b33c0))
* **serve:** resolveMedia + media-file/get_media + docs ([#20](https://github.com/yunanwg/dayone-headless/issues/20)) ([a3165a0](https://github.com/yunanwg/dayone-headless/commit/a3165a04579254d876879434470fcde310e297d1))
* structured query surface (list_entries, list_tags) ([#13](https://github.com/yunanwg/dayone-headless/issues/13)) ([c6ba31b](https://github.com/yunanwg/dayone-headless/commit/c6ba31b6aa9ce41bfccf2ddc9ea5a0ed404c685a))
* surface entry media metadata (get_entry_media) ([#14](https://github.com/yunanwg/dayone-headless/issues/14)) ([ebb12b2](https://github.com/yunanwg/dayone-headless/commit/ebb12b2b4cfd0744dc95dd31ed2cac4b6346127a))

## 0.1.0 (2026-07-23)


### Features

* **cli:** unified `dayone` entry point + doctor self-check ([68fe158](https://github.com/yunanwg/dayone-headless/commit/68fe158e1576a1da907f83a392f4bffc4b65f966))
* **github:** add Claude Code GitHub Workflow ([#1](https://github.com/yunanwg/dayone-headless/issues/1)) ([b2ba35b](https://github.com/yunanwg/dayone-headless/commit/b2ba35ba907e7c8045e64859a4ac00dc81bca171))
* **ingest:** reconcile export contract against real data + Tier A crosswalk ([004d01b](https://github.com/yunanwg/dayone-headless/commit/004d01b3b164d2a9b75587d1b88bece4f941bc0a))
* REST sync + MCP server + freshness; adopt Biome toolchain ([cb8adb3](https://github.com/yunanwg/dayone-headless/commit/cb8adb37c70604721899dce915d87b3fbce2548b))
* **serve:** Phase 1 serving-layer spine (bun + SQLite mirror) ([107798a](https://github.com/yunanwg/dayone-headless/commit/107798a5ae8b87ce75f3847b2c992ea34f683980))
* **tier-a:** headless extractor — dump, completeness gate, orchestrator ([61c7003](https://github.com/yunanwg/dayone-headless/commit/61c7003642b4a825bb1f770e5ec443ba7a487fc0))
* **tier-a:** IndexedDB → export mapper (pure, no browser/crypto) ([abbbcd9](https://github.com/yunanwg/dayone-headless/commit/abbbcd9823ef2442f61780fc300622bbd9898659))
* **tier-c:** crypto primitives, RSA-OAEP unwrap validated vs vault oracle ([e7133fa](https://github.com/yunanwg/dayone-headless/commit/e7133faf060088c6c6a4f4c6edeaf574b40ff6cb))
* **tier-c:** D1 envelope decrypt — full chain works end-to-end, no browser ([91335ed](https://github.com/yunanwg/dayone-headless/commit/91335edefb5112d4e688085e31ae1093c15d74ca))
* **tier-c:** passphrase path + full env-only reader (no browser at all) ([711fcea](https://github.com/yunanwg/dayone-headless/commit/711fceac50c5f6664b56c8ad5921bdecafcd50cb))
* **tier-c:** pure-REST client (env-driven, no browser) + D1 envelope decode ([ee1b655](https://github.com/yunanwg/dayone-headless/commit/ee1b6555f6ca3868ce5c8ae6061e9801d5e4d27c))
* **tier-c:** run.ts — env-only CLI entry to exercise the full pipeline ([28fb92f](https://github.com/yunanwg/dayone-headless/commit/28fb92f7e573e91c6776f68dc56925b55896a618))
* **tier-c:** self-contained client headers — env needs only credentials ([6db4a60](https://github.com/yunanwg/dayone-headless/commit/6db4a60caacbc513dfa91b26db58b8b7846d85e9))
* **tier-c:** self-minting token — headless login + auto-renew ([0cf474c](https://github.com/yunanwg/dayone-headless/commit/0cf474cbb6a3f7019d6a8f52c60e99fecda8695a))
* **tier-c:** validated cold-start end-to-end; rename to DAYONE_ENCRYPTION_KEY ([3849eaa](https://github.com/yunanwg/dayone-headless/commit/3849eaa9b01ac2f96ca5a3031fb45d587fbaa6e4))
* typed error taxonomy + CHANGELOG ([7b73293](https://github.com/yunanwg/dayone-headless/commit/7b732935903863353d9af5e7af9b6496ca44f559))


### Bug Fixes

* **mcp:** stateful session routing for streamable-HTTP transport ([2c92ef2](https://github.com/yunanwg/dayone-headless/commit/2c92ef2deae2a9a76c5110f8d4d5141635adb2b1))
* **rest:** decrypt journal display names (D1 type-00 via the vault key) ([37a57aa](https://github.com/yunanwg/dayone-headless/commit/37a57aa6bc99ab876fd19ce66a6f9897dfec5dbd))
* **security:** recon/ was not gitignored (inline-comment bug) ([3f26b33](https://github.com/yunanwg/dayone-headless/commit/3f26b331df15da67467b0664c771ff25ac0d080a))
* **tier-a:** auth signal + per-journal force-load; E2E validated on real data ([678eb47](https://github.com/yunanwg/dayone-headless/commit/678eb4782a1c3f2189d3cb529232500ff16352c7))

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
