/**
 * Day One JSON-export shape — the project's STABLE CONTRACT.
 *
 * ⚠️ PROVISIONAL. These types are drafted from the community-documented Day One
 * JSON export format, NOT yet validated against a real export from THIS account.
 * The first hand-exported `exports/*.json` is the authority — reconcile every
 * field below against it, then drop this warning. Unknown/extra fields must be
 * preserved (see `raw` passthrough), never silently dropped: the mirror is also
 * the portable backup.
 *
 * A Day One export is a zip: one JSON file per journal plus `photos/`,
 * `videos/`, `audios/`, `pdfs/` folders. Media inside an entry's Markdown is
 * referenced as `dayone-moment://<identifier>`, and the file on disk is named by
 * the attachment's `md5` with the `type` as extension.
 */

export interface DayOneExport {
  metadata: { version: string };
  entries: DayOneEntry[];
}

export interface DayOneEntry {
  uuid: string;
  /** ISO-8601, UTC. */
  creationDate: string;
  modifiedDate?: string;
  /** IANA tz name, e.g. "America/New_York"; entry-local wall time = creationDate in this zone. */
  timeZone?: string;

  /** Body as Markdown. */
  text?: string;
  /** Day One's structured rich-text JSON (stringified); superset of `text`. */
  richText?: string;

  starred?: boolean;
  pinned?: boolean;
  isAllDay?: boolean;
  /** Seconds spent editing; Day One tracks this. */
  editingTime?: number;
  duration?: number;

  tags?: string[];

  creationDevice?: string;
  creationDeviceModel?: string;
  creationDeviceType?: string;
  creationOSName?: string;
  creationOSVersion?: string;

  location?: DayOneLocation;
  weather?: DayOneWeather;

  photos?: DayOneMedia[];
  videos?: DayOneMedia[];
  audios?: DayOneMedia[];
  pdfAttachments?: DayOneMedia[];

  userActivity?: Record<string, unknown>;
  music?: Record<string, unknown>;
}

export interface DayOneLocation {
  localityName?: string;
  administrativeArea?: string;
  country?: string;
  placeName?: string;
  longitude?: number;
  latitude?: number;
  altitude?: number;
  region?: {
    center?: { longitude: number; latitude: number };
    radius?: number;
    identifier?: string;
  };
}

export interface DayOneWeather {
  weatherCode?: string;
  conditionsDescription?: string;
  temperatureCelsius?: number;
  pressureMB?: number;
  windBearing?: number;
  windSpeedKPH?: number;
  windChillCelsius?: number;
  visibilityKM?: number;
  relativeHumidity?: number;
  weatherServiceName?: string;
  moonPhase?: number;
  sunriseDate?: string;
  sunsetDate?: string;
}

export interface DayOneMedia {
  /** Referenced from entry text as `dayone-moment://<identifier>`. */
  identifier: string;
  /** File on disk is `<md5>.<type>` under the media folder. */
  md5: string;
  type?: string;
  orderInEntry?: number;
  width?: number;
  height?: number;
  fileSize?: number;
  duration?: number;
  creationDevice?: string;
  isSketch?: boolean;
}
