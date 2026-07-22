#!/usr/bin/env bun
/**
 * dayone — read-only CLI over the local mirror.
 *
 * Thin wrapper over src/serve/queries.ts. The MCP server (later) will expose the
 * same functions as tools; keeping all logic in queries.ts keeps them in sync.
 *
 *   dayone journals
 *   dayone get <uuid>
 *   dayone search <query> [limit]
 *   dayone on-this-day [MM-DD]
 */

import { openMirror } from "./db/open.ts";
import { listJournals, getEntry, searchEntries, onThisDay } from "./queries.ts";

function todayMonthDay(): string {
  // Local date, "MM-DD".
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

const [cmd, ...rest] = process.argv.slice(2);
const db = openMirror();

switch (cmd) {
  case "journals":
    out(listJournals(db));
    break;
  case "get": {
    const uuid = rest[0];
    if (!uuid) { console.error("usage: dayone get <uuid>"); process.exit(1); }
    const entry = getEntry(db, uuid);
    if (!entry) { console.error(`no entry: ${uuid}`); process.exit(2); }
    out(entry);
    break;
  }
  case "search": {
    const query = rest[0];
    if (!query) { console.error("usage: dayone search <query> [limit]"); process.exit(1); }
    out(searchEntries(db, query, rest[1] ? Number(rest[1]) : undefined));
    break;
  }
  case "on-this-day":
    out(onThisDay(db, rest[0] ?? todayMonthDay()));
    break;
  default:
    console.error(
      "commands: journals | get <uuid> | search <query> [limit] | on-this-day [MM-DD]",
    );
    process.exit(1);
}

db.close();
