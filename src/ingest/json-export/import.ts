/**
 * Ingestion — JSON export importer.
 *
 * The simplest possible ingester: reads a hand-exported Day One JSON file and
 * writes it into the mirror. It shares the mirror contract with the fancy
 * (Tier A/C) ingesters but needs no Day One, browser, or crypto — so Phase 1
 * (serving layer) can be validated end-to-end against real data today.
 *
 * Usage:  bun run src/ingest/json-export/import.ts <export.json> [journalName]
 */

import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import { openMirror } from "../../serve/db/open.ts";
import type { DayOneExport, DayOneEntry, DayOneMedia } from "../../types.ts";

interface ImportStats {
  journal: string;
  entries: number;
  media: number;
  tags: number;
}

export function importExport(
  db: Database,
  data: DayOneExport,
  journalName: string,
): ImportStats {
  const insertJournal = db.query(
    `INSERT INTO journal (name, export_version) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET export_version = excluded.export_version
     RETURNING id`,
  );
  const journalId = (
    insertJournal.get(journalName, data.metadata?.version ?? null) as { id: number }
  ).id;

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
      creation_date = excluded.creation_date, modified_date = excluded.modified_date,
      text = excluded.text, rich_text = excluded.rich_text, raw = excluded.raw
  `);
  const insertTag = db.query(
    `INSERT INTO tag (name) VALUES (?) ON CONFLICT(name) DO NOTHING RETURNING id`,
  );
  const getTagId = db.query(`SELECT id FROM tag WHERE name = ?`);
  const linkTag = db.query(
    `INSERT INTO entry_tag (entry_uuid, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
  );
  const insertMedia = db.query(`
    INSERT INTO media (identifier, entry_uuid, kind, md5, type, order_in_entry, raw)
    VALUES ($identifier, $entry_uuid, $kind, $md5, $type, $order_in_entry, $raw)
    ON CONFLICT(identifier) DO UPDATE SET raw = excluded.raw
  `);
  const insertFts = db.query(`INSERT INTO entry_fts (uuid, text) VALUES (?, ?)`);

  const stats: ImportStats = { journal: journalName, entries: 0, media: 0, tags: 0 };
  const tagsSeen = new Set<string>();

  const run = db.transaction((entries: DayOneEntry[]) => {
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
        $pinned: e.pinned ? 1 : 0,
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

      if (e.text) insertFts.run(e.uuid, e.text);

      for (const name of e.tags ?? []) {
        insertTag.run(name);
        const tagId = (getTagId.get(name) as { id: number }).id;
        linkTag.run(e.uuid, tagId);
        if (!tagsSeen.has(name)) { tagsSeen.add(name); stats.tags++; }
      }

      const kinds: [keyof DayOneEntry, string][] = [
        ["photos", "photo"], ["videos", "video"],
        ["audios", "audio"], ["pdfAttachments", "pdf"],
      ];
      for (const [field, kind] of kinds) {
        for (const m of (e[field] as DayOneMedia[] | undefined) ?? []) {
          insertMedia.run({
            $identifier: m.identifier,
            $entry_uuid: e.uuid,
            $kind: kind,
            $md5: m.md5 ?? null,
            $type: m.type ?? null,
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
