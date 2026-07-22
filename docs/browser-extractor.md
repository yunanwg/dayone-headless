# Tier A extractor — driving the web app to fill the mirror

Pairs with `docs/browser-crosswalk.md` (the field mapping). This covers the
*extraction*: getting the decrypted DODexie stores out of a driven Day One web
app and into the mirror, safely and completely.

## Pipeline

```
launch persistent Chromium (profile)          src/ingest/browser/run.ts
  → ensure authenticated (passphrase path)     src/ingest/browser/login.ts
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

## Validated end-to-end (2026-07-22)

Full pipeline run on real data, no Mac: headless Chrome-for-Testing (Playwright) →
decrypted IndexedDB → force-load all journals → gate → map → mirror → CLI. Result
**byte-matches the official JSON export**: 3577 entries, 2469 media, dates in
`…Z` (no ms) format. The lazy `J4` filled 0→52 via force-load and passed
the gate. (Tiny open item: location count 2971 vs export 2970 — reconcile.)

Fresh-profile behavior confirmed: after login the app syncs the **journal list +
server counts** but downloads **no entries until a journal is selected** — so
`isAuthenticated` keys off the `journals` store, not `entries`, and
`forceLoadAllJournals` opens every journal to pull its entries.

## Open TODOs

1. **`automatedLogin` selectors** — joint recon pass (above). The persistent-profile
   manual login works today; automation is the remaining piece.
2. Reconcile the location 2971-vs-2970 off-by-one against the export oracle.
3. Verify media/`moments` completeness thresholds (thumbnails/promises may lag;
   the gate deliberately checks entries only).
