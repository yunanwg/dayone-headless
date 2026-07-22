/**
 * Tier A mapper tests.
 *
 * Uses ONLY synthetic IndexedDB-shaped records constructed inline (snake_case,
 * epoch dates, 0/1 flags) — NEVER real journal content, per the project's
 * privacy rule. Asserts the crosswalk translations, then feeds the mapper output
 * through the REAL `importExport()` into an in-memory mirror as an integration
 * check.
 */

import { expect, test } from "bun:test";
import { mapStoresToExports } from "../src/ingest/browser/map.ts";
import { importExport } from "../src/ingest/json-export/import.ts";
import { openMirror } from "../src/serve/db/open.ts";
import { getEntry, listJournals, searchEntries } from "../src/serve/queries.ts";

// A fixed epoch (ms) and its known ISO value. The mapper strips milliseconds to
// match Day One's export format (`…00Z`, not `…00.000Z`) — recon Q5.
const CREATED_MS = 1_626_942_600_000;
const CREATED_ISO = "2021-07-22T08:30:00Z";
const EDITED_MS = 1_626_946_200_000;
const EDITED_ISO = "2021-07-22T09:30:00Z";

const PHOTO_ID = "PHOTOMOMENTID00000000000000000001";
const VIDEO_ID = "VIDEOMOMENTID00000000000000000001";
const AUDIO_ID = "AUDIOMOMENTID00000000000000000001";

/** One journal, one richly-populated entry, three moments (photo/video/audio). */
function makeStores(): { entries: any[]; moments: any[]; journals: any[] } {
  const journals: any[] = [{ id: "jrnl-1", name: "Personal" }];

  const entries: any[] = [
    {
      id: "ENTRY18CHARIDAA01", // 18-ish chars, IndexedDB id space
      journal_id: "jrnl-1",
      body: "# Morning\n\nSynthetic body text about a synthetic day.",
      rich_text_json: JSON.stringify({ meta: { version: 1 }, contents: [] }),
      date: CREATED_MS,
      edit_date: EDITED_MS,
      editing_time: 42,
      duration: 0,
      is_all_day: 0,
      is_pinned: 1,
      is_starred: 0,
      timezone: "Europe/Paris",
      location: {
        latitude: 48.8566,
        longitude: 2.3522,
        placeName: "Left Bank",
        region: "Île-de-France",
        localityName: "Paris",
        country: "France",
        administrativeArea: "IDF",
        route: "should be dropped",
      },
      weather: {
        code: "clear",
        description: "Clear",
        tempCelsius: 22.5,
        pressureMb: 1013,
        service: "SynthWeather",
        visibilityKm: 10,
        windSpeedKph: 12,
        windBearing: 180,
        moonPhase: 0.5,
        moonPhaseCode: "full",
        relativeHumidity: 55,
        sunriseDate: CREATED_MS,
        sunsetDate: EDITED_MS,
      },
    },
  ];

  const moments: any[] = [
    {
      id: PHOTO_ID,
      entry_id: "ENTRY18CHARIDAA01",
      type: "photo",
      content_type: "image/jpeg",
      md5_body: "0123456789abcdef0123456789abcdef",
      md5_envelope: "ffffffffffffffffffffffffffffffff",
      date: CREATED_MS,
      favorite: 1,
      is_sketch: 0,
      width: 4032,
      height: 3024,
      thumbnail_md5: "aaaa",
      metadata: { fileSize: 2_500_000, recordingDevice: "SynthCam" },
    },
    {
      id: VIDEO_ID,
      entry_id: "ENTRY18CHARIDAA01",
      type: "video",
      content_type: "video/mp4",
      md5_body: "abcdef0123456789abcdef0123456789",
      date: CREATED_MS,
      metadata: { duration: 12.5, fileSize: 9_000_000 },
    },
    {
      id: AUDIO_ID,
      entry_id: "ENTRY18CHARIDAA01",
      type: "audio",
      content_type: "audio/mp4",
      md5_body: "fedcba9876543210fedcba9876543210",
      date: CREATED_MS,
      metadata: { duration: 30, format: "m4a", audioChannels: 2, sampleRate: 44100 },
    },
    // A moment for a DIFFERENT entry that does not exist — must NOT attach here.
    {
      id: "ORPHANMOMENT0000000000000000000001",
      entry_id: "SOME-OTHER-ENTRY-XX",
      type: "photo",
      content_type: "image/png",
      md5_body: "11111111111111111111111111111111",
      date: CREATED_MS,
    },
  ];

  return { entries, moments, journals };
}

