/**
 * Browser → export mapper â IndexedDB (`DODexie`) stores â export-shaped `DayOneExport`.
 *
 * The Day One web app caches DECRYPTED plaintext in IndexedDB. the browser ingester
 * extracts four Dexie object stores (`entries`, `moments`, `journals`, `tags`)
 * and this module TRANSLATES them into the JSON-export shape (`DayOneExport`,
 * see `src/types.ts`) so the existing `importExport()` writes them to the mirror
 * unchanged — no crypto, no browser code here.
 *
 * This file is PURE and testable: it takes already-parsed JS objects (arrays of
 * IndexedDB-shaped records) and returns export objects. The browser/CDP
 * extraction that produces those arrays is a separate adapter.
 *
 * The crosswalk this implements verbatim: `docs/browser-crosswalk.md`.
 *
 * Encoding rules applied throughout:
 *   - case:     IndexedDB is snake_case; the export is camelCase.
 *   - dates:    epoch-ms (true UTC) → ISO-8601 UTC, milliseconds stripped to
 *               match the export's `…14Z` format (recon Q5).
 *   - booleans: IndexedDB 0/1 numbers → real booleans.
 *   - deletes:  `entries.is_deleted` rows are excluded (recon Q2).
 */

import type {
  DayOneEntry,
  DayOneExport,
  DayOneLocation,
  DayOneMedia,
  DayOnePhoto,
  DayOneWeather,
} from "../../types.ts";

/** Loose IndexedDB record — the extraction adapter hands us untyped objects. */
type Rec = Record<string, any>;

export interface MappedJournal {
  journalName: string;
  export: DayOneExport;
}

/**
 * The one unresolved mapping, isolated so the rest of the mapper is independent
 * of it. The IndexedDB `entries.id` (18 chars) and the JSON-export `uuid` (32 hex)
 * are different id spaces with no known crosswalk, so we pass the store id through
 * verbatim: the mirror stays internally consistent (entry↔media FKs still join)
 * but a browser-ingested mirror is not byte-identical to the export by uuid.
 * (The REST ingester does not have this problem — its feed carries the 32-hex uuid.)
 */
function deriveUuid(entryRecord: Rec): string {
  // TODO: confirm the web-id ↔ export-uuid mapping; identity is content-based for now.
  return entryRecord.id;
}

/**
 * ISO-8601 UTC WITHOUT milliseconds — matches Day One's export format, which
 * writes `2024-09-03T05:39:14Z`, not `…14.000Z` (recon Q5, verified against the
 * real export). Byte-identical conformance depends on this.
 */
function isoNoMs(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Epoch-number (ms) → ISO-8601 UTC string, defensively. `entries.date` /
 * `edit_date` are epoch ms in true UTC (recon Q5). Strings that are already
 * ISO-ish pass through (with any `.mmm` stripped); all-digit strings are treated
 * as epoch ms. `null`/`undefined`/unparseable → `undefined`.
 */
function toIso(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    return isoNoMs(new Date(v));
  }
  if (typeof v === "string") {
    if (v === "") return undefined;
    if (/^\d+$/.test(v)) return isoNoMs(new Date(Number(v)));
    return v.replace(/\.\d{3}Z$/, "Z"); // already ISO — normalize ms away
  }
  return undefined;
}

/** IndexedDB 0/1 (or genuine bool / "0"/"1") → boolean. */
function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1";
}

/**
 * `entries.location` → `DayOneLocation`.
 *
 * `latitude`, `longitude`, `placeName`, `region`, `localityName`, `country`,
 * `administrativeArea` map 1:1 (identical names).
 *
 * `route` has NO export equivalent — dropped on purpose (documented here rather
 * than silently). Export-only fields (`altitude`, `timeZoneName`, `userLabel`)
 * are simply absent from the source, so they stay absent.
 */
function mapLocation(loc: Rec | null | undefined): DayOneLocation | undefined {
  if (loc == null || typeof loc !== "object") return undefined;
  const out: Record<string, unknown> = {};
  // 1:1 passthrough keys (same name in IndexedDB and the export).
  for (const k of [
    "latitude",
    "longitude",
    "placeName",
    "region",
    "localityName",
    "country",
    "administrativeArea",
    // export-only extras kept if the source happens to carry them:
    "altitude",
    "timeZoneName",
    "userLabel",
  ]) {
    if (loc[k] !== undefined) out[k] = loc[k];
  }
  // `loc.route` intentionally dropped — no export field for it.
  return out as unknown as DayOneLocation;
}

