/**
 * `dayone doctor` — a config + mirror self-check. Reports the PRESENCE and shape
 * of secrets, never their values. Returns 0 when healthy, 1 otherwise.
 */

import { existsSync } from "node:fs";
import { parseMasterKey } from "../ingest/rest/crypto.ts";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import { getSyncedAt } from "./queries.ts";

export async function doctor(): Promise<number> {
  let ok = true;
  const check = (label: string, good: boolean, detail = "") => {
    console.error(`${good ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!good) ok = false;
  };
  const warn = (label: string, good: boolean, detail = "") =>
    console.error(`${good ? "✓" : "○"} ${label}${detail ? ` — ${detail}` : ""}`);

  // --- config ---
  const key = process.env.DAYONE_ENCRYPTION_KEY;
  let keyOk = false;
  try {
    if (key) {
      parseMasterKey(key);
      keyOk = true;
    }
  } catch {
    /* invalid format */
  }
  check(
    "DAYONE_ENCRYPTION_KEY",
    keyOk,
    keyOk ? "valid D1-<userId>-<code…> format" : key ? "set, but not D1-<userId>-<code…>" : "not set",
  );

  const hasToken = !!process.env.DAYONE_API_TOKEN;
  const hasLogin = !!process.env.DAYONE_EMAIL && !!process.env.DAYONE_PASSWORD;
  check(
    "auth",
    hasToken || hasLogin,
    hasToken
      ? "DAYONE_API_TOKEN"
      : hasLogin
        ? "DAYONE_EMAIL + DAYONE_PASSWORD (self-mints token)"
        : "set DAYONE_API_TOKEN, or DAYONE_EMAIL + DAYONE_PASSWORD",
  );
  warn(
    "DAYONE_DEVICE_ID",
    !!process.env.DAYONE_DEVICE_ID,
    process.env.DAYONE_DEVICE_ID
      ? "pinned"
      : "unset — a random device id is generated each run; pin it to stay one device",
  );

  // --- mirror ---
  if (!existsSync(DEFAULT_MIRROR)) {
    check(`mirror (${DEFAULT_MIRROR})`, false, "not found — run `dayone sync`");
  } else {
    const db = openMirror();
    const entries = (db.query("SELECT COUNT(*) c FROM entry").get() as { c: number }).c;
    const media = (db.query("SELECT COUNT(*) c FROM media").get() as { c: number }).c;
    const synced = getSyncedAt(db);
    db.close();
    check(`mirror (${DEFAULT_MIRROR})`, entries > 0, `${entries} entries, ${media} media (metadata)`);
    const ageH = synced ? (Date.now() - Date.parse(synced)) / 3_600_000 : Infinity;
    warn(
      "freshness",
      Number.isFinite(ageH) && ageH < 24,
      synced ? `last synced ${synced} (${ageH.toFixed(1)}h ago)` : "never synced",
    );
  }

  console.error(ok ? "\nhealthy ✓" : "\nissues found ✗");
  return ok ? 0 : 1;
}
