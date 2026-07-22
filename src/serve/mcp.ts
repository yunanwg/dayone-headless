#!/usr/bin/env bun

/**
 * dayone-headless MCP server — read-only access to the local journal mirror over
 * stdio. Pure serving layer: it reads the SQLite mirror and knows nothing about
 * Day One, the network, or crypto. Every tool surfaces `synced_at` so an agent
 * knows how fresh the data is. Media BYTES are not served here (see docs); tools
 * return media metadata only.
 */

import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import { getEntry, getSyncedAt, listJournals, onThisDay, searchEntries } from "./queries.ts";

if (!existsSync(DEFAULT_MIRROR)) {
  console.error(`mirror not found at ${DEFAULT_MIRROR}. Run a sync first (bun run src/ingest/rest/sync.ts).`);
  process.exit(1);
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

const server = new McpServer(
  { name: "dayone-headless", version: "0.1.0" },
  {
    instructions:
      "Read-only access to a personal Day One journal mirror. Use search_entries or " +
      "on_this_day to find entries, then get_entry for full content. `synced_at` on each " +
      "result says how fresh the mirror is. This is READ-ONLY — you cannot create or edit entries.",
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
      "Full-text search over entry bodies. Returns matches (uuid, date, place, snippet), " +
      "highest-ranked first. Call get_entry with a uuid for the full entry.",
    inputSchema: {
      query: z.string().describe("FTS5 query, e.g. 'paris coffee' or 'trip NOT work'"),
      limit: z.number().int().min(1).max(100).default(25).describe("max results (default 25)"),
    },
    annotations: READ_ONLY,
  },
  async ({ query, limit }) => json({ synced_at: getSyncedAt(db), results: searchEntries(db, query, limit) }),
);

server.registerTool(
  "get_entry",
  {
    description: "Get one entry's full content + metadata by uuid (media is metadata-only).",
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

await server.connect(new StdioServerTransport());
console.error("dayone-headless MCP server ready (read-only, stdio)");
