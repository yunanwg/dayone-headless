/**
 * redact-export — turn a real Day One JSON export into a structurally faithful
 * but fully content-redacted fixture that is SAFE TO COMMIT.
 *
 * Usage:  bun run scripts/redact-export.ts <in.json> <out.json>
 *
 * Design contract (why this is safe to commit):
 *   * Every key, value type, nesting level and array length is preserved exactly
 *     — the output is byte-shaped like a real export, so it exercises the same
 *     importer/serving paths.
 *   * Non-private, low-cardinality / enum-ish values (weather codes, media types,
 *     IANA time zones, device/OS names, numeric weather metrics, EXIF camera
 *     strings, dimensions, flags) are kept verbatim so the fixture stays realistic.
 *   * Every private / free-text / identifying leaf is redacted:
 *       - free text (body, place names, country, user labels, tags) -> length-
 *         matched lorem, keeping rough Markdown shape and any embedded
 *         `dayone-moment://` references intact,
 *       - richText -> a valid `{ meta, contents }` JSON string with its text and
 *         identifiers redacted,
 *       - lat/long/altitude -> deterministic dummy coordinates,
 *       - uuids / identifiers / md5 / *_user_id / filenames / appleCloudIdentifier
 *         -> deterministic hex of the SAME length.
 *   * DEFAULT-DENY: any UNKNOWN string leaf (unmodeled fields, `userActivity`,
 *     `music`, `template`, …) is redacted too, so a field we never modeled can't
 *     leak. Unknown numbers / booleans are kept (not identifying, and keeps the
 *     shape realistic).
 *   * Referential integrity: a single deterministic map guarantees the same input
 *     id always yields the same placeholder, so entry<->media
 *     (`dayone-moment://<identifier>`) references still resolve after redaction.
 *
 * This script never needs the real data to be inspected by a human or a model:
 * develop/test it against a synthetic export only; the human runs it on the real
 * `exports/*.json` and commits the output.
 */

import type { DayOneExport } from "../src/types.ts";

// ── Field classification ────────────────────────────────────────────────────

/** Identifiers -> deterministic hex of the same length (referential integrity). */
const HEX_KEYS = new Set(["uuid", "identifier", "md5", "appleCloudIdentifier", "filename"]);

/** Coordinates -> deterministic dummy numbers. */
const COORD_KEYS = new Set(["latitude", "longitude", "altitude"]);

/** Free text / identifying strings -> length-matched lorem. */
const TEXT_KEYS = new Set([
  "text",
  "placeName",
  "localityName",
  "administrativeArea",
  "country",
  "userLabel",
  "tags", // array of user-authored tag strings
  // Device *display name* is typically "<FirstName>'s iPhone" → redact.
  // (creationDeviceType / creationDeviceModel are hardware ids, kept below.)
  "creationDevice",
]);

/**
 * Non-private, low-cardinality / enum-ish / structural strings kept verbatim so
 * the fixture reads like a real export. Numbers and booleans are kept by default
 * (see the walker), so this set only needs the safe *string* fields.
 */
const KEEP_KEYS = new Set([
  "version",
  // timestamps (needed by on-this-day / ordering; not in the redact list)
  "creationDate",
  "modifiedDate",
  "date",
  "sunriseDate",
  "sunsetDate",
  // time zones (IANA names)
  "timeZone",
  "timeZoneName",
  // weather enums / descriptions
  "weatherCode",
  "moonPhaseCode",
  "conditionsDescription",
  "weatherServiceName",
  // device / OS
  "creationOSName",
  "creationOSVersion",
  "creationDeviceType",
  "creationDeviceModel",
  // media type / format
  "type",
  "format",
  // camera / lens EXIF strings
  "cameraMake",
  "cameraModel",
  "lensMake",
  "lensModel",
  "fnumber",
  "focalLength",
  // import source marker (enum-ish, e.g. "com.dayoneapp…")
  "sourceString",
]);

/** `*_user_id` style keys (snake or camel) -> hex. */
function isUserIdKey(key: string): boolean {
  return /_user_id$/i.test(key) || /userId$/.test(key);
}

// ── Deterministic primitives ────────────────────────────────────────────────

/** 32-bit FNV-1a hash of a string. Stable, dependency-free. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const HEX = "0123456789abcdef";

/** Deterministic lowercase-hex string of exactly `len` chars, seeded by `seed`. */
function deterministicHex(seed: string, len: number): string {
  let state = fnv1a(seed);
  let out = "";
  for (let i = 0; i < len; i++) {
    state = Math.imul(state, 0x01000193) >>> 0;
    state ^= state >>> 13;
    out += HEX.charAt(state & 0xf);
  }
  return out;
}

