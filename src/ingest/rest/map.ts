/**
 * REST decrypted-content → export shape (`DayOneEntry`). The decrypted entry blob
 * is a near-export JSON; this normalizes it (epoch→ISO, weather key renames,
 * clientMeta flattened) so the existing `importExport()` writes it to the mirror
 * unchanged — the serving-layer contract stays put.
 */

import { isValidMd5 } from "../../media-cache.ts";
import type { DayOneEntry, DayOneLocation, DayOneMedia, DayOneWeather } from "../../types.ts";

/** Loose decrypted-content object (untyped JSON from the D1 blob). */
type Content = Record<string, any>;

/** Epoch-ms (or ISO string) → ISO-8601 UTC without milliseconds (export format). */
export function toIso(v: unknown): string | undefined {
  if (v == null) return undefined;
  const d =
    typeof v === "number"
      ? new Date(v)
      : typeof v === "string"
        ? new Date(/^\d+$/.test(v) ? Number(v) : v)
        : null;
  if (!d || Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function mapWeather(w: Content | undefined): DayOneWeather | undefined {
  if (!w || typeof w !== "object") return undefined;
  const out: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = v;
  };
  put("weatherCode", w.code);
  put("conditionsDescription", w.description);
  put("temperatureCelsius", w.tempCelsius);
  put("pressureMB", w.pressureMb);
  put("weatherServiceName", w.service);
  put("visibilityKM", w.visibilityKm);
  put("windSpeedKPH", w.windSpeedKph);
  put("windBearing", w.windBearing);
  put("windChillCelsius", w.windChillCelsius);
  put("moonPhase", w.moonPhase);
  put("moonPhaseCode", w.moonPhaseCode);
  put("relativeHumidity", w.relativeHumidity);
  put("sunriseDate", toIso(w.sunriseDate));
  put("sunsetDate", toIso(w.sunsetDate));
  return out as unknown as DayOneWeather;
}

function mapLocation(loc: Content | undefined): DayOneLocation | undefined {
  if (!loc || typeof loc !== "object") return undefined;
  // Already camelCase in the decrypted content; pass through the modeled keys.
  const out: Record<string, unknown> = {};
  for (const k of [
    "latitude",
    "longitude",
    "altitude",
    "placeName",
    "localityName",
    "country",
    "administrativeArea",
    "timeZoneName",
    "userLabel",
    "streetAddress",
    "region",
  ])
    if (loc[k] !== undefined) out[k] = loc[k];
  return out as unknown as DayOneLocation;
}

type MediaKind = "photos" | "videos" | "audios" | "pdfAttachments";

/** Which export bucket a decrypted `moment` belongs to. */
function momentKind(m: Content): MediaKind {
  const mt = String(m.momentType ?? "").toLowerCase();
  if (mt.includes("video")) return "videos";
  if (mt.includes("audio")) return "audios";
  if (mt.includes("pdf")) return "pdfAttachments";
  const ct = String(m.contentType ?? m.type ?? "").toLowerCase();
  if (ct.startsWith("video/")) return "videos";
  if (ct.startsWith("audio/")) return "audios";
  if (ct === "application/pdf" || ct.includes("pdf")) return "pdfAttachments";
  return "photos";
}

/** One decrypted `moment` → export media object (METADATA only — never bytes). */
function mapMoment(m: Content, orderInEntry: number): DayOneMedia {
  const out: Record<string, unknown> = { ...m };
  out.identifier = m.id ?? m.identifier;
  // Hygiene: only carry a well-formed md5 (32 lowercase hex). A malformed value is
  // dropped so it never reaches the mirror or the content-addressed media path.
  if (isValidMd5(m.md5)) out.md5 = m.md5;
  else delete out.md5;
  const subtype = String(m.contentType ?? "").split("/")[1];
  if (subtype) out.type = subtype;
  if (m.createdAt !== undefined) out.date = toIso(m.createdAt);
  out.orderInEntry = orderInEntry;
  return out as unknown as DayOneMedia;
}

/** Group an entry's decrypted `moments` array into the export media buckets. */
function groupMoments(moments: unknown): Partial<Record<MediaKind, DayOneMedia[]>> {
  const buckets: Record<MediaKind, DayOneMedia[]> = {
    photos: [],
    videos: [],
    audios: [],
    pdfAttachments: [],
  };
  if (Array.isArray(moments)) {
    for (const m of moments) {
      const k = momentKind(m);
      buckets[k].push(mapMoment(m, buckets[k].length));
    }
  }
  const out: Partial<Record<MediaKind, DayOneMedia[]>> = {};
  for (const k of Object.keys(buckets) as MediaKind[]) if (buckets[k].length) out[k] = buckets[k];
  return out;
}

/**
 * Map one decrypted entry (its content JSON) into the export `DayOneEntry`.
 * The revision (feed metadata) supplies the entry's edit timestamp if the content
 * lacks one; the content is authoritative for everything private.
 */
export function mapEntry(content: Content, revision?: { editDate?: number }): DayOneEntry {
  const cm = content.clientMeta ?? {};
  const entry: Record<string, unknown> = {
    uuid: content.id,
    creationDate: toIso(content.date) ?? "",
    modifiedDate: toIso(content.userEditDate ?? revision?.editDate),
    timeZone: content.timeZone,
    text: content.body,
    richText: content.richTextJSON,
    starred: !!content.starred,
    isPinned: !!content.isPinned,
    isAllDay: !!content.isAllDay,
    editingTime: content.editingTime,
    duration: content.duration,
    tags: Array.isArray(content.tags) && content.tags.length ? content.tags : undefined,
    creationDevice: cm.creationDevice,
    creationDeviceModel: cm.creationDeviceModel,
    creationDeviceType: cm.creationDeviceType,
    creationOSName: cm.creationOSName,
    creationOSVersion: cm.creationOSVersion,
    location: mapLocation(content.location),
    weather: mapWeather(content.weather),
    ...groupMoments(content.moments),
  };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  return entry as unknown as DayOneEntry;
}
