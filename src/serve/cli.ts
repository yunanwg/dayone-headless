#!/usr/bin/env bun
/**
 * daytwo — the single entry point. Read commands query the local mirror; `sync`
 * refreshes it (REST ingester); `mcp` serves it over MCP; `doctor` self-checks.
 *
 *   daytwo sync                 fetch + decrypt + write the mirror (needs env)
 *   daytwo mcp                  run the read-only MCP server (stdio)
 *   daytwo doctor               check config + mirror health
 *   daytwo journals             list journals + counts + freshness
 *   daytwo search <q> [limit]   full-text search
 *   daytwo get <uuid>           one entry
 *   daytwo on-this-day [MM-DD]  entries for a month-day across years
 */

import { existsSync } from "node:fs";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import { getEntry, getSyncedAt, listJournals, onThisDay, searchEntries } from "./queries.ts";

function out(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function todayMonthDay(): string {
  const n = new Date();
  return `${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
function requireMirror() {
  if (!existsSync(DEFAULT_MIRROR)) {
    console.error(`no mirror at ${DEFAULT_MIRROR} — run \`daytwo sync\` first.`);
    process.exit(2);
  }
  return openMirror();
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "sync": {
    const { sync } = await import("../ingest/rest/sync.ts");
    const key = process.env.DAYONE_ENCRYPTION_KEY;
    if (!key) throw new Error("set DAYONE_ENCRYPTION_KEY (the D1-<userId>-<code…> encryption key)");
    const t0 = Date.now();
    const r = await sync(key, { onProgress: (m) => console.error(m) });
    console.error(
      `done in ${((Date.now() - t0) / 1000).toFixed(1)}s: +${r.changed} changed, -${r.removed} removed → mirror`,
    );
    break;
  }

  case "mcp": {
    await import("./mcp.ts"); // self-connects over stdio
    break;
  }

  case "doctor": {
    const { doctor } = await import("./doctor.ts");
    process.exit(await doctor());
    break;
  }

  case "journals": {
    const db = requireMirror();
    out({ synced_at: getSyncedAt(db), journals: listJournals(db) });
    db.close();
    break;
  }

  case "get": {
    const uuid = rest[0];
    if (!uuid) {
      console.error("usage: daytwo get <uuid>");
      process.exit(1);
    }
    const db = requireMirror();
    const entry = getEntry(db, uuid);
    db.close();
    if (!entry) {
      console.error(`no entry: ${uuid}`);
      process.exit(2);
    }
    out(entry);
    break;
  }

  case "search": {
    const query = rest[0];
    if (!query) {
      console.error("usage: daytwo search <query> [limit]");
      process.exit(1);
    }
    const db = requireMirror();
    out({
      synced_at: getSyncedAt(db),
      results: searchEntries(db, query, rest[1] ? Number(rest[1]) : undefined),
    });
    db.close();
    break;
  }

  case "on-this-day": {
    const db = requireMirror();
    out({ synced_at: getSyncedAt(db), results: onThisDay(db, rest[0] ?? todayMonthDay()) });
    db.close();
    break;
  }

  default:
    console.error(
      "commands: sync | mcp | doctor | journals | search <q> [limit] | get <uuid> | on-this-day [MM-DD]",
    );
    process.exit(cmd ? 1 : 0);
}
