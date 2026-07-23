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
 *   daytwo list [filters]       structured browse (see flags below)
 *   daytwo tags                 all tags with entry counts
 *   daytwo get <uuid>           one entry
 *   daytwo media <uuid>         media metadata attached to an entry
 *   daytwo on-this-day [MM-DD]  entries for a month-day across years
 *
 * `list` filters (all optional, ANDed):
 *   --journal <name> --tag <name> --starred --from <ISO> --to <ISO>
 *   --place <substr> --limit <n> --offset <n>
 */

import { existsSync } from "node:fs";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import {
  getEntry,
  getEntryMedia,
  getSyncedAt,
  type ListFilters,
  listEntries,
  listJournals,
  listTags,
  onThisDay,
  searchEntries,
} from "./queries.ts";

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

/** Parse `--key value` / `--flag` pairs into the listEntries filter shape. */
function parseListFilters(argv: string[]): ListFilters {
  const f: ListFilters = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--journal":
        f.journal = argv[++i];
        break;
      case "--tag":
        f.tag = argv[++i];
        break;
      case "--starred":
        f.starred = true;
        break;
      case "--from":
        f.from = argv[++i];
        break;
      case "--to":
        f.to = argv[++i];
        break;
      case "--place":
        f.place = argv[++i];
        break;
      case "--limit":
        f.limit = Number(argv[++i]);
        break;
      case "--offset":
        f.offset = Number(argv[++i]);
        break;
      default:
        console.error(`unknown flag for list: ${a}`);
        process.exit(1);
    }
  }
  return f;
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
      console.error("usage: daytwo search <query> [limit] [filters]");
      process.exit(1);
    }
    // Legacy positional limit (`search <q> 10`) still works; the same --flags as
    // `list` narrow the search, and --limit overrides a positional if both given.
    const after = rest.slice(1);
    const filters: ListFilters = {};
    const rangeArgs = after[0] !== undefined && /^\d+$/.test(after[0]) ? after.slice(1) : after;
    if (after[0] !== undefined && /^\d+$/.test(after[0])) filters.limit = Number(after[0]);
    Object.assign(filters, parseListFilters(rangeArgs));
    const db = requireMirror();
    out({ synced_at: getSyncedAt(db), results: searchEntries(db, query, filters) });
    db.close();
    break;
  }

  case "list": {
    const db = requireMirror();
    out({ synced_at: getSyncedAt(db), results: listEntries(db, parseListFilters(rest)) });
    db.close();
    break;
  }

  case "tags": {
    const db = requireMirror();
    out({ synced_at: getSyncedAt(db), tags: listTags(db) });
    db.close();
    break;
  }

  case "media": {
    const uuid = rest[0];
    if (!uuid) {
      console.error("usage: daytwo media <uuid>");
      process.exit(1);
    }
    const db = requireMirror();
    out({ synced_at: getSyncedAt(db), media: getEntryMedia(db, uuid) });
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
      "commands: sync | mcp | doctor | journals | search <q> [limit] | list [filters] | tags | get <uuid> | media <uuid> | on-this-day [MM-DD]",
    );
    process.exit(cmd ? 1 : 0);
}
