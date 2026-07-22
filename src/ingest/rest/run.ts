#!/usr/bin/env bun
/**
 * the REST ingester — run the full env-only pipeline (no browser) and report what decrypted.
 * Prints counts and lengths only, never entry content.
 *
 *   DAYONE_ENCRYPTION_KEY   the "D1-<userId>-<code…>" encryption key (required)
 *   DAYONE_API_TOKEN    a 32-char token, OR DAYONE_EMAIL + DAYONE_PASSWORD to mint one
 *   DAYONE_X_USER_AGENT, DAYONE_DEVICE_INFO   (from a logged-in session for now)
 *
 *   bun run src/ingest/rest/run.ts
 */

import { apiConfigFromEnv, DayOneApi } from "./api.ts";
import { TierCReader } from "./reader.ts";

const masterKey = process.env.DAYONE_ENCRYPTION_KEY;
if (!masterKey) throw new Error("set DAYONE_ENCRYPTION_KEY (the D1-<userId>-<code…> encryption key)");

const api = new DayOneApi(apiConfigFromEnv());
const reader = new TierCReader(api, masterKey);

const keys = await reader.unlockKeys();
console.error(
  `unlocked user key + ${keys.journalPrivByFingerprint.size} journal key(s) across ${keys.journals.length} journals`,
);

const maxPerJournal = process.env.DAYONE_MAX_ENTRIES ? Number(process.env.DAYONE_MAX_ENTRIES) : Infinity;
let total = 0;
for (const j of keys.journals) {
  if (!j?.encryption?.vault?.keys?.length) continue;
  let n = 0;
  for await (const e of reader.decryptJournal(j.id, keys)) {
    n++;
    if (n === 1)
      console.error(`  [${j.name ?? j.id}] sample entry ${e.entryId}: ${e.content.length} chars decrypted`);
    if (n >= maxPerJournal) break;
  }
  total += n;
  console.error(
    `  journal ${j.name ?? j.id}: ${n} entries decrypted${n >= maxPerJournal ? " (capped)" : ""}`,
  );
}
console.error(`done — ${total} entries decrypted from env alone, no browser`);
