# dayone-headless

A **headless, Mac-free, read-only** client for [Day One](https://dayoneapp.com)
journals, exposed as a **CLI and an MCP server**. Runs anywhere Node runs
(Linux / macOS), so it can live in a homelab container and be reached remotely.

> Status: **greenfield / design phase.** No code yet — this repo currently holds
> the architecture and roadmap. See `docs/` and the "Next action" below.

## Why this exists

Day One has no public remote read API. Every existing integration (the official
MCP, the `dayone` CLI, community MCP servers) reads Day One's **local Core Data
SQLite store on a Mac that has the app installed**. That is useless without an
always-on Mac — which we don't have.

The one Mac-free surface that can *read* an E2E-encrypted journal is the **Day One
web app**: it fetches ciphertext from a private REST backend and decrypts it
**client-side in JavaScript** using the master key you paste in. That proves a
headless, no-Mac reader is possible — anything the web app's JS does is
reproducible, because *we hold the keys* and the crypto is standard primitives
(AES-256-GCM for data, RSA for key wrapping).

Goal: turn that surface into a clean, portable, remotely-reachable read MCP.

## Non-goals (for now)

- **Write.** Read-only first. (Remote write already has a sanctioned path via the
  official Zapier/IFTTT integration — out of scope here.)
- **Depending on a Mac / the Day One desktop app** in any way.
- **A GUI.** CLI + MCP only.

## Architecture: decouple ingestion from serving

The single most important design decision. Do **not** build a monolith that welds
the fragile web/crypto layer to the MCP interface.

```
[ ingestion engine ]  --writes-->  [ local decrypted mirror ]  <--reads--  [ CLI / MCP serving layer ]
  fragile, heavy,                     stable contract:              thin, fast, portable,
  runs occasionally                   Day One JSON-export schema     zero Day One / crypto deps
  (browser and/or crypto)             in SQLite
```

- **Serving layer** — pure TS + SQLite. Exposes read tools: `search_entries`,
  `get_entry`, `list_journals`, `on_this_day`, etc. Knows nothing about Day One,
  the web, or crypto. **This is the portable CLI/MCP.** Buildable and testable
  *today* against a hand-exported JSON, before any ingestion exists.
- **Mirror** — a local SQLite DB shaped like Day One's **official JSON export**
  (a stable, community-documented contract). Doubles as your portable backup.
- **Ingestion engine** — gets ciphertext from Day One and decrypts it into the
  mirror. Swappable; three tiers below. Swapping it never touches the serving layer.

### Ingestion tiers

| Tier | What | Reimplements crypto? | Runtime dep | Breaks on | Role |
|---|---|---|---|---|---|
| **A** | Drive the official web app in headless Chromium; dump its decrypted IndexedDB into the mirror | No (official JS decrypts) | Chromium | web UI / IndexedDB schema changes (frequent, shallow) | **Bootstrap + oracle** |
| **B** | Lift the web app's JS crypto/api modules and run them in Node | No (reuse their code) | none (shim WebCrypto) | bundle changes | middle path |
| **C** | Pure client: reverse the REST API + reimplement the E2EE in our own code | **Yes** | none | API / auth changes (rare, deep) | **north star** |

### Strategy: A bootstraps C

Tier A is **not** throwaway. Running the web app under headless Chromium / CDP
gives us, in one harness:
1. the **network traffic** → the API map (Tier C's endpoints),
2. every `crypto.subtle.*` call's live inputs → the **crypto spec** (Tier C's
   framing — observed, not guessed),
3. a permanent **conformance oracle**: decrypt N entries via C and via the web
   app, assert byte-identical, run in CI/cron. When Day One changes something, a
   red test tells us *what* diverged.

So: ship A, mine it to build C, keep A as C's golden test. C's hard part (the
E2EE framing) is also its durable part — E2EE schemes almost never change once
shipped.

## Roadmap

- **Phase 0 — recon (do this first).** With DevTools/CDP against the live web app,
  capture: the auth/login request chain, the entry-list + entry-blob + attachment
  endpoints, and set breakpoints on every `crypto.subtle.*` call to log
  key/iv/ciphertext/plaintext. This single recon pass tells us *how hard C really
  is*. The one true unknown is **auth anti-automation** (Cloudflare / 2FA / device
  registration) — probe it here.
- **Phase 1 — serving layer.** SQLite schema mirroring the JSON export + a CLI and
  MCP server that read it. Validate end-to-end against a manual JSON export. Zero
  risk, fully portable.
- **Phase 2 — ingestion Tier A.** Headless web app → dump IndexedDB → mirror.
  First working no-Mac remote read MCP.
- **Phase 3 — ingestion Tier C.** Pure client, built under A's oracle, locked in
  by golden conformance tests. Drop Chromium from the hot path.
- **Later** — deploy to homelab behind the existing Cloudflare Access tunnel
  (same pattern as the OmniFocus bridge); optional write.

## Security model (read before writing any code)

This process holds **the keys to decrypt the entire journal.** Treat it that way.

- The master key and any session/refresh tokens live **only** on the host running
  ingestion (homelab container). Never commit them; never log them.
- Whatever box runs this = a device that can decrypt everything. Harden it like
  the OmniFocus bridge: Cloudflare Access in front, tight file perms on any
  secret/profile at rest, least privilege.
- ToS gray area: automating the official web client. Personal use, our own data.

## Prior art

None does this headless/web path. The official `bloom/dayone-mcp-server` and the
community servers (`Quevin/mcp-dayone`, `benlen10/dayone-mcp`) all read the **local
Mac SQLite**. We are building, not installing.

## Toolchain

TypeScript + Node, package manager **pnpm** (or **bun**). Staying in JS/TS is
deliberate: it lets us lift the web app's own WebCrypto code into the client
(Tiers B/C) instead of re-deriving it in another language.
