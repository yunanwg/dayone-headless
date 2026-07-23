#!/usr/bin/env bun
/**
 * daytwo — the single entry point. Read commands query the local mirror; `sync`
 * refreshes it (REST ingester); `mcp` serves it over MCP; `doctor` self-checks.
 *
 *   daytwo sync                 fetch + decrypt + write the mirror (needs env)
 *   daytwo media-fetch [uuid]   fetch + decrypt attachment BYTES into data/media
 *   daytwo mcp                  run the read-only MCP server (stdio)
 *   daytwo doctor               check config + mirror health
 *   daytwo journals             list journals + counts + freshness
 *   daytwo stats <group_by>     corpus map: counts/text volume by year|month|journal
 *   daytwo search <q> [limit]   full-text search (CJK-capable)
 *   daytwo list [filters]       structured browse (see flags below)
 *   daytwo tags                 all tags with entry counts
 *   daytwo get <uuid>           one entry (curated; --rich-text / --raw to add heavy fields)
 *   daytwo media <uuid>         media metadata attached to an entry
 *   daytwo media-file <id>      resolve a media identifier to its cached bytes path
 *   daytwo on-this-day [MM-DD]  entries for a month-day across years
 *
 * `list` (and `search` / `stats`) filters (all optional, ANDed):
 *   --journal <name> --tag <name> --starred --from <ISO> --to <ISO>
 *   --place <substr> --limit <n> --offset <n>
 *   --include-text (list only)  --order-by date|length|editing_time (list only)
 */

import { existsSync } from "node:fs";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import {
  getEntry,
  getEntryMedia,
  getStats,
  getSyncedAt,
  InvalidSearchQueryError,
  type ListFilters,
  listEntries,
  listJournals,
  listTags,
  onThisDay,
  resolveMedia,
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
      case "--include-text":
        f.include_text = true;
        break;
      case "--order-by": {
        const v = argv[++i];
        if (v !== "date" && v !== "length" && v !== "editing_time") {
          console.error("--order-by must be one of: date | length | editing_time");
          process.exit(1);
        }
        f.order_by = v;
        break;
      }
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

  case "media-fetch": {
    const { syncMedia } = await import("../ingest/rest/media.ts");
    const key = process.env.DAYONE_ENCRYPTION_KEY;
    if (!key) throw new Error("set DAYONE_ENCRYPTION_KEY (the D1-<userId>-<code…> encryption key)");
    // `media-fetch <uuid>` scopes to one entry; `--limit N` caps new downloads.
    const uuid = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    const li = rest.indexOf("--limit");
    const limit = li >= 0 ? Number(rest[li + 1]) : undefined;
    const t0 = Date.now();
    const s = await syncMedia(key, { entryUuid: uuid, limit, onProgress: (m) => console.error(m) });
    console.error(
      `done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${s.fetched} fetched, ${s.alreadyCached} cached, ` +
        `${s.md5Mismatch} md5-mismatch, ${s.failed} failed of ${s.total} media → data/media`,
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
      console.error("usage: daytwo get <uuid> [--rich-text] [--raw]");
      process.exit(1);
    }
    const db = requireMirror();
    const entry = getEntry(db, uuid, {
      includeRichText: rest.includes("--rich-text"),
      includeRaw: rest.includes("--raw"),
    });
    db.close();
    if (!entry) {
      console.error(`no entry: ${uuid}`);
      process.exit(2);
    }
    out(entry);
    break;
  }

  case "stats": {
    const groupBy = rest[0];
    if (groupBy !== "year" && groupBy !== "month" && groupBy !== "journal") {
      console.error("usage: daytwo stats <year|month|journal> [filters]");
      process.exit(1);
    }
    const db = requireMirror();
    out({ synced_at: getSyncedAt(db), ...getStats(db, groupBy, parseListFilters(rest.slice(1))) });
    db.close();
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
    try {
      out({ synced_at: getSyncedAt(db), results: searchEntries(db, query, filters) });
    } catch (err) {
      if (err instanceof InvalidSearchQueryError) {
        console.error(err.message);
        db.close();
        process.exit(2);
      }
      throw err;
    }
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

  case "media-file": {
    const identifier = rest[0];
    if (!identifier) {
      console.error("usage: daytwo media-file <identifier>");
      process.exit(1);
    }
    const db = requireMirror();
    const media = resolveMedia(db, identifier);
    db.close();
    if (!media) {
      console.error(`no media: ${identifier}`);
      process.exit(2);
    }
    out(media); // { identifier, md5, kind, type, cached, path }
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
      "commands: sync | media-fetch [uuid] | mcp | doctor | journals | stats <year|month|journal> | search <q> [limit] | list [filters] | tags | get <uuid> | media <uuid> | media-file <id> | on-this-day [MM-DD]",
    );
    process.exit(cmd ? 1 : 0);
}
