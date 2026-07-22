#!/usr/bin/env bun
/**
 * Tier C — run the full env-only pipeline (no browser) and report what decrypted.
 * Prints counts and lengths only, never entry content.
 *
 *   DAYONE_MASTER_KEY   the "D1-<userId>-<code…>" encryption key (required)
 *   DAYONE_API_TOKEN    a 32-char token, OR DAYONE_EMAIL + DAYONE_PASSWORD to mint one
 *   DAYONE_X_USER_AGENT, DAYONE_DEVICE_INFO   (from a logged-in session for now)
 *
 *   bun run src/ingest/tier-c/run.ts
 */

import { DayOneApi, apiConfigFromEnv } from "./api.ts";
import { TierCReader } from "./reader.ts";

const masterKey = process.env.DAYONE_MASTER_KEY;
if (!masterKey) throw new Error("set DAYONE_MASTER_KEY (the D1-<userId>-<code…> encryption key)");

const api = new DayOneApi(apiConfigFromEnv());
const reader = new TierCReader(api, masterKey);

const keys = await reader.unlockKeys();
console.error(
  `unlocked user key + ${keys.journalPrivByFingerprint.size} journal key(s) across ${keys.journals.length} journals`,
);

let total = 0;
for (const j of keys.journals) {
  if (!j?.encryption?.vault?.keys?.length) continue;
  let n = 0;
  for await (const e of reader.decryptJournal(j.id, keys)) {
    n++;
    if (n === 1) console.error(`  [${j.name ?? j.id}] sample entry ${e.entryId}: ${e.content.length} chars decrypted`);
  }
  total += n;
  console.error(`  journal ${j.name ?? j.id}: ${n} entries decrypted`);
}
console.error(`done — ${total} entries decrypted from env alone, no browser`);
