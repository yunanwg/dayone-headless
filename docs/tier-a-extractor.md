# Tier A extractor — driving the web app to fill the mirror

Pairs with `docs/tier-a-crosswalk.md` (the field mapping). This covers the
*extraction*: getting the decrypted DODexie stores out of a driven Day One web
app and into the mirror, safely and completely.

## Pipeline

```
launch persistent Chromium (profile)          src/ingest/tier-a/run.ts
  → ensure authenticated (passphrase path)     src/ingest/tier-a/login.ts
  → force-load EVERY journal                   extract.ts:forceLoadAllJournals
  → dump DODexie stores                         extract.ts:extractStores
  → COMPLETENESS GATE (refuse partial)          extract.ts:computeCompleteness
  → map IndexedDB → export shape                map.ts:mapStoresToExports
  → importExport() → mirror                     ingest/json-export/import.ts (reused)
```

The serving layer is never touched — Tier A produces export-shaped objects and
feeds the same importer the JSON path uses.

## Auth (the project's #1 unknown)

- **Do NOT drive Apple / Secure-Enclave 2FA** — it can't be automated headless.
  Day One offers a **typeable encryption passphrase** (the master decrypt key);
  that is the path we use.
- **MVP — persistent profile + one-time manual login** (supported today): a
  dedicated, gitignored Chromium profile (`DAYONE_PROFILE_DIR`) is logged in once
  with `DAYONE_HEADLESS=0` — email + password + passphrase — and the session
  persists, so later headless runs are already authenticated. No credential
  automation, so this code never touches the secrets.
- **Automated passphrase login** (`login.ts:automatedLogin`) is a scaffold. The
  sign-in appears to route through an Automattic/WordPress SSO; the exact
  login/decrypt selectors are **not yet confirmed** and the function throws rather
  than ship guessed credential-entry code. Closing it needs a **joint recon pass**
  (a human drives one login while we capture the DOM + network flow).

## Completeness gate (non-negotiable)

The web cache is **lazy** — recon Q2 found the `J4` journal at 0 cached
entries (its metadata + keys present, `is_decrypted=1`) though the export had 52.
A naive dump silently ships a partial mirror.

`entry_counts_cache` is the oracle: per journal it holds the server-side
`count` (+ `photo`/`video`/`audio`/`pdf`), matching the JSON export exactly.
`computeCompleteness()` compares loaded entries against it; `run.ts` **refuses to
write** while any journal is short (`DAYONE_STRICT=1`, default). Deleted rows
(`is_deleted`) don't count toward the total.

## Secrets & security

- Credentials/passphrase are read only from the environment at runtime, passed
  transiently, and **never logged or persisted** by this code.
- The profile dir holds the live session and the app's decrypted cache — treat it
  like a private key: gitignored (`profile/`), tight perms, on the ingestion host
  only. Same posture as the master key in the security model.

## Open TODOs

1. **`openJournal` route** — the per-journal force-load navigation is a best-effort
   app reload; confirm the real per-journal route/trigger so lazy journals load
   deterministically. (The gate makes a wrong guess *safe* — it just blocks the
   write — but load must actually work for Tier A to complete.)
2. **`automatedLogin` selectors** — joint recon pass (above).
3. Verify media/`moments` completeness thresholds (thumbnails/promises may lag).