test("groups into one journal named from journals[].name", () => {
  const out = mapStoresToExports(makeStores());
  expect(out).toHaveLength(1);
  expect(out[0]!.journalName).toBe("Personal");
  expect(out[0]!.export.entries).toHaveLength(1);
});

test("field renames, epoch→ISO, and 0/1→boolean on the entry", () => {
  const entry = mapStoresToExports(makeStores())[0]!.export.entries[0]!;

  // Renames.
  expect(entry.text).toBe("# Morning\n\nSynthetic body text about a synthetic day.");
  expect(entry.richText).toBe(JSON.stringify({ meta: { version: 1 }, contents: [] }));
  expect(entry.timeZone).toBe("Europe/Paris");
  expect(entry.editingTime).toBe(42);

  // Epoch → ISO.
  expect(entry.creationDate).toBe(CREATED_ISO);
  expect(entry.modifiedDate).toBe(EDITED_ISO);

  // 0/1 → boolean.
  expect(entry.isPinned).toBe(true);
  expect(entry.starred).toBe(false);
  expect(entry.isAllDay).toBe(false);

  // Q1: uuid is the passthrough store id for now.
  expect(entry.uuid).toBe("ENTRY18CHARIDAA01");
});

test("weather sub-object renames and epoch→ISO", () => {
  const w = mapStoresToExports(makeStores())[0]!.export.entries[0]!.weather!;
  expect(w.weatherCode).toBe("clear");
  expect(w.conditionsDescription).toBe("Clear");
  expect(w.temperatureCelsius).toBe(22.5);
  expect(w.pressureMB).toBe(1013);
  expect(w.weatherServiceName).toBe("SynthWeather");
  expect(w.visibilityKM).toBe(10);
  expect(w.windSpeedKPH).toBe(12);
  // Passthrough.
  expect(w.windBearing).toBe(180);
  expect(w.moonPhase).toBe(0.5);
  expect(w.moonPhaseCode).toBe("full");
  expect(w.relativeHumidity).toBe(55);
  // Epoch weather dates → ISO.
  expect(w.sunriseDate).toBe(CREATED_ISO);
  expect(w.sunsetDate).toBe(EDITED_ISO);
  // No stray source keys leaked through.
  expect((w as unknown as Record<string, unknown>).code).toBeUndefined();
  expect((w as unknown as Record<string, unknown>).tempCelsius).toBeUndefined();
});

test("location maps 1:1 and drops `route`", () => {
  const loc = mapStoresToExports(makeStores())[0]!.export.entries[0]!.location!;
  expect(loc.latitude).toBe(48.8566);
  expect(loc.longitude).toBe(2.3522);
  expect(loc.placeName).toBe("Left Bank");
  expect(loc.localityName).toBe("Paris");
  expect(loc.country).toBe("France");
  expect(loc.administrativeArea).toBe("IDF");
  expect((loc as unknown as Record<string, unknown>).region).toBe("Île-de-France");
  // `route` has no export field — dropped.
  expect((loc as unknown as Record<string, unknown>).route).toBeUndefined();
});

test("moments group onto the right entry, split by kind", () => {
  const entry = mapStoresToExports(makeStores())[0]!.export.entries[0]!;
  expect(entry.photos).toHaveLength(1);
  expect(entry.videos).toHaveLength(1);
  expect(entry.audios).toHaveLength(1);
  // The orphan moment (entry_id for a non-existent entry) did not attach.
  const ids = [...(entry.photos ?? []), ...(entry.videos ?? []), ...(entry.audios ?? [])].map(
    (m) => m.identifier,
  );
  expect(ids).not.toContain("ORPHANMOMENT0000000000000000000001");
});

