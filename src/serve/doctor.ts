/**
 * `daytwo doctor` — a config + mirror self-check. Reports the PRESENCE and shape
 * of secrets, never their values. Returns 0 when healthy, 1 otherwise.
 */

import { existsSync } from "node:fs";
import { parseMasterKey } from "../ingest/rest/crypto.ts";
import { checkLocalPermissions, formatMode } from "../local-permissions.ts";
import { MEDIA_DIR } from "../media-cache.ts";
import { readSecret } from "../secret-config.ts";
import { DEFAULT_MIRROR, openMirror } from "./db/open.ts";
import { getSyncedAt } from "./queries.ts";

export async function doctor(
  opts: { fixPermissions?: boolean; servingOnly?: boolean } = {},
): Promise<number> {
  let ok = true;
  const check = (label: string, good: boolean, detail = "") => {
    console.error(`${good ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!good) ok = false;
  };
  const warn = (label: string, good: boolean, detail = "") =>
    console.error(`${good ? "✓" : "○"} ${label}${detail ? ` — ${detail}` : ""}`);

  // --- config ---
  if (!opts.servingOnly) {
    let keyOk = false;
    let keyConfigured = false;
    try {
      const key = readSecret("DAYONE_ENCRYPTION_KEY");
      keyConfigured = key !== undefined;
      if (key) {
        parseMasterKey(key);
        keyOk = true;
      }
    } catch {
      keyConfigured = true;
    }
    check(
      "DAYONE_ENCRYPTION_KEY",
      keyOk,
      keyOk
        ? "valid D1-<userId>-<code…> format"
        : keyConfigured
          ? "configured, but invalid or unreadable"
          : "not configured",
    );

    let hasToken = false;
    let hasLogin = false;
    let authInvalid = false;
    try {
      hasToken = readSecret("DAYONE_API_TOKEN") !== undefined;
      hasLogin = readSecret("DAYONE_EMAIL") !== undefined && readSecret("DAYONE_PASSWORD") !== undefined;
    } catch {
      authInvalid = true;
    }
    check(
      "auth",
      !authInvalid && (hasToken || hasLogin),
      authInvalid
        ? "secret configuration is conflicting, empty, or unreadable"
        : hasToken
          ? "DAYONE_API_TOKEN"
          : hasLogin
            ? "DAYONE_EMAIL + DAYONE_PASSWORD (self-mints token)"
            : "configure DAYONE_API_TOKEN, or DAYONE_EMAIL + DAYONE_PASSWORD",
    );
    warn(
      "DAYONE_DEVICE_ID",
      !!process.env.DAYONE_DEVICE_ID,
      process.env.DAYONE_DEVICE_ID
        ? "pinned"
        : "unset — a random device id is generated each run; pin it to stay one device",
    );
  }

  // --- local plaintext permissions ---
  const permissions = checkLocalPermissions(DEFAULT_MIRROR, MEDIA_DIR, {
    fix: opts.fixPermissions,
    // Bun's project-local dotenv convention. Do not infer or chmod arbitrary
    // env-file paths; Compose injects its host-side env_file without mounting it.
    envFilePath: ".env",
  });
  if (permissions.issues.length === 0) {
    check(
      "local plaintext permissions",
      true,
      `${permissions.checked} path(s) owner-only${permissions.fixed ? `; fixed ${permissions.fixed}` : ""}`,
    );
  } else {
    const modes = permissions.issues
      .filter((issue) => issue.actualMode !== undefined)
      .map((issue) => formatMode(issue.actualMode));
    check(
      "local plaintext permissions",
      false,
      `${permissions.issues.length} unsafe/unreadable path(s)` +
        `${modes.length ? ` (mode${modes.length === 1 ? "" : "s"} ${[...new Set(modes)].join(", ")})` : ""}` +
        `${opts.fixPermissions ? `; fixed ${permissions.fixed}` : "; run `daytwo doctor --fix-permissions`"}`,
    );
  }

  // --- mirror ---
  if (!existsSync(DEFAULT_MIRROR)) {
    check(`mirror (${DEFAULT_MIRROR})`, false, "not found — run `daytwo sync`");
  } else {
    // Permission diagnosis above must remain non-mutating unless the explicit
    // repair flag was supplied.
    const db = openMirror(DEFAULT_MIRROR, { hardenPermissions: opts.fixPermissions === true });
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
