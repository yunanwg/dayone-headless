#!/usr/bin/env bun
/**
 * dayone-headless MCP server — read-only access to the local journal mirror. Pure
 * serving layer: it reads the SQLite mirror and knows nothing about Day One, the
 * network, or crypto. Every tool surfaces `synced_at` so an agent knows how fresh
 * the data is. Media BYTES are not served here — tools return media metadata only.
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
import {
  getEntry,
  getEntryMedia,
  getSyncedAt,
  listEntries,
  listJournals,
  listTags,
  onThisDay,
  searchEntries,
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
const todayMonthDay = () => {
  const n = new Date();
  return `${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "dayone-headless", version: "0.1.0" },
    {
      instructions:
        "Read-only access to a personal Day One journal mirror. Find entries with search_entries " +
        "(keyword/phrase) or list_entries (filter by journal/tag/date/place/starred), browse the " +
        "facets with list_journals / list_tags, then get_entry for full content. `synced_at` on " +
        "each result says how fresh the mirror is. This is READ-ONLY — you cannot create or edit entries.",
    },
  );

  server.registerTool(
    "list_journals",
    {
      description: "List journals with entry counts, plus when the mirror was last synced.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => json({ synced_at: getSyncedAt(db), journals: listJournals(db) }),
  );

  server.registerTool(
    "search_entries",
    {
      description:
        "Full-text search over entry bodies, highest-ranked first. Optionally narrow with the " +
        "same filters as list_entries (journal / tag / date range / place / starred) — e.g. " +
        "'coffee' in 2021 in journal Trips. Returns uuid, date, place, snippet; call get_entry for full content.",
      inputSchema: {
        query: z.string().describe("FTS5 query, e.g. 'paris coffee' or 'trip NOT work'"),
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
    async ({ query, ...filters }) =>
      json({ synced_at: getSyncedAt(db), results: searchEntries(db, query, filters) }),
  );

  server.registerTool(
    "list_entries",
    {
      description:
        "Structured browse (no text query) — filter entries by journal, tag, date range, " +
        "place, or starred, newest first, with pagination. Use this for 'my last N entries', " +
        "'everything tagged X in 2023', 'starred entries from Paris'. For keyword/phrase " +
        "matching use search_entries instead. All filters AND together. Call get_entry for full content.",
      inputSchema: {
        journal: z.string().optional().describe("exact journal name (see list_journals)"),
        tag: z.string().optional().describe("exact tag name (see list_tags)"),
        starred: z.boolean().optional().describe("only starred entries when true"),
        from: z.string().optional().describe("inclusive lower bound on date, ISO-8601 (e.g. 2023-01-01)"),
        to: z.string().optional().describe("inclusive upper bound; a bare YYYY-MM-DD covers the whole day"),
        place: z.string().optional().describe("case-insensitive substring of place / locality / country"),
        limit: z.number().int().min(1).max(200).default(50).describe("max results (default 50)"),
        offset: z.number().int().min(0).default(0).describe("skip N results, for paging (default 0)"),
      },
      annotations: READ_ONLY,
    },
    async (filters) => json({ synced_at: getSyncedAt(db), results: listEntries(db, filters) }),
  );

  server.registerTool(
    "list_tags",
    {
      description:
        "List all tags with how many entries carry each, most-used first. Feed a name to list_entries.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => json({ synced_at: getSyncedAt(db), tags: listTags(db) }),
  );

  server.registerTool(
    "get_entry",
    {
      description:
        "Get one entry's full content + metadata by uuid. For the entry's attached " +
        "media use get_entry_media (this returns the entry body, not media bytes).",
      inputSchema: { uuid: z.string().describe("entry uuid from search_entries / on_this_day") },
      annotations: READ_ONLY,
    },
    async ({ uuid }) => {
      const entry = getEntry(db, uuid);
      return entry
        ? json(entry)
        : { content: [{ type: "text" as const, text: `no entry: ${uuid}` }], isError: true };
    },
  );

  server.registerTool(
    "get_entry_media",
    {
      description:
        "List the media attached to an entry as METADATA ONLY (identifier, kind, md5, type, " +
        "order) — never the photo/video/audio/pdf bytes. Empty for an entry with no attachments.",
      inputSchema: {
        uuid: z.string().describe("entry uuid from search_entries / list_entries / on_this_day"),
      },
      annotations: READ_ONLY,
    },
    async ({ uuid }) => json({ synced_at: getSyncedAt(db), media: getEntryMedia(db, uuid) }),
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
      json({ synced_at: getSyncedAt(db), results: onThisDay(db, month_day ?? todayMonthDay()) }),
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

  Bun.serve({
    port: Number(port),
    hostname: process.env.DAYONE_MCP_HOST ?? "0.0.0.0",
    fetch: async (req) => {
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
