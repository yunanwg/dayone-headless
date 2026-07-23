# Roadmap & decisions

Status of the read client, and the decisions that close out its scope. Written to
be the single place that says "what's done, what we deliberately are *not* doing,
and why".

## Done

- **Serving layer** — pure TS + `bun:sqlite` over the mirror; CLI + MCP.
- **Query surface** — `list_journals`, `list_tags`, `search_entries` (FTS5, with
  the structured filters), `list_entries` (journal / tag / date-range / place /
  starred + pagination), `on_this_day`, `get_entry`.
- **Media** — metadata in the mirror; `get_entry_media` for the metadata;
  `media-fetch` fetches + decrypts attachment **bytes** into a content-addressed,
  gitignored cache; `media-file` / `get_media` serve those bytes (photos inline).
- **REST ingester** — pure HTTPS + our own crypto, **proven correct** by
  byte-identical conformance against a JSON-export oracle
  (`scripts/conformance.ts`; run against a real account, zero critical diffs).
- **JSON-export importer** — the proven manual fallback and the conformance oracle.

## Deliberate non-goals (closed decisions)

### Semantic / vector search — **not building it (for now)**

An earlier idea was to add embedding-based semantic retrieval ("RAG"), like a
memory bank. **Decision: do not build it**, on first principles:

1. **The E2EE bottom line forbids the obvious implementation.** Computing
   embeddings via a hosted API means sending decrypted journal text off the
   machine — a direct violation of the project's core rule (secrets/plaintext
   never leave). So embeddings would have to be computed **locally**.
2. **A local embedding stack is disproportionate.** Bundling a transformer model
   + an inference runtime (ONNX/…) into what is otherwise a small, dependency-lean
   read client is a large amount of weight (model download, memory, cold-start)
   for a marginal gain.
3. **Retrieval is already well served.** FTS5 full-text search, the structured
   filters (journal / tag / date / place / starred), `on_this_day`, and now media
   cover the realistic "find the entry" needs of a CLI/MCP journal client.

**If revisited**, the path that respects the E2EE line is a **local** embedding
model writing into `sqlite-vec` (stays inside the single-file mirror, no external
vector store, no plaintext egress). That is gated on the local-embedding weight
being worth it — an explicit decision to reopen, not a default.

### Automated browser ingester — deprioritized, experimental

The browser ingester is unproven and gap-ridden; the JSON export superseded it as
both oracle and fallback. See [architecture.md](architecture.md). Its only unique
value would be an *automated, no-manual-export* fallback, which is exactly the
unbuilt part; not on the critical path.

### Write path — out of scope

Read-only until read is complete and explicitly re-scoped. There are no write
paths, by design.

## Possible future work (uncommitted)

- Per-entry **on-demand** media (fetch just what an agent asks for, vs. the
  current bulk/scoped `media-fetch`).
- Thumbnail bytes (currently only full attachments are fetched).
