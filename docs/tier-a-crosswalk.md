# Tier A crosswalk — IndexedDB (`DODexie`) → export-shaped mirror

Phase 0 recon output (2026-07-22, CDP against a logged-in `dayone.me` session).
This is the spec the Tier A ingester implements. It contains **field names and
mappings only — no journal content**.

## Decisive finding

The Day One web app caches **decrypted plaintext** in IndexedDB. Tier A needs
**no crypto**: read the Dexie stores and translate them into the mirror
(whose contract is the JSON-export shape, see `src/types.ts`). Crypto is a Tier C
concern only.

## Source: Dexie DB `DODexie` (v920, 41 object stores)

Non-empty stores (record counts on this account):

| store | count | role for Tier A |
|---|---|---|
| `entries` | 3525 | primary — decrypted entries |
| `moments` | 2459 | media/attachments |
| `journals` | 4 | journal list |
| `tags` | 314 | tags |
| `medias` | 8 | (secondary media table — TBD vs `moments`) |
| `content_keys` / `user_keys` / `vaults` | 1 / 2 / 4 | **Tier C only** — key material, not read by Tier A |
| `search`, `kv`, `server_flags`, `sync_states`, `devices`, `daily_chats`, `pbc_templates`, … | — | not needed for read mirror |

Note: IndexedDB `entries`=3525 vs the JSON export's 3577. ~52 gap ≈ the
`J4` journal size — **investigate** whether some journals aren't synced
to the web client or are counted differently before trusting Tier A as complete.

## Encoding gotchas (apply across every mapping)

- **Case**: IndexedDB is `snake_case`; the export is `camelCase`.
- **Dates**: IndexedDB `date` / `edit_date` / `created_at` are **epoch numbers**;
  the export uses **ISO-8601 UTC strings**. Convert.
- **Booleans**: IndexedDB uses `0/1` numbers for most flags (some genuine bools).
- **Media md5**: `moments` carries **two** md5s — `md5_envelope` (encrypted
  envelope) and `md5_body`. The on-disk export file is `<md5>.<type>`; `md5_body`
  is the match. `md5_envelope` has no export equivalent.
- Nested `weather` / `location` sub-keys are **renamed** vs the export (below).

## `entries` → `DayOneEntry`

| IndexedDB | export field | notes |
|---|---|---|
| `id` (18 chars) | `uuid` (32 hex) | **OPEN QUESTION — different id spaces.** The export uuid is 32-hex; the store id is 18 chars. Must resolve the mapping (derived? separate field? server id vs client uuid) before Tier A output can be conformance-checked against the export oracle. |
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
Shape TBD (record truncated during recon; count 314). Reconcile before use.

## Open questions to close before trusting Tier A

1. **`entries.id` (18) vs export `uuid` (32)** — the id crosswalk. Blocks
   byte-identical conformance against the export oracle.
2. **3525 vs 3577 entry-count gap** — which journals/entries are missing from the
   web client, and why.
3. `medias` (8) vs `moments` (2459) — what is the `medias` store for.
4. `tags` record shape.
5. Do epoch dates carry the entry's local wall time or UTC? Cross-check against
   `timezone` + the export's ISO values on the same entry.