/**
 * Referential-integrity map: the same original id always yields the same
 * placeholder, so `dayone-moment://<id>` in text lines up with the media
 * `identifier` it points at.
 */
const idMap = new Map<string, string>();
function mapHex(original: string): string {
  const cached = idMap.get(original);
  if (cached !== undefined) return cached;
  const out = deterministicHex(original, original.length);
  idMap.set(original, out);
  return out;
}

const LOREM = "loremipsumdolorsitametconsecteturadipiscingelitseddoeiusmod";

/**
 * Length-preserving lorem for a single alphanumeric run, deterministic on the
 * run itself. Preserves digit-ness and upper-case so shapes stay realistic.
 */
function loremRun(run: string): string {
  let h = fnv1a(run);
  let out = "";
  for (let i = 0; i < run.length; i++) {
    h = Math.imul(h, 0x01000193) >>> 0;
    h ^= h >>> 13;
    const c = run.charAt(i);
    if (c >= "0" && c <= "9") {
      out += String(h % 10);
    } else {
      const base = LOREM.charAt(h % LOREM.length);
      out += c >= "A" && c <= "Z" ? base.toUpperCase() : base;
    }
  }
  return out;
}

const MOMENT_PREFIX = "dayone-moment://";

/**
 * Redact free text: lorem every alphanumeric run (preserving length, newlines,
 * and all Markdown punctuation) while keeping `dayone-moment://<id>` references
 * intact with their identifier mapped through `mapHex`.
 */
function redactText(input: string): string {
  // Match Unicode letters/numbers (NOT just ASCII) so CJK, accented Latin, etc.
  // are redacted too — real journals are multilingual. Punctuation/whitespace is
  // preserved to keep shape; `dayone-moment://<id>` refs are mapped, not loremed.
  return input.replace(/dayone-moment:\/\/[A-Za-z0-9._-]+|[\p{L}\p{N}]+/gu, (m) => {
    if (m.startsWith(MOMENT_PREFIX)) {
      return MOMENT_PREFIX + mapHex(m.slice(MOMENT_PREFIX.length));
    }
    return loremRun(m);
  });
}

/** Deterministic dummy coordinate in the plausible range for its axis. */
function dummyCoord(key: string, original: number): number {
  const h = fnv1a(`${key}:${original}`);
  switch (key) {
    case "latitude":
      return Math.round(((h % 18000) / 100 - 90) * 1e4) / 1e4;
    case "longitude":
      return Math.round(((h % 36000) / 100 - 180) * 1e4) / 1e4;
    case "altitude":
      return Math.round((h % 200000) / 100) / 10; // 0 .. ~200m, 1 decimal
    default:
      return 0;
  }
}

// ── Recursive walker ────────────────────────────────────────────────────────

/**
 * Redact a value given the key it was found under. Objects/arrays recurse;
 * leaves are classified by key name. Array elements inherit their parent key so
 * scalar arrays (e.g. `tags`) are classified correctly.
 */
function redactValue(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((el) => redactValue(el, key));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }

  // Leaf.
  if (typeof value === "string") {
    if (key === "richText") return redactRichText(value);
    if (HEX_KEYS.has(key) || isUserIdKey(key)) return mapHex(value);
    if (TEXT_KEYS.has(key)) return redactText(value);
    if (KEEP_KEYS.has(key)) return value;
    // DEFAULT-DENY: unmodeled string leaves are treated as potentially private.
    return redactText(value);
  }

  if (typeof value === "number") {
    if (COORD_KEYS.has(key)) return dummyCoord(key, value);
    return value; // numeric metrics, dimensions, durations, flags-as-0/1 kept
  }

  // booleans and anything else kept as-is.
  return value;
}

/**
 * Redact a Day One richText payload (a stringified `{ meta, contents }`).
 * Parse, redact recursively (its `text` and `identifier` leaves are handled by
 * the same rules — so embedded media references stay consistent), re-stringify.
 * Falls back to a minimal valid document if the payload can't be parsed.
 */
function redactRichText(raw: string): string {
  try {
    const parsed = redactValue(JSON.parse(raw), "__richtext__");
    return JSON.stringify(parsed);
  } catch {
    return JSON.stringify({ meta: { version: 1 }, contents: [] });
  }
}

/** Redact an entire export, preserving all structure. */
export function redactExport(data: DayOneExport): DayOneExport {
  return redactValue(data, "__root__") as DayOneExport;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error("usage: bun run scripts/redact-export.ts <in.json> <out.json>");
    process.exit(1);
  }
  const data = (await Bun.file(inPath).json()) as DayOneExport;
  const redacted = redactExport(data);
  await Bun.write(outPath, `${JSON.stringify(redacted, null, 2)}\n`);
  console.error(`redacted "${inPath}" -> "${outPath}" (${redacted.entries?.length ?? 0} entries)`);
}
