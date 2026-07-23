# Browser ingester crosswalk — IndexedDB (`DODexie`) → export-shaped mirror

> Design reference for the **browser ingester** (`src/ingest/browser/`), the
> dev/oracle path. For how it fits the whole system, see
> [architecture.md](architecture.md); for the extraction pipeline, see
> [browser-extractor.md](browser-extractor.md).

This is the field-mapping spec the browser ingester implements. It contains
**field names and mappings only — no journal content**.

## Decisive finding

The Day One web app caches **decrypted plaintext** in IndexedDB. The browser
ingester needs **no crypto**: read the Dexie stores and translate them into the
mirror (whose contract is the JSON-export shape, see `src/types.ts`). Crypto is
the REST ingester's concern only.

## Source: Dexie DB `DODexie` (many object stores)

Stores that matter to the browser ingester:

| store | role for the browser ingester |
|---|---|
| `entries` | primary — decrypted entries |
| `moments` | media/attachments |
| `journals` | journal list |
| `tags` | tags |
| `medias` | secondary media table — TBD vs `moments` |
| `content_keys` / `user_keys` / `vaults` | **REST ingester only** — key material, not read by the browser ingester |
| `search`, `kv`, `server_flags`, `sync_states`, `devices`, `daily_chats`, `pbc_templates`, … | not needed for read mirror |

Note: the IndexedDB `entries` store can lag the JSON export's total when a journal
hasn't been force-loaded (the cache is lazy). **Verify per-journal completeness**
before trusting the browser ingester as complete.

## Encoding gotchas (apply across every mapping)

- **Case**: IndexedDB is `snake_case`; the export is `camelCase`.
- **Dates**: IndexedDB `date` / `edit_date` / `created_at` are **epoch ms, true
  UTC** (verified: `new Date(date).toISOString()` matches the export's
  `creationDate` to the second). Convert to ISO — but **strip milliseconds** to
  match the export format: it writes `2024-09-03T05:39:14Z`, not `…:14.000Z`.
  So: `new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")`.
- **Booleans**: IndexedDB uses `0/1` numbers for most flags (some genuine bools).
- **Media md5**: `moments` carries **two** md5s — `md5_envelope` (encrypted
  envelope) and `md5_body`. The on-disk export file is `<md5>.<type>`; `md5_body`
  is the match. `md5_envelope` has no export equivalent.
- Nested `weather` / `location` sub-keys are **renamed** vs the export (below).

## `entries` → `DayOneEntry`

| IndexedDB | export field | notes |
|---|---|---|
| `id` (18 chars) | `uuid` (32 hex) | **Unrelated id spaces** (resolved): IndexedDB has no 32-hex uuid field. The browser ingester keys by the web `id` via `deriveUuid`; oracle/cross-ingester identity is content-based. See "Resolved / remaining questions". |
| `body` | `text` | plaintext Markdown |
| `rich_text_json` | `richText` | plaintext JSON `{meta,contents}` |
| `date` (epoch) | `creationDate` | → ISO |
| `edit_date` (epoch) | `modifiedDate` | → ISO |
| `editing_time` | `editingTime` | |
| `duration` | `duration` | |
| `is_all_day` (0/1) | `isAllDay` | |
| `is_pinned` (0/1) | `isPinned` | |
| `is_starred` (0/1) | `starred` | |
| `timezone` | `timeZone` | |
| `location{…}` | `location` | see sub-map |
| `weather{…}` | `weather` | see sub-map |
| `journal_id` | — | used to associate journal, not an export entry field |
| `owner_user_id`, `editor_user_id`, `creator_user_id` | — | no export equivalent |
| `activity`, `entry_type`, `client_meta`, `revision_id`, `user_edit_date`, `last_editing_device_*`, `templateID` | — | TBD; keep in `raw` if surfaced |

### `entries.location` → `DayOneLocation`
`latitude`,`longitude`,`placeName`,`region`,`localityName`,`country`,
`administrativeArea` map 1:1 (same names). Extra: `route` (no export field).
Export-only (absent here): `altitude`, `timeZoneName`, `userLabel`.

