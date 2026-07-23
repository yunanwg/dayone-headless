#!/usr/bin/env bun
/**
 * dayone-headless MCP server — read-only access to the local journal mirror. Pure
 * serving layer: it reads the SQLite mirror (and the local media byte cache) and
 * knows nothing about Day One, the network, or crypto. Every tool surfaces
 * `synced_at` so an agent knows how fresh the data is. get_media serves decrypted
 * bytes from the cache only — it never fetches or decrypts (that's the ingester).
 *
 * Transport: stdio by default (for local MCP clients that spawn the process). Set
 * DAYONE_MCP_PORT to serve streamable-HTTP instead (for an always-on homelab
 * service, e.g. behind a Cloudflare Access tunnel).
 */

import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import {
  COVERAGE_JOURNAL_MAX,
  COVERAGE_MONTH_MAX,
  COVERAGE_QUARTER_MAX,
  COVERAGE_YEAR_MAX,
  getEntriesAtSnapshot,
  SAMPLE_TARGET_DEFAULT,
  SAMPLE_TARGET_MAX,
  SAMPLE_TARGET_MIN,
  SNAPSHOT_TOKEN_MAX_CHARS,
  SnapshotValidationError,
  sampleEntries,
} from "./evidence.ts";
import { httpGateConfigFromEnv } from "./http-auth.ts";
import { handleStatelessMcpHttpRequest, MCP_HTTP_MAX_REQUEST_BODY_BYTES } from "./mcp-http.ts";
import {
  MEDIA_IDENTIFIER_MAX_CHARS,
  mediaNotFoundResult,
  presentCachedMedia,
  publicMediaMetadata,
} from "./mcp-media.ts";
import {
  ENTRY_UUID_MAX_CHARS,
  GET_ENTRIES_DEFAULT_PER_ENTRY_CHARS,
  GET_ENTRIES_DEFAULT_TOTAL_CHARS,
  GET_ENTRIES_MAX,
  getEntries,
  getEntry,
  getEntryMedia,
  getFreshness,
  getStats,
  getSyncStatus,
  InvalidSearchQueryError,
  LIST_ENTRIES_MAX,
  LIST_TEXT_DEFAULT_PER_ENTRY_CHARS,
  LIST_TEXT_DEFAULT_TOTAL_CHARS,
  listEntriesPage,
  listJournals,
  listTags,
  onThisDay,
  resolveMedia,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_QUERY_MAX_TERMS,
  searchEntries,
  TEXT_BUDGET_MAX_PER_ENTRY_CHARS,
  TEXT_BUDGET_MAX_TOTAL_CHARS,
} from "./queries.ts";

// Wait for the mirror to exist (a sibling `sync` may still be doing the first
// sync). Poll up to DAYONE_MIRROR_WAIT seconds (default 300), then give up.
const waitS = Number(process.env.DAYONE_MIRROR_WAIT ?? 300);
const deadline = Date.now() + waitS * 1000;
while (!existsSync(DEFAULT_MIRROR)) {
  if (Date.now() > deadline) {
    console.error(`mirror not found at ${DEFAULT_MIRROR} after ${waitS}s. Run \`daytwo sync\` first.`);
    process.exit(1);
  }
  await Bun.sleep(3000);
}
const db = openMirror(); // read-only

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
const snapshotError = (error: SnapshotValidationError) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(
        {
          error: error.code,
          message: error.message,
          current_sync_status: error.current,
        },
        null,
        2,
      ),
    },
  ],
  isError: true,
});

