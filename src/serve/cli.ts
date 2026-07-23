#!/usr/bin/env bun
/**
 * daytwo — the single entry point. Read commands query the local mirror; `sync`
 * refreshes it (REST ingester); `mcp` serves it over MCP; `doctor` self-checks.
 *
 *   daytwo sync                 fetch + decrypt + write the mirror (needs env)
 *   daytwo sync-loop            periodically sync (container internal command)
 *   daytwo media-fetch [uuid]   fetch + decrypt attachment BYTES into data/media
 *   daytwo mcp                  run the read-only MCP server (stdio)
 *   daytwo health-sync          check recorded sync outcome + freshness
 *   daytwo health-mcp           probe canonical HTTP MCP readiness
 *   daytwo doctor               check config + mirror health
 *   daytwo doctor --fix-permissions  tighten existing local plaintext paths
 *   daytwo sync-status          show last attempt + last complete sync state
 *   daytwo journals             list journals + counts + freshness
 *   daytwo stats <group_by>     corpus map: counts/text volume by year|month|journal
 *   daytwo sample [target] [filters]  metadata-only longitudinal evidence plan
 *   daytwo search <q> [limit]   full-text search (CJK-capable)
 *   daytwo list [filters]       structured browse (see flags below)
 *   daytwo tags                 all tags with entry counts
 *   daytwo get <uuid>           one entry (curated; --rich-text / --raw to add heavy fields)
 *   daytwo media <uuid>         media metadata attached to an entry
 *   daytwo media-file <id>      resolve a media identifier to its cached bytes path
 *   daytwo on-this-day [MM-DD]  entries for a month-day across years
 *
 * `list` (and `search` / `stats` / `sample`) filters (all optional, ANDed):
 *   --journal <name> --tag <name> --starred --from <ISO> --to <ISO>
 *   --place <substr> --limit <n> --offset <n>
 *   --include-text --max-chars-per-entry <n> --max-total-chars <n> (list only)
 *   --order-by date|length|editing_time (list only)
 */

import { existsSync } from "node:fs";
import { boundedPositiveInteger, SYNC_INTERVAL_BOUNDS } from "../runtime-config.ts";
import { requireSecret } from "../secret-config.ts";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import { SnapshotValidationError, sampleEntries } from "./evidence.ts";
import {
  getEntry,
  getEntryMedia,
  getFreshness,
  getStats,
  getSyncStatus,
  InvalidSearchQueryError,
  type ListFilters,
  listEntriesPage,
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

async function runSyncOnce(): Promise<void> {
  const { sync } = await import("../ingest/rest/sync.ts");
  const key = requireSecret("DAYONE_ENCRYPTION_KEY");
  const t0 = Date.now();
  const result = await sync(key, { onProgress: (message) => console.error(message) });
  console.error(
    `done in ${((Date.now() - t0) / 1000).toFixed(1)}s: +${result.changed} changed, ` +
      `-${result.removed} removed, ${result.failed} failed → mirror ` +
      `(${result.status}; last complete ${result.lastCompleteAt ?? "never"})`,
  );
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
      case "--max-chars-per-entry":
        f.max_chars_per_entry = Number(argv[++i]);
        break;
      case "--max-total-chars":
        f.max_total_chars = Number(argv[++i]);
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
    await runSyncOnce();
    break;
  }

  case "sync-loop": {
    const intervalSeconds = boundedPositiveInteger(
      "DAYONE_SYNC_INTERVAL",
      process.env.DAYONE_SYNC_INTERVAL,
      SYNC_INTERVAL_BOUNDS,
    );
    while (true) {
      try {
        await runSyncOnce();
      } catch {
        console.error("sync failed; retrying next cycle");
      }
      await Bun.sleep(intervalSeconds * 1000);
    }
    break;
  }

  case "health-sync": {
    const { syncReadiness } = await import("./health.ts");
    const result = syncReadiness();
    console.error(`${result.ready ? "ready" : "not ready"}: ${result.detail}`);
    process.exit(result.ready ? 0 : 1);
    break;
  }

  case "health-mcp": {
    const { mcpHttpReadiness } = await import("./health.ts");
    const result = await mcpHttpReadiness();
    console.error(`${result.ready ? "ready" : "not ready"}: ${result.detail}`);
    process.exit(result.ready ? 0 : 1);
    break;
  }

  case "media-fetch": {
    const { syncMedia } = await import("../ingest/rest/media.ts");
    const key = requireSecret("DAYONE_ENCRYPTION_KEY");
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
    const unknown = rest.filter((arg) => arg !== "--fix-permissions" && arg !== "--serving");
    if (unknown.length) {
      console.error(`unknown doctor option: ${unknown[0]}`);
      process.exit(1);
    }
    process.exit(
      await doctor({
        fixPermissions: rest.includes("--fix-permissions"),
        servingOnly: rest.includes("--serving"),
      }),
    );
    break;
  }

  case "sync-status": {
    const db = requireMirror();
    out(getSyncStatus(db));
    db.close();
    break;
  }

  case "journals": {
    const db = requireMirror();
    out({ ...getFreshness(db), journals: listJournals(db) });
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
    out({ ...getFreshness(db), ...getStats(db, groupBy, parseListFilters(rest.slice(1))) });
    db.close();
    break;
  }

  case "sample": {
    let target: number | undefined;
    let bestEffort = false;
    const filters: ListFilters = {};
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--best-effort") {
        bestEffort = true;
      } else if (arg === "--target") {
        const value = rest[++i];
        if (value === undefined) {
          console.error("--target requires a value");
          process.exit(1);
        }
        target = Number(value);
      } else if (arg === "--journal") {
        filters.journal = rest[++i];
      } else if (arg === "--tag") {
        filters.tag = rest[++i];
      } else if (arg === "--starred") {
        filters.starred = true;
      } else if (arg === "--from") {
        filters.from = rest[++i];
      } else if (arg === "--to") {
        filters.to = rest[++i];
      } else if (arg === "--place") {
        filters.place = rest[++i];
      } else if (!arg.startsWith("--") && target === undefined) {
        target = Number(arg);
      } else {
        console.error(`unknown sample option: ${arg}`);
        process.exit(1);
      }
    }
    const db = requireMirror();
    try {
      out(
        sampleEntries(db, {
          target,
          mode: bestEffort ? "best_effort" : "complete_only",
          ...filters,
        }),
      );
    } catch (error) {
      if (error instanceof SnapshotValidationError) {
        console.error(`${error.code}: ${error.message}`);
        db.close();
        process.exit(2);
      }
      throw error;
    }
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
      out({ ...getFreshness(db), results: searchEntries(db, query, filters) });
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
    out({ ...getFreshness(db), ...listEntriesPage(db, parseListFilters(rest)) });
    db.close();
    break;
  }

  case "tags": {
    const db = requireMirror();
    out({ ...getFreshness(db), tags: listTags(db) });
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
    out({ ...getFreshness(db), media: getEntryMedia(db, uuid) });
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
    out({ ...getFreshness(db), results: onThisDay(db, rest[0] ?? todayMonthDay()) });
    db.close();
    break;
  }

  default:
    console.error(
      "commands: sync | sync-loop | sync-status | media-fetch [uuid] | mcp | health-sync | health-mcp | doctor | journals | stats <year|month|journal> | sample [target] [--best-effort] | search <q> [limit] | list [filters] | tags | get <uuid> | media <uuid> | media-file <id> | on-this-day [MM-DD]",
    );
    process.exit(cmd ? 1 : 0);
}
