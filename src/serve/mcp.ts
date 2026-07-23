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
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import { checkHttpGate, httpGateConfigFromEnv } from "./http-auth.ts";
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
  type MediaFile,
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

// Inline media cap: base64 inflates ~33%, and huge blobs bloat the context. Above
// this, return the path/metadata instead of the bytes.
const MAX_INLINE_MEDIA = 4 * 1024 * 1024;
const mimeOf = (m: MediaFile): string =>
  m.kind === "pdf"
    ? "application/pdf"
    : `${m.kind === "photo" ? "image" : m.kind}/${m.type ?? "octet-stream"}`;
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
        "content with get_entry (one, curated) or get_entries (up to " +
        `${GET_ENTRIES_MAX}, with explicit per-entry and combined text budgets). Browse facets with list_journals ` +
        "/ list_tags; get an attachment's bytes with get_media. Call get_sync_status to verify " +
        "completeness; read results retain `synced_at` and add `sync_status` freshness metadata. " +
        "READ-ONLY — you cannot create or edit entries.",
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
        "are intentionally single-entry get_entry options.",
      inputSchema: {
        uuids: z
          .array(z.string().max(ENTRY_UUID_MAX_CHARS))
          .min(1)
          .max(GET_ENTRIES_MAX)
          .describe(`entry uuids, in the order you want them back (max ${GET_ENTRIES_MAX})`),
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
    async ({ uuids, max_chars, max_total_chars, include_rich_text, include_raw }) => {
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
      return json({
        ...getFreshness(db),
        ...getEntries(db, uuids, {
          maxChars: max_chars,
          maxTotalChars: max_total_chars,
        }),
      });
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
        "Photos under a size cap are returned inline as an image; other/large files return " +
        "their local path + metadata. Bytes must be fetched first with the `daytwo media-fetch` CLI — " +
        "if not cached, this reports how to populate it. Read-only: it never fetches.",
      inputSchema: { identifier: z.string().describe("media identifier from an entry's media list") },
      annotations: READ_ONLY,
    },
    async ({ identifier }) => {
      const m = resolveMedia(db, identifier);
      if (!m) return { content: [{ type: "text" as const, text: `no media: ${identifier}` }], isError: true };
      if (!m.cached || !m.path) {
        return json({ ...m, note: "bytes not cached — run `daytwo media-fetch` on the ingestion host" });
      }
      const bytes = new Uint8Array(await Bun.file(m.path).arrayBuffer());
      if (m.kind === "photo" && bytes.length <= MAX_INLINE_MEDIA) {
        return {
          content: [
            { type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType: mimeOf(m) },
          ],
        };
      }
      // Too big or not an image: hand back where it is + how to read it.
      return json({
        ...m,
        size: bytes.length,
        mimeType: mimeOf(m),
        note: "read the bytes from `path` locally",
      });
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
  // Stateful streamable-HTTP: one transport+server per session, routed by the
  // mcp-session-id header. A single shared transport must NOT be reused across
  // requests — the SDK collides message ids and the handshake fails. We create a
  // fresh transport only on `initialize`, register it on session init, and drop
  // it on close; any other session-less request is rejected cleanly.
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const isInit = (body: unknown): boolean =>
    Array.isArray(body)
      ? body.some((m) => (m as { method?: string })?.method === "initialize")
      : (body as { method?: string })?.method === "initialize";

  // Defense-in-depth: optional bearer-token auth + origin allowlist (see http-auth.ts).
  const gate = httpGateConfigFromEnv();

  Bun.serve({
    port: Number(port),
    // Default to loopback; the proxy/tunnel in front handles remote exposure. In
    // Docker the published-port bind needs 0.0.0.0 — compose sets DAYONE_MCP_HOST.
    hostname: process.env.DAYONE_MCP_HOST ?? "127.0.0.1",
    fetch: async (req) => {
      const gated = checkHttpGate(req, gate);
      if (gated) return gated;

      const sid = req.headers.get("mcp-session-id");
      const existing = sid ? transports.get(sid) : undefined;
      if (existing) return existing.handleRequest(req);

      if (req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (isInit(body)) {
          const transport: WebStandardStreamableHTTPServerTransport =
            new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (id) => {
                transports.set(id, transport);
              },
              onsessionclosed: (id) => {
                transports.delete(id);
              },
            });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
          };
          await buildServer().connect(transport);
          return transport.handleRequest(req, { parsedBody: body });
        }
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session id" },
          id: null,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
  });
  console.error(`dayone-headless MCP server ready (read-only, http :${port})`);
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error("dayone-headless MCP server ready (read-only, stdio)");
}
