#!/usr/bin/env bun
/**
 * Tier A ingester — orchestrator.
 *
 *   drive web app (authenticated) → force-load every journal → dump DODexie →
 *   COMPLETENESS GATE → map to export shape → importExport() → mirror
 *
 * The serving layer is untouched: this reuses the JSON-export importer verbatim.
 * Secrets come only from the environment and are never logged.
 *
 * Env:
 *   DAYONE_PROFILE_DIR   (required) persistent Chromium profile — gitignored,
 *                        tight perms; log in once (headed) via the passphrase path.
 *   DAYONE_HEADLESS      "1" headless (default), "0" headed (needed for first login).
 *   DAYONE_CHROMIUM      optional executablePath; else falls back to system Chrome.
 *   DAYONE_MIRROR        mirror db path (default mirror.db, see open.ts).
 *   DAYONE_STRICT        "0" to allow writing an incomplete mirror (default: strict).
 *   DAYONE_EMAIL/PASSWORD/PASSPHRASE + DAYONE_AUTOMATED_LOGIN=1  (automated login;
 *                        scaffold — see login.ts).
 */

import { chromium, type BrowserContext, type Page } from "playwright-core";
import { openMirror } from "../../serve/db/open.ts";
import { importExport } from "../json-export/import.ts";
import { mapStoresToExports } from "./map.ts";
import {
  extractStores,
  computeCompleteness,
  incompleteJournals,
  forceLoadAllJournals,
} from "./extract.ts";
import { isAuthenticated, waitForAuthenticated, automatedLogin } from "./login.ts";

const APP_URL = process.env.DAYONE_URL ?? "https://dayone.me/";
const HEADLESS = process.env.DAYONE_HEADLESS !== "0";
const STRICT = process.env.DAYONE_STRICT !== "0";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

async function launch(profileDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    headless: HEADLESS,
    executablePath: process.env.DAYONE_CHROMIUM || undefined,
    channel: process.env.DAYONE_CHROMIUM ? undefined : "chrome",
  });
}

/**
 * App navigation to force a journal's entries to sync into IndexedDB.
 * TODO(recon): confirm the per-journal route/trigger. Until then this reloads the
 * app (which syncs the active journal set); the completeness gate below is the
 * real guarantee — it refuses to write a partial mirror regardless.
 */
async function openJournal(page: Page, _journalId: string): Promise<void> {
  await page.goto(APP_URL, { waitUntil: "networkidle" }).catch(() => {});
}

async function ensureAuth(page: Page): Promise<void> {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  if (await isAuthenticated(page)) return;

  if (process.env.DAYONE_AUTOMATED_LOGIN === "1") {
    await automatedLogin(page, {
      email: requireEnv("DAYONE_EMAIL"),
      password: requireEnv("DAYONE_PASSWORD"),
      passphrase: requireEnv("DAYONE_PASSPHRASE"),
    });
    return;
  }

  if (HEADLESS) {
    throw new Error(
      "not authenticated and running headless. Run once with DAYONE_HEADLESS=0 and complete " +
        "login (email + password + encryption passphrase) in the browser window; the persistent " +
        "profile keeps the session for subsequent headless runs.",
    );
  }
  console.error("Waiting for manual login in the browser window (passphrase path, not Apple 2FA)…");
  if (!(await waitForAuthenticated(page))) throw new Error("timed out waiting for manual login");
}

async function main(): Promise<void> {
  const profileDir = requireEnv("DAYONE_PROFILE_DIR");
  const context = await launch(profileDir);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await ensureAuth(page);
    console.error("authenticated; force-loading all journals…");
    const rows = await forceLoadAllJournals(page, openJournal);

    for (const r of rows) {
      const mark = r.complete ? "ok" : "INCOMPLETE";
      console.error(
        `  [${mark}] ${r.name}: entries ${r.loadedEntries}/${r.expectedEntries}, media ${r.loadedMedia}/${r.expectedMedia}`,
      );
    }
    const missing = incompleteJournals(rows);
    if (missing.length && STRICT) {
      throw new Error(
        `refusing to write a partial mirror: ${missing.length} journal(s) incomplete ` +
          `(${missing.map((m) => m.name).join(", ")}). Set DAYONE_STRICT=0 to override.`,
      );
    }
    if (missing.length) console.error(`WARNING: writing an incomplete mirror (DAYONE_STRICT=0).`);

    const dump = await extractStores(page);
    const exports = mapStoresToExports(dump);

    const db = openMirror(undefined, { writable: true });
    let entries = 0;
    for (const { journalName, export: exp } of exports) {
      const stats = importExport(db, exp, journalName);
      entries += stats.entries;
      console.error(`  imported ${journalName}: ${stats.entries} entries, ${stats.media} media`);
    }
    db.close();
    console.error(`done: ${entries} entries across ${exports.length} journals → mirror`);
  } finally {
    await context.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}
