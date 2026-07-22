/**
 * Tier A auth — get the driven browser into an authenticated, journals-decrypted
 * state, WITHOUT this code ever owning the secrets.
 *
 * Two paths:
 *  1. Persistent profile + one-time manual login (the supported MVP). A dedicated,
 *     gitignored Chromium profile is logged in once by a human — email + password
 *     + the Day One **encryption passphrase** (the typeable decrypt path; NOT the
 *     Apple/Secure-Enclave unlock, which can't be driven headless). The session
 *     persists in the profile, so later headless runs are already authenticated.
 *  2. Automated passphrase login (scaffold). Types credentials sourced from the
 *     environment at runtime. The exact form selectors still need a joint recon
 *     pass — until then this throws rather than fake it.
 *
 * SECURITY: credentials/passphrase are only ever read from the environment by the
 * caller and passed in here transiently. They are never logged, echoed, or
 * persisted by this module. The passphrase decrypts the entire journal — treat
 * the profile dir like a private key at rest (tight perms, gitignored).
 */

import type { Page } from "playwright-core";

/** True once the app has loaded a decrypted journal (entries present in DODexie). */
export async function isAuthenticated(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === "DODexie")) return false;
      const db: IDBDatabase = await new Promise((res, rej) => {
        const q = indexedDB.open("DODexie");
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const has = db.objectStoreNames.contains("entries");
      const n = has
        ? await new Promise<number>((res) => {
            const c = db.transaction("entries", "readonly").objectStore("entries").count();
            c.onsuccess = () => res(c.result);
            c.onerror = () => res(0);
          })
        : 0;
      db.close();
      return n > 0;
    } catch {
      return false;
    }
  });
}

/** Poll until authenticated or timeout — used by the manual-login flow. */
export async function waitForAuthenticated(page: Page, timeoutMs = 300_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAuthenticated(page)) return true;
    await page.waitForTimeout(2_000);
  }
  return false;
}

export interface Credentials {
  email: string;
  password: string;
  /** The Day One encryption passphrase (master key) — the typeable decrypt path. */
  passphrase: string;
}

/**
 * Automated login using the passphrase path. SCAFFOLD: the login/decrypt form
 * selectors are not yet confirmed (Day One's sign-in appears to route through an
 * Automattic/WordPress SSO — see recon notes). This must be filled in during a
 * joint recon pass where a human drives one login while we capture the DOM/flow.
 * Throwing here is deliberate — we do not ship guessed credential-entry code.
 */
export async function automatedLogin(_page: Page, creds: Credentials): Promise<void> {
  // Fail fast on missing secrets (never log their values).
  for (const k of ["email", "password", "passphrase"] as const) {
    if (!creds[k]) throw new Error(`automatedLogin: missing credential "${k}"`);
  }
  throw new Error(
    "automatedLogin: login/decrypt selectors not yet confirmed. Use the persistent-profile " +
      "manual-login flow (run headed once), or complete a joint recon pass to wire this. " +
      "See docs/tier-a-extractor.md.",
  );
}