/**
 * `entries.weather` → `DayOneWeather` (several keys are RENAMED, not 1:1).
 * epoch `sunriseDate`/`sunsetDate` → ISO.
 */
function mapWeather(w: Rec | null | undefined): DayOneWeather | undefined {
  if (w == null || typeof w !== "object") return undefined;
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };

  // Renamed keys.
  put("weatherCode", w.code);
  put("conditionsDescription", w.description);
  put("temperatureCelsius", w.tempCelsius);
  put("pressureMB", w.pressureMb);
  put("weatherServiceName", w.service);
  put("visibilityKM", w.visibilityKm);
  put("windSpeedKPH", w.windSpeedKph);

  // Passthrough keys (identical names).
  put("windBearing", w.windBearing);
  put("moonPhase", w.moonPhase);
  put("moonPhaseCode", w.moonPhaseCode);
  put("relativeHumidity", w.relativeHumidity);

  // Epoch → ISO.
  put("sunriseDate", toIso(w.sunriseDate));
  put("sunsetDate", toIso(w.sunsetDate));

  return out as unknown as DayOneWeather;
}

/** Which export bucket a moment belongs to, from its `type` discriminator. */
type MediaKind = "photos" | "videos" | "audios";

function momentKind(m: Rec): MediaKind {
  const t = String(m.type ?? "").toLowerCase();
  if (t === "video") return "videos";
  if (t === "audio") return "audios";
  if (t === "photo" || t === "image") return "photos";
  // Fallback to the MIME major type when `type` is unexpected/missing.
  const major = String(m.content_type ?? "")
    .split("/")[0]
    ?.toLowerCase();
  if (major === "video") return "videos";
  if (major === "audio") return "audios";
  return "photos";
}

/**
 * Short export `type` ("jpeg", "mp4", …) from a MIME `content_type`
 * ("image/jpeg"), falling back to the store `type` when there is no MIME.
 */
function deriveMediaType(m: Rec): string | undefined {
  const ct = m.content_type;
  if (typeof ct === "string" && ct.includes("/")) {
    const subtype = ct.split("/")[1];
    if (subtype) return subtype;
  }
  return typeof m.type === "string" ? m.type : undefined;
}

/**
 * `moments` record → export media object (`DayOneMedia` / `DayOnePhoto`).
 *
 * - `id` → `identifier` (referenced in body as `dayone-moment://<identifier>`)
 * - `md5_body` → `md5` (the on-disk file is `<md5>.<type>`)
 * - `date` epoch → ISO
 * - `favorite`, `is_sketch` 0/1 → boolean
 * - `metadata.{duration,fileSize,location,audioChannels,format,recordingDevice,
 *   sampleRate,…}` is FLATTENED onto the media object.
 *
 * Dropped (no export equivalent): `md5_envelope`, `thumbnail_*`, `entry_id`
 * (it is the join key, surfaced structurally as the array the media lives in).
 */
function mapMoment(m: Rec, orderInEntry: number): DayOneMedia | DayOnePhoto {
  const kind = momentKind(m);
  const out: Record<string, unknown> = {};

  // Flatten metadata FIRST so explicit fields below win on any collision.
  const meta = m.metadata;
  if (meta != null && typeof meta === "object") {
    for (const [k, v] of Object.entries(meta as Rec)) {
      if (v === undefined) continue;
      // A nested location inside metadata is normalized like an entry location
      // (drops `route`, keeps the export-shaped keys).
      out[k] = k === "location" ? mapLocation(v as Rec) : v;
    }
  }

  out.identifier = m.id;
  if (m.md5_body !== undefined) out.md5 = m.md5_body;

  const type = deriveMediaType(m);
  if (type !== undefined) {
    // Audio carries `format` (from metadata) rather than `type`; for photos and
    // videos the short subtype is the on-disk extension.
    if (kind === "audios") {
      // keep whatever metadata.format already set; only fill if absent.
      if (out.format === undefined) out.format = type;
    } else {
      out.type = type;
    }
  }

  const date = toIso(m.date);
  if (date !== undefined) out.date = date;
  if (m.favorite !== undefined) out.favorite = toBool(m.favorite);
  if (m.width !== undefined) out.width = m.width;
  if (m.height !== undefined) out.height = m.height;
  out.orderInEntry = orderInEntry;

  if (kind === "photos" && m.is_sketch !== undefined) {
    (out as { isSketch?: boolean }).isSketch = toBool(m.is_sketch);
  }

  return out as unknown as DayOneMedia;
}

