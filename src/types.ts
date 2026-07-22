/**
 * Day One JSON-export shape — the project's STABLE CONTRACT.
 *
 * Reconciled against a real 4-journal export (3577 entries) on 2026-07-22 via
 * key-union introspection. Field names/coverage below reflect that export.
 * Unmodeled fields are still preserved verbatim via the mirror's `raw` column —
 * the mirror is also the portable backup, so nothing is ever dropped.
 *
 * A Day One export is a zip: one JSON file per journal plus `photos/`,
 * `videos/`, `audios/`, `pdfs/` folders. Media inside an entry's Markdown is
 * referenced as `dayone-moment://<identifier>`, and the file on disk is named by
 * the attachment's `md5` with `type` as extension.
 */

export interface DayOneExport {
  metadata: { version: string };
  entries: DayOneEntry[];
}

export interface DayOneEntry {
  uuid: string;
  /** ISO-8601, UTC. Present on 100% of entries. */
  creationDate: string;
  modifiedDate: string;
  /** IANA tz name; entry-local wall time = creationDate in this zone. */
  timeZone: string;

  /** Body as Markdown. */
  text: string;
  /** Structured rich-text JSON (stringified): `{ meta, contents }`. Superset of `text`. ~88%. */
  richText?: string;

  starred: boolean;
  /** NB: the export key is `isPinned`, not `pinned`. */
  isPinned: boolean;
  isAllDay: boolean;
  /** Seconds spent editing. ~91%. */
  editingTime?: number;
  duration?: number;

  /** Present on ~9% of entries only. */
  tags?: string[];
  /** e.g. import source marker. ~11%. */
  sourceString?: string;
  /** Template-created entries. ~1%. */
  template?: Record<string, unknown>;

  creationDevice: string;
  creationDeviceModel?: string;
  creationDeviceType: string;
  creationOSName: string;
  creationOSVersion: string;

  location?: DayOneLocation;
  weather?: DayOneWeather;

  photos?: DayOnePhoto[];
  videos?: DayOneMedia[];
  audios?: DayOneMedia[];
  /** Not present in the reference export — key name per community docs, unconfirmed. */
  pdfAttachments?: DayOneMedia[];

  userActivity?: Record<string, unknown>;
  music?: Record<string, unknown>;
}

export interface DayOneLocation {
  region?: {
    center?: { longitude: number; latitude: number };
    radius?: number;
    identifier?: string;
  };
  longitude: number;
  latitude: number;
  placeName: string;
  country: string;
  administrativeArea?: string;
  localityName?: string;
  timeZoneName?: string;
  userLabel?: string;
  altitude?: number;
}

export interface DayOneWeather {
  weatherCode: string;
  weatherServiceName: string;
  conditionsDescription: string;
  temperatureCelsius: number;
  pressureMB: number;
  windBearing: number;
  windSpeedKPH: number;
  windChillCelsius?: number;
  visibilityKM?: number;
  relativeHumidity: number;
  moonPhase: number;
  moonPhaseCode?: string;
  sunriseDate?: string;
  sunsetDate?: string;
}

/** Common attachment fields across photos/videos/audios. */
export interface DayOneMedia {
  /** Referenced from entry text as `dayone-moment://<identifier>`. */
  identifier: string;
  /** File on disk is `<md5>.<type>` under the media folder. */
  md5: string;
  type?: string;
  /** Audio uses `format` instead of `type`. */
  format?: string;
  orderInEntry: number;
  favorite?: boolean;
  date?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  duration?: number;
  creationDevice?: string;
  location?: DayOneLocation;
  /** Present when the asset originated in Apple Photos / iCloud. */
  appleCloudIdentifier?: string;
}

/** Photos carry EXIF-derived fields on top of the common media shape. */
export interface DayOnePhoto extends DayOneMedia {
  isSketch?: boolean;
  exposureBiasValue?: number;
  fnumber?: string;
  focalLength?: string;
  cameraMake?: string;
  cameraModel?: string;
  lensMake?: string;
  lensModel?: string;
  filename?: string;
}