### `entries.weather` → `DayOneWeather` (renamed)
`code`→`weatherCode`, `description`→`conditionsDescription`,
`tempCelsius`→`temperatureCelsius`, `pressureMb`→`pressureMB`,
`relativeHumidity`→`relativeHumidity`, `service`→`weatherServiceName`,
`visibilityKm`→`visibilityKM`, `windSpeedKph`→`windSpeedKPH`,
`windBearing`→`windBearing`, `moonPhase`→`moonPhase`,
`moonPhaseCode`→`moonPhaseCode`, `sunriseDate`/`sunsetDate` (epoch→ISO).

## `moments` → `DayOneMedia` / `DayOnePhoto`

| IndexedDB | export field | notes |
|---|---|---|
| `id` (32) | `identifier` | referenced in body as `dayone-moment://<identifier>` |
| `entry_id` (18) | — | FK to `entries.id` |
| `md5_body` | `md5` | on-disk file `<md5>.<type>` |
| `md5_envelope` | — | encrypted envelope md5, no export equiv |
| `content_type` ("image/jpeg") | — | MIME; export uses short `type` ("jpeg") |
| `type` ("photo"/…) | — | kind discriminator |
| `date` (epoch) | `date` | → ISO |
| `favorite` (0/1) | `favorite` | |
| `is_sketch` (0/1) | `isSketch` | |
| `height`,`width` | `height`,`width` | |
| `metadata{duration,fileSize,location,audioChannels,format,recordingDevice,sampleRate,timeZoneName,pdfName,title}` | resp. media fields | flatten into export media object |
| `thumbnail_*` | — | no export equivalent |

## `journals` → mirror `journal`

`id`→journal id, `name`→`name`, plus metadata: `kind`, `color`, `owner_id`,
`created_at`, `sort_method`, and privacy/state flags `e2e`, `is_decrypted`,
`conceal`, `is_shared`, `shared_permissions`, `should_rotate_keys`. `e2e` +
`is_decrypted` explain why `entries.body` is plaintext at rest (journal already
decrypted client-side). The mirror only needs `id` + `name`; keep the rest in
`raw` if useful.

## `tags` → mirror `tag` / `entry_tag`
Shape TBD (record truncated during capture). Reconcile before use.

## Browser-ingester extraction requirements

- **Completeness is NOT free — the IndexedDB cache is lazy.** A journal can be
  present in `journals` (metadata + keys, `is_decrypted=1`) yet have **0 rows** in
  `entries` until it is opened — the web client loads a journal's entries on
  demand. So the browser ingester **must force-load every journal** (open each in
  the driven web app, wait for sync) and then **verify per-journal counts** before
  trusting the dump. Emit a loud warning on any shortfall — never silently ship a
  partial mirror.
- **Filter soft-deletes.** `entries.is_deleted` exists; skip `is_deleted` rows.
- Other entries fields seen (keep in `raw` if surfaced, otherwise ignore):
  `monthDayCombined`, `year` (web app precomputes on-this-day keys — mirrors our
  own index), `reactions`, `is_shared`, `steps`, `feature_flags`, `client_meta`,
  `promptID`, `templateID`, `activity`, `entry_type`, `revision_id`.

## Resolved / remaining questions

1. **RESOLVED — `entries.id` (18) vs export `uuid` (32).** The IndexedDB `entries`
   record has **no 32-hex uuid field at all** (37 keys inspected; none hex-32).
   The web id space and the export uuid space are unrelated. Consequences:
   the browser ingester keys entries by the web `id` (via `deriveUuid`);
   **cross-ingester / oracle identity must be content-based** (e.g.
   `creationDate`+`text` hash), not uuid. Flag when mixing a browser-ingester
   mirror with a JSON-export mirror — same entry,
   different PK → dedupe by content.
2. **RESOLVED — an entries shortfall vs the export traces to an entire un-opened
   journal** (lazy cache, see above), not scattered missing entries.
3. `medias` vs `moments` — what is the `medias` store for. (open)
4. `tags` record shape. (open)
5. **RESOLVED — epoch dates are true UTC.** `new Date(entries.date).toISOString()`
   matched three export `creationDate` values verbatim (to the second). Strip
   milliseconds to match the export's `…Z` format. This timestamp match also
   gives the content-based identity anchor Q1 needs, and cross-validated that a
   journal's IndexedDB entries == its export.