const todayMonthDay = () => {
  const n = new Date();
  return `${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "dayone-headless", version: "0.1.0" },
    {
      instructions:
        "Read-only access to a personal Day One journal mirror, sized for analysis over ten-plus " +
        "years of entries. For any longitudinal or overview question ('shape of my last decade', " +
        "'when did I write most'), call get_stats FIRST — it maps the whole corpus (counts, date " +
        "span, text volume by year/month/journal) without reading a word. Then find entries with " +
        "search_entries (keyword/phrase; handles Chinese and other CJK text) or list_entries " +
        "(filter by journal/tag/date/place/starred; include_text to read bodies in bulk). Read " +
        "For evidence-backed longitudinal analysis, call sample_entries to get metadata-only " +
        "coverage, a snapshot_token, and UUID read batches. Read those batches with get_entries " +
        "using the same token. For ad-hoc content use get_entry (one, curated). get_entries reads up to " +
        `${GET_ENTRIES_MAX}, with explicit per-entry and combined text budgets). Browse facets with list_journals ` +
        "/ list_tags; get an attachment's bytes with get_media. Call get_sync_status to verify " +
        "completeness; read results retain `synced_at` and add `sync_status` freshness metadata. " +
        "READ-ONLY — you cannot create or edit entries.",
    },
  );

  server.registerTool(
    "sample_entries",
    {
      description:
        "Plan a deterministic, metadata-only evidence sample across the entire corpus. Returns NO " +
        "entry text or snippets: only UUID/date/journal/flags/text length, stable evidence_ref values, " +
        "population totals, year/quarter/month + journal/marked coverage, known-bias warnings, a " +
        "snapshot_token, and get_entries-ready UUID batches. Optional journal/tag/starred/date/place " +
        "filters scope candidates, population, and coverage together. Coverage is response-bounded " +
        `(journals ${COVERAGE_JOURNAL_MAX}, years ${COVERAGE_YEAR_MAX}, quarters ` +
        `${COVERAGE_QUARTER_MAX}, months ${COVERAGE_MONTH_MAX}) and each dimension reports ` +
        "total/returned/omitted/truncated. Bounded journal labels carry collision-safe journal_ref " +
        "values. complete_only is the safe default. best_effort permits a stable degraded mirror " +
        "but emits a prominent failed-entry warning. Running, failed, and unknown mirrors are rejected.",
      inputSchema: {
        target: z
          .number()
          .int()
          .min(SAMPLE_TARGET_MIN)
          .max(SAMPLE_TARGET_MAX)
          .default(SAMPLE_TARGET_DEFAULT)
          .describe(
            `maximum evidence entries (default ${SAMPLE_TARGET_DEFAULT}, ` +
              `range ${SAMPLE_TARGET_MIN}-${SAMPLE_TARGET_MAX})`,
          ),
        mode: z
          .enum(["complete_only", "best_effort"])
          .default("complete_only")
          .describe("complete_only rejects degraded mirrors; best_effort permits them with a warning"),
        journal: z.string().optional().describe("exact journal name (see list_journals)"),
        tag: z.string().optional().describe("exact tag name (see list_tags)"),
        starred: z.boolean().optional().describe("only starred entries when true"),
        from: z.string().optional().describe("inclusive lower bound on date, ISO-8601 (e.g. 2023-01-01)"),
        to: z.string().optional().describe("inclusive upper bound; a bare YYYY-MM-DD covers the whole day"),
        place: z.string().optional().describe("case-insensitive substring of place / locality / country"),
      },
      annotations: READ_ONLY,
    },
    async ({ target, mode, ...filters }) => {
      try {
        return json(sampleEntries(db, { target, mode, ...filters }));
      } catch (error) {
        if (error instanceof SnapshotValidationError) return snapshotError(error);
        throw error;
      }
    },
  );

  server.registerTool(
    "get_sync_status",
    {
      description:
        "Check mirror completeness and freshness before analysis. `status=complete` means the last " +
        "attempt imported every changed entry. `degraded` means some entries failed but successful " +
        "entries were retained; `failed` means the attempt could not finish; `running` means a sync " +
        "is in flight or was interrupted before final status could be recorded. `last_complete_at` " +
        "is the trustworthy corpus snapshot time and never advances on running/degraded/failed attempts.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => json(getSyncStatus(db)),
  );

  server.registerTool(
    "list_journals",
    {
      description: "List journals with entry counts, plus when the mirror was last synced.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => json({ ...getFreshness(db), journals: listJournals(db) }),
  );

  server.registerTool(
    "get_stats",
    {
      description:
        "The corpus map — the CHEAP FIRST CALL for any longitudinal or overview question ('shape " +
        "of my last 10 years', 'which years / journals hold the most'). Aggregates entry counts, " +
        "date span, and text volume, grouped by year / month / journal, optionally narrowed by the " +
        "same filters as list_entries. Returns overall totals + per-bucket {key, entries, " +
        "text_chars, starred}. No entry text — use it to plan which entries are worth reading.",
      inputSchema: {
        group_by: z
          .enum(["year", "month", "journal"])
          .describe("bucket entries by calendar year, calendar month (YYYY-MM), or journal name"),
        journal: z.string().optional().describe("exact journal name (see list_journals)"),
        tag: z.string().optional().describe("exact tag name (see list_tags)"),
        starred: z.boolean().optional().describe("only starred entries when true"),
        from: z.string().optional().describe("inclusive lower bound on date, ISO-8601 (e.g. 2023-01-01)"),
        to: z.string().optional().describe("inclusive upper bound; a bare YYYY-MM-DD covers the whole day"),
        place: z.string().optional().describe("case-insensitive substring of place / locality / country"),
      },
      annotations: READ_ONLY,
    },
    async ({ group_by, ...filters }) => json({ ...getFreshness(db), ...getStats(db, group_by, filters) }),
  );

  server.registerTool(
    "search_entries",
    {
      description:
        "Full-text search over entry bodies. Latin queries rank by relevance; CJK queries " +
        "(Chinese/Japanese/Korean) fall back to substring match, newest first, because the index " +
        "does not segment CJK words — so a 2-char Chinese term like 咖啡 still recalls correctly. " +
        `Multiple terms are ANDed (maximum ${SEARCH_QUERY_MAX_TERMS} terms and ` +
        `${SEARCH_QUERY_MAX_CHARS} characters). Optionally narrow with the same filters as list_entries ` +
        "(journal / tag / date range / place / starred) — e.g. 'coffee' in 2021 in journal Trips. " +
        "Each hit returns uuid, date, place, journal, tags, text_length, and a snippet; call " +
        "get_entry / get_entries for full content.",
      inputSchema: {
        query: z
          .string()
          .max(SEARCH_QUERY_MAX_CHARS)
          .refine((value) => value.split(/\s+/).filter(Boolean).length <= SEARCH_QUERY_MAX_TERMS, {
            message: `maximum ${SEARCH_QUERY_MAX_TERMS} whitespace-separated terms`,
          })
          .describe(
            `search query (max ${SEARCH_QUERY_MAX_CHARS} characters / ${SEARCH_QUERY_MAX_TERMS} terms), ` +
              "e.g. 'paris coffee' or 'trip NOT work'",
          ),
        journal: z.string().optional().describe("exact journal name (see list_journals)"),
        tag: z.string().optional().describe("exact tag name (see list_tags)"),
        starred: z.boolean().optional().describe("only starred entries when true"),
        from: z.string().optional().describe("inclusive lower bound on date, ISO-8601 (e.g. 2023-01-01)"),
        to: z.string().optional().describe("inclusive upper bound; a bare YYYY-MM-DD covers the whole day"),
        place: z.string().optional().describe("case-insensitive substring of place / locality / country"),
        limit: z.number().int().min(1).max(100).default(25).describe("max results (default 25)"),
        offset: z.number().int().min(0).default(0).describe("skip N results, for paging (default 0)"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, ...filters }) => {
      try {
        return json({ ...getFreshness(db), results: searchEntries(db, query, filters) });
      } catch (err) {
        if (err instanceof InvalidSearchQueryError) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${err.message}\n\nExamples: 'paris coffee' (all terms), '"exact phrase"', ` +
                  `'trip NOT work', 'run*' (prefix).`,
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "list_entries",
    {
      description:
        "Structured browse (no text query) — filter entries by journal, tag, date range, " +
        "place, or starred, with pagination. Use this for 'my last N entries', 'everything tagged " +
        "X in 2023', 'starred entries from Paris'. Set include_text=true for bounded bulk bodies: " +
        "every item reports Unicode-code-point truncation metadata, while page_info reports exact " +
        "coverage and the next offset. order_by=length surfaces the longest, most reflective " +
        "entries. For keyword/phrase matching use search_entries. All filters AND together.",
      inputSchema: {
        journal: z.string().optional().describe("exact journal name (see list_journals)"),
        tag: z.string().optional().describe("exact tag name (see list_tags)"),
        starred: z.boolean().optional().describe("only starred entries when true"),
        from: z.string().optional().describe("inclusive lower bound on date, ISO-8601 (e.g. 2023-01-01)"),
        to: z.string().optional().describe("inclusive upper bound; a bare YYYY-MM-DD covers the whole day"),
        place: z.string().optional().describe("case-insensitive substring of place / locality / country"),
        include_text: z
          .boolean()
          .default(false)
          .describe("return bounded entry bodies instead of 140-char snippets (default false)"),
        max_chars_per_entry: z
          .number()
          .int()
          .min(1)
          .max(TEXT_BUDGET_MAX_PER_ENTRY_CHARS)
          .default(LIST_TEXT_DEFAULT_PER_ENTRY_CHARS)
          .describe(
            `body chars per entry when include_text=true (default ${LIST_TEXT_DEFAULT_PER_ENTRY_CHARS}, ` +
              `max ${TEXT_BUDGET_MAX_PER_ENTRY_CHARS}; Unicode code points)`,
          ),
        max_total_chars: z
          .number()
          .int()
          .min(1)
          .max(TEXT_BUDGET_MAX_TOTAL_CHARS)
          .default(LIST_TEXT_DEFAULT_TOTAL_CHARS)
          .describe(
            `combined body chars when include_text=true (default ${LIST_TEXT_DEFAULT_TOTAL_CHARS}, ` +
              `max ${TEXT_BUDGET_MAX_TOTAL_CHARS}; Unicode code points)`,
          ),
        order_by: z
          .enum(["date", "length", "editing_time"])
          .default("date")
          .describe("sort key, all newest/largest first: date (default) | length | editing_time"),
        limit: z.number().int().min(1).max(LIST_ENTRIES_MAX).default(50).describe("max results (default 50)"),
        offset: z.number().int().min(0).default(0).describe("skip N results, for paging (default 0)"),
      },
      annotations: READ_ONLY,
    },
    async (filters) => json({ ...getFreshness(db), ...listEntriesPage(db, filters) }),
  );

  server.registerTool(
    "list_tags",
    {
      description:
        "List all tags with how many entries carry each, most-used first. Feed a name to list_entries.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => json({ ...getFreshness(db), tags: listTags(db) }),
  );

  server.registerTool(
    "get_entry",
    {
      description:
        "Get one entry as a curated, token-lean object: text, journal, date, tags, flags, " +
        "location, weather, media metadata, and text_length. Rich text and the verbatim raw " +
        "object are omitted by default because they can be substantially larger than plain text; " +
        "opt back in with include_rich_text / include_raw only when you truly need them. For the " +
        "entry's media bytes use get_media.",
      inputSchema: {
        uuid: z.string().describe("entry uuid from search_entries / list_entries / on_this_day"),
        include_rich_text: z
          .boolean()
          .default(false)
          .describe("add the structured rich-text JSON (default false)"),
        include_raw: z
          .boolean()
          .default(false)
          .describe("add the potentially large verbatim raw source object (default false)"),
      },
      annotations: READ_ONLY,
    },
    async ({ uuid, include_rich_text, include_raw }) => {
      const entry = getEntry(db, uuid, {
        includeRichText: include_rich_text,
        includeRaw: include_raw,
      });
      return entry
        ? json({ ...getFreshness(db), entry })
        : { content: [{ type: "text" as const, text: `no entry: ${uuid}` }], isError: true };
    },
  );

  server.registerTool(
    "get_entries",
    {
      description:
        `Batch curated read — fetch up to ${GET_ENTRIES_MAX} entries by uuid in one call, in the ` +
        "order given, each with the curated shape of get_entry. Use it to read a set of hits from " +
        "search_entries / list_entries instead of many get_entry calls. Bodies are bounded per " +
        "entry and across the batch, with explicit Unicode-code-point truncation metadata on every " +
        "item. Unknown uuids come back in `missing`, never as an error. Heavy rich-text/raw fields " +
        "are intentionally single-entry get_entry options. Pass sample_entries' snapshot_token for " +
        "a guarded longitudinal evidence read; omitting it preserves ordinary unguarded batch reads.",
      inputSchema: {
        uuids: z
          .array(z.string().max(ENTRY_UUID_MAX_CHARS))
          .min(1)
          .max(GET_ENTRIES_MAX)
          .describe(`entry uuids, in the order you want them back (max ${GET_ENTRIES_MAX})`),
        snapshot_token: z
          .string()
          .min(1)
          .max(SNAPSHOT_TOKEN_MAX_CHARS)
          .optional()
          .describe("optional opaque token from sample_entries; enables guarded snapshot validation"),
        max_chars: z
          .number()
          .int()
          .min(1)
          .max(TEXT_BUDGET_MAX_PER_ENTRY_CHARS)
          .default(GET_ENTRIES_DEFAULT_PER_ENTRY_CHARS)
          .describe(
            `body chars per entry (default ${GET_ENTRIES_DEFAULT_PER_ENTRY_CHARS}, ` +
              `max ${TEXT_BUDGET_MAX_PER_ENTRY_CHARS}; Unicode code points)`,
          ),
        max_total_chars: z
          .number()
          .int()
          .min(1)
          .max(TEXT_BUDGET_MAX_TOTAL_CHARS)
          .default(GET_ENTRIES_DEFAULT_TOTAL_CHARS)
          .describe(
            `combined body chars across the batch (default ${GET_ENTRIES_DEFAULT_TOTAL_CHARS}, ` +
              `max ${TEXT_BUDGET_MAX_TOTAL_CHARS}; Unicode code points)`,
          ),
        include_rich_text: z
          .boolean()
          .default(false)
          .describe("legacy option: true is rejected; use get_entry for one rich-text object"),
        include_raw: z
          .boolean()
          .default(false)
          .describe("legacy option: true is rejected; use get_entry for one raw source object"),
      },
      annotations: READ_ONLY,
    },
    async ({ uuids, snapshot_token, max_chars, max_total_chars, include_rich_text, include_raw }) => {
      if (include_rich_text || include_raw) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "get_entries no longer returns rich_text or raw in a batch because those fields " +
                "can multiply into an unbounded response. Call get_entry for one entry at a time.",
            },
          ],
          isError: true,
        };
      }
      if (snapshot_token !== undefined) {
        try {
          return json(
            getEntriesAtSnapshot(db, snapshot_token, uuids, {
              maxChars: max_chars,
              maxTotalChars: max_total_chars,
            }),
          );
        } catch (error) {
          if (error instanceof SnapshotValidationError) return snapshotError(error);
          throw error;
        }
      }
      return json(
        db.transaction(() => ({
          ...getFreshness(db),
          snapshot: null,
          snapshot_guarantee: "none",
          ...getEntries(db, uuids, {
            maxChars: max_chars,
            maxTotalChars: max_total_chars,
          }),
        }))(),
      );
    },
  );

  server.registerTool(
    "get_entry_media",
    {
      description:
        "List the media attached to an entry as METADATA ONLY (identifier, kind, md5, type, " +
        "order) — never the photo/video/audio/pdf bytes. Feed an identifier to get_media for the " +
        "bytes. Empty for an entry with no attachments.",
      inputSchema: {
        uuid: z.string().describe("entry uuid from search_entries / list_entries / on_this_day"),
      },
      annotations: READ_ONLY,
    },
    async ({ uuid }) => json({ ...getFreshness(db), media: getEntryMedia(db, uuid) }),
  );

  server.registerTool(
    "get_media",
    {
      description:
        "Get the decrypted BYTES of one media attachment by its identifier (from get_entry_media). " +
        "Photos under a size cap are returned inline as an image; other/large files return metadata " +
        "without exposing or reading the server-local file. Bytes must be fetched first with the " +
        "`daytwo media-fetch` CLI — if not cached, this reports how to populate it. Read-only: it " +
        "never fetches.",
      inputSchema: {
        identifier: z
          .string()
          .max(MEDIA_IDENTIFIER_MAX_CHARS)
          .describe(
            `media identifier from an entry's media list (max ${MEDIA_IDENTIFIER_MAX_CHARS} characters)`,
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ identifier }) => {
      const m = resolveMedia(db, identifier);
      if (!m) return mediaNotFoundResult();
      if (!m.cached || !m.path) {
        return json({
          ...publicMediaMetadata(m),
          inline: false,
          note: "bytes not cached — run `daytwo media-fetch` on the ingestion host",
        });
      }
      return presentCachedMedia(m);
    },
  );

  server.registerTool(
    "on_this_day",
    {
      description: "Entries whose month-day matches the given date (across all years). Defaults to today.",
      inputSchema: {
        month_day: z
          .string()
          .regex(/^\d{2}-\d{2}$/)
          .optional()
          .describe("MM-DD, e.g. 07-22; default today"),
      },
      annotations: READ_ONLY,
    },
    async ({ month_day }) =>
      json({ ...getFreshness(db), results: onThisDay(db, month_day ?? todayMonthDay()) }),
  );

  return server;
}

const port = process.env.DAYONE_MCP_PORT;

if (port) {
  // Defense-in-depth: optional bearer-token auth + origin allowlist (see http-auth.ts).
  const gate = httpGateConfigFromEnv();

  Bun.serve({
    port: Number(port),
    maxRequestBodySize: MCP_HTTP_MAX_REQUEST_BODY_BYTES,
    // Default to loopback; the proxy/tunnel in front handles remote exposure. In
    // Docker the published-port bind needs 0.0.0.0 — compose sets DAYONE_MCP_HOST.
    hostname: process.env.DAYONE_MCP_HOST ?? "127.0.0.1",
    fetch: (req) => handleStatelessMcpHttpRequest(req, { gate, buildServer }),
  });
  console.error(
    `dayone-headless MCP server ready (read-only, stateless http :${port}, ` +
      `${MCP_HTTP_MAX_REQUEST_BODY_BYTES}-byte request limit)`,
  );
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error("dayone-headless MCP server ready (read-only, stdio)");
}