test("moment md5_body→md5, content_type→short type, flags, metadata flatten", () => {
  const entry = mapStoresToExports(makeStores())[0]!.export.entries[0]!;

  const photo = entry.photos![0]!;
  expect(photo.identifier).toBe(PHOTO_ID);
  expect(photo.md5).toBe("0123456789abcdef0123456789abcdef");
  expect(photo.type).toBe("jpeg"); // "image/jpeg" → "jpeg"
  expect(photo.favorite).toBe(true); // 1 → true
  expect((photo as { isSketch?: boolean }).isSketch).toBe(false); // 0 → false
  expect(photo.width).toBe(4032);
  expect(photo.height).toBe(3024);
  expect(photo.orderInEntry).toBe(0);
  // Metadata flattened onto the media object.
  expect(photo.fileSize).toBe(2_500_000);
  // Dropped: md5_envelope + thumbnail_* have no export equivalent.
  expect((photo as unknown as Record<string, unknown>).md5_envelope).toBeUndefined();
  expect((photo as unknown as Record<string, unknown>).thumbnail_md5).toBeUndefined();

  const video = entry.videos![0]!;
  expect(video.type).toBe("mp4"); // "video/mp4" → "mp4"
  expect(video.duration).toBe(12.5); // from metadata

  // Audio uses `format`, not `type`.
  const audio = entry.audios![0]!;
  expect(audio.format).toBe("m4a");
  expect((audio as unknown as Record<string, unknown>).audioChannels).toBe(2);
  expect((audio as unknown as Record<string, unknown>).sampleRate).toBe(44100);
});

test("already-ISO date strings are accepted (milliseconds normalized away)", () => {
  const stores = makeStores();
  stores.entries[0]!.date = "2020-01-01T00:00:00.000Z"; // already ISO, with ms
  const entry = mapStoresToExports(stores)[0]!.export.entries[0]!;
  expect(entry.creationDate).toBe("2020-01-01T00:00:00Z"); // ms stripped to match export
});

test("entries fan out into one export per journal", () => {
  const stores = makeStores();
  stores.journals.push({ id: "jrnl-2", name: "Work" });
  stores.entries.push({
    id: "ENTRY18CHARIDAA02",
    journal_id: "jrnl-2",
    body: "Second journal entry.",
    date: CREATED_MS,
    is_all_day: 0,
    is_pinned: 0,
    is_starred: 0,
    timezone: "UTC",
  });
  const out = mapStoresToExports(stores);
  expect(out.map((j) => j.journalName).sort()).toEqual(["Personal", "Work"]);
});

test("integration: mapper output imports into a real in-memory mirror", () => {
  const db = openMirror(":memory:", { writable: true });
  const mapped = mapStoresToExports(makeStores());
  for (const { journalName, export: exp } of mapped) {
    importExport(db, exp, journalName);
  }

  // listJournals reflects the imported journal with its entry count.
  const journals = listJournals(db);
  expect(journals).toHaveLength(1);
  expect(journals[0]!.name).toBe("Personal");
  expect(journals[0]!.entries).toBe(1);

  // getEntry round-trips the mapped entry via its (Q1 passthrough) uuid.
  const got = getEntry(db, "ENTRY18CHARIDAA01");
  expect(got).not.toBeNull();
  expect(got!.text).toBe("# Morning\n\nSynthetic body text about a synthetic day.");
  expect(got!.creationDate).toBe(CREATED_ISO);
  expect(got!.timeZone).toBe("Europe/Paris");

  // Media landed in the mirror (photo + video + audio = 3 rows).
  const mediaCount = (db.query("SELECT COUNT(*) n FROM media").get() as { n: number }).n;
  expect(mediaCount).toBe(3);

  // FTS search finds the body text.
  const hits = searchEntries(db, "synthetic");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.uuid).toBe("ENTRY18CHARIDAA01");

  db.close();
});