/**
 * `entries` record + its already-grouped moments → `DayOneEntry`.
 */
function mapEntry(e: Rec, moments: Rec[]): DayOneEntry {
  const entry: Record<string, unknown> = {
    uuid: deriveUuid(e),
    // `date` epoch → creationDate (required, ISO).
    creationDate: toIso(e.date) ?? "",
    // `edit_date` epoch → modifiedDate.
    modifiedDate: toIso(e.edit_date),
    // `timezone` → timeZone.
    timeZone: e.timezone,

    // Renamed text fields.
    text: e.body,
    richText: e.rich_text_json,

    // 0/1 flags → boolean.
    starred: toBool(e.is_starred),
    isPinned: toBool(e.is_pinned),
    isAllDay: toBool(e.is_all_day),

    editingTime: e.editing_time,
    duration: e.duration,

    location: mapLocation(e.location),
    weather: mapWeather(e.weather),
  };

  // Group moments into photos / videos / audios, preserving source order and
  // assigning a stable `orderInEntry` per bucket.
  const buckets: Record<MediaKind, DayOneMedia[]> = {
    photos: [],
    videos: [],
    audios: [],
  };
  moments.forEach((m) => {
    const kind = momentKind(m);
    buckets[kind].push(mapMoment(m, buckets[kind].length));
  });
  if (buckets.photos.length) entry.photos = buckets.photos;
  if (buckets.videos.length) entry.videos = buckets.videos;
  if (buckets.audios.length) entry.audios = buckets.audios;

  // Strip keys that ended up undefined so the export object is clean and the
  // mirror's `raw` round-trip is faithful (no spurious `null`s).
  for (const k of Object.keys(entry)) {
    if (entry[k] === undefined) delete entry[k];
  }
  return entry as unknown as DayOneEntry;
}

/**
 * Translate the four extracted IndexedDB stores into per-journal
 * `DayOneExport`s, each ready for `importExport(db, export, journalName)`.
 *
 * - entries are grouped by `journal_id`;
 * - each entry's moments are matched by `moments.entry_id === entries.id` and
 *   attached as `photos` / `videos` / `audios`;
 * - the journal name comes from `journals[].name` joined on `journals[].id`.
 *
 * `tags` is accepted for signature completeness but not yet wired: the tag store
 * shape is still TBD in recon (`docs/browser-crosswalk.md`, open question 4), and
 * how a tag associates back to an entry is unknown. Left unmapped on purpose
 * rather than guessed — TODO(tags): wire once the store shape is confirmed.
 */
export function mapStoresToExports(stores: {
  entries: any[];
  moments: any[];
  journals: any[];
  tags?: any[];
}): MappedJournal[] {
  const { entries = [], moments = [], journals = [] } = stores;

  // journal_id → journal name.
  const journalName = new Map<unknown, string>();
  for (const j of journals) {
    if (j?.id !== undefined) journalName.set(j.id, String(j.name ?? `journal-${j.id}`));
  }

  // entries.id → its moments (matched by moments.entry_id).
  const momentsByEntry = new Map<unknown, Rec[]>();
  for (const m of moments) {
    const key = m?.entry_id;
    if (key === undefined) continue;
    const list = momentsByEntry.get(key);
    if (list) list.push(m);
    else momentsByEntry.set(key, [m]);
  }

  // Group mapped entries by journal_id, preserving first-seen journal order.
  const byJournal = new Map<unknown, DayOneEntry[]>();
  for (const e of entries) {
    // Soft-deleted entries (recon Q2) never reach the mirror.
    if (toBool(e?.is_deleted)) continue;
    const jid = e?.journal_id;
    const mapped = mapEntry(e, momentsByEntry.get(e?.id) ?? []);
    const list = byJournal.get(jid);
    if (list) list.push(mapped);
    else byJournal.set(jid, [mapped]);
  }

  const result: MappedJournal[] = [];
  for (const [jid, entryList] of byJournal) {
    result.push({
      // Unknown journal_id (no matching journals record) falls back to a stable
      // synthetic name so the entries are never dropped.
      journalName: journalName.get(jid) ?? `journal-${String(jid)}`,
      export: {
        // No export-version field exists in the IndexedDB stores; mark the browser ingester
        // provenance so the mirror's `journal.export_version` is not fabricated
        // as a real Day One export version.
        metadata: { version: "browser" },
        entries: entryList,
      },
    });
  }
  return result;
}
