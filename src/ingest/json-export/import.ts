/**
 * Ingestion — JSON export importer.
 *
 * The simplest possible ingester: reads a hand-exported Day One JSON file and
 * writes it into the mirror. It shares the mirror contract with the fancy
 * (the browser ingester/C) ingesters but needs no Day One, browser, or crypto — so Phase 1
 * (serving layer) can be validated end-to-end against real data today.
 *
 * Usage:  bun run src/ingest/json-export/import.ts <export.json> [journalName]
 */

import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { isValidMd5 } from "../../media-cache.ts";
import { openMirror } from "../../serve/db/open.ts";
import type { DayOneEntry, DayOneExport, DayOneMedia } from "../../types.ts";

interface ImportStats {
  journal: string;
  entries: number;
  media: number;
  tags: number;
}

export function importExport(db: Database, data: DayOneExport, journalName: string): ImportStats {
  const insertJournal = db.query(
    `INSERT INTO journal (name, export_version) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET export_version = excluded.export_version
     RETURNING id`,
  );
  const journalId = (insertJournal.get(journalName, data.metadata?.version ?? null) as { id: number }).id;

  const insertEntry = db.query(`
    INSERT INTO entry (
      uuid, journal_id, creation_date, modified_date, time_zone,
      text, rich_text, starred, pinned, is_all_day, editing_time,
      latitude, longitude, place_name, locality_name, country,
      weather_code, temperature_c, raw
    ) VALUES (
      $uuid, $journal_id, $creation_date, $modified_date, $time_zone,
      $text, $rich_text, $starred, $pinned, $is_all_day, $editing_time,
      $latitude, $longitude, $place_name, $locality_name, $country,
      $weather_code, $temperature_c, $raw
    )
    ON CONFLICT(uuid) DO UPDATE SET
      journal_id = excluded.journal_id,
      creation_date = excluded.creation_date,
      modified_date = excluded.modified_date,
      time_zone = excluded.time_zone,
      text = excluded.text,
      rich_text = excluded.rich_text,
      starred = excluded.starred,
      pinned = excluded.pinned,
      is_all_day = excluded.is_all_day,
      editing_time = excluded.editing_time,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      place_name = excluded.place_name,
      locality_name = excluded.locality_name,
      country = excluded.country,
      weather_code = excluded.weather_code,
      temperature_c = excluded.temperature_c,
      raw = excluded.raw
  `);
  const insertTag = db.query(`INSERT INTO tag (name) VALUES (?) ON CONFLICT(name) DO NOTHING RETURNING id`);
  const getTagId = db.query(`SELECT id FROM tag WHERE name = ?`);
  const linkTag = db.query(`INSERT INTO entry_tag (entry_uuid, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING`);
  const insertMedia = db.query(`
    INSERT INTO media (identifier, entry_uuid, kind, md5, type, order_in_entry, raw)
    VALUES ($identifier, $entry_uuid, $kind, $md5, $type, $order_in_entry, $raw)
    ON CONFLICT(identifier) DO UPDATE SET
      entry_uuid = excluded.entry_uuid,
      kind = excluded.kind,
      md5 = excluded.md5,
      type = excluded.type,
      order_in_entry = excluded.order_in_entry,
      raw = excluded.raw
  `);
  const insertFts = db.query(`INSERT INTO entry_fts (uuid, text) VALUES (?, ?)`);
  // uuid is intentionally UNINDEXED in the FTS table, so deleting once per
  // entry would scan the whole table once per imported row. Pass the target
  // UUIDs through SQLite's built-in JSON table function and clear them in one
  // scan. This remains safe for partial imports: only UUIDs in this batch match.
  const clearFtsForEntries = db.query(`
    DELETE FROM entry_fts
    WHERE uuid IN (SELECT value FROM json_each(?))
  `);
  // Duplicate UUIDs are invalid export input, but retain the previous
  // last-occurrence-wins behaviour without penalising normal unique batches.
  const delFts = db.query(`DELETE FROM entry_fts WHERE uuid = ?`);
  const delMedia = db.query(`DELETE FROM media WHERE entry_uuid = ?`);
  const delEntryTags = db.query(`DELETE FROM entry_tag WHERE entry_uuid = ?`);

  const stats: ImportStats = { journal: journalName, entries: 0, media: 0, tags: 0 };
  const tagsSeen = new Set<string>();
  // Resolved tag ids for this import run: most tags recur across many entries,
  // so cache each name's id after its first insertTag+getTagId instead of
  // re-querying on every occurrence.
  const tagIdCache = new Map<string, number>();

  const run = db.transaction((entries: DayOneEntry[]) => {
    if (entries.length > 0) {
      clearFtsForEntries.run(JSON.stringify(entries.map((entry) => entry.uuid)));
    }
    const ftsUuidsSeen = new Set<string>();

    // Clear media for every imported entry before inserting any replacement.
    // An identifier can move between entries; deleting per-entry during the
    // insertion pass would make the result depend on export order.
    for (const e of entries) delMedia.run(e.uuid);

    for (const e of entries) {
      insertEntry.run({
        $uuid: e.uuid,
        $journal_id: journalId,
        $creation_date: e.creationDate,
        $modified_date: e.modifiedDate ?? null,
        $time_zone: e.timeZone ?? null,
        $text: e.text ?? null,
        $rich_text: e.richText ?? null,
        $starred: e.starred ? 1 : 0,
        $pinned: e.isPinned ? 1 : 0,
        $is_all_day: e.isAllDay ? 1 : 0,
        $editing_time: e.editingTime ?? null,
        $latitude: e.location?.latitude ?? null,
        $longitude: e.location?.longitude ?? null,
        $place_name: e.location?.placeName ?? null,
        $locality_name: e.location?.localityName ?? null,
        $country: e.location?.country ?? null,
        $weather_code: e.weather?.weatherCode ?? null,
        $temperature_c: e.weather?.temperatureCelsius ?? null,
        $raw: JSON.stringify(e),
      });
      stats.entries++;

      if (ftsUuidsSeen.has(e.uuid)) delFts.run(e.uuid);
      else ftsUuidsSeen.add(e.uuid);
      if (e.text) insertFts.run(e.uuid, e.text);

      delEntryTags.run(e.uuid);
      for (const name of e.tags ?? []) {
        let tagId = tagIdCache.get(name);
        if (tagId === undefined) {
          insertTag.run(name);
          tagId = (getTagId.get(name) as { id: number }).id;
          tagIdCache.set(name, tagId);
        }
        linkTag.run(e.uuid, tagId);
        if (!tagsSeen.has(name)) {
          tagsSeen.add(name);
          stats.tags++;
        }
      }

      const kinds: [keyof DayOneEntry, string][] = [
        ["photos", "photo"],
        ["videos", "video"],
        ["audios", "audio"],
        ["pdfAttachments", "pdf"],
      ];
      for (const [field, kind] of kinds) {
        for (const m of (e[field] as DayOneMedia[] | undefined) ?? []) {
          insertMedia.run({
            $identifier: m.identifier,
            $entry_uuid: e.uuid,
            $kind: kind,
            $md5: isValidMd5(m.md5) ? m.md5 : null,
            $type: m.type ?? m.format ?? null,
            $order_in_entry: m.orderInEntry ?? null,
            $raw: JSON.stringify(m),
          });
          stats.media++;
        }
      }
    }
  });

  run(data.entries ?? []);
  return stats;
}

if (import.meta.main) {
  const [file, journalArg] = process.argv.slice(2);
  if (!file) {
    console.error("usage: bun run src/ingest/json-export/import.ts <export.json> [journalName]");
    process.exit(1);
  }
  const journalName = journalArg ?? basename(file).replace(/\.json$/i, "");
  const data = (await Bun.file(file).json()) as DayOneExport;
  const db = openMirror(undefined, { writable: true });
  const stats = importExport(db, data, journalName);
  db.close();
  console.error(
    `imported "${stats.journal}": ${stats.entries} entries, ${stats.media} media, ${stats.tags} tags`,
  );
}
