/**
 * Tier A extractor — pull the decrypted DODexie stores out of a driven Day One
 * web app, with a completeness gate so we never ship a partial mirror.
 *
 * The browser functions run against a Playwright `Page` already authenticated and
 * showing the app (see `run.ts` for auth). The pure `computeCompleteness()` is
 * separately testable and is the safety net for the lazy-cache gotcha (recon Q2:
 * a journal can sit at 0 cached entries until it is force-loaded).
 *
 * `entry_counts_cache` is the oracle: it carries the SERVER-side expected counts
 * per journal (entries + photo/video/audio), matching the JSON export exactly.
 */

import type { Page } from "playwright-core";

/** Loose IndexedDB record — untyped, straight from the store. */
type Rec = Record<string, any>;

export interface DODexieDump {
  entries: Rec[];
  moments: Rec[];
  journals: Rec[];
  tags: Rec[];
  entry_counts_cache: Rec[];
}

/** Stores we pull. `entry_counts_cache` is for the completeness gate, not mapping. */
const DUMP_STORES = ["entries", "moments", "journals", "tags", "entry_counts_cache"] as const;

/**
 * Dump the Tier-A stores from the page's `DODexie` IndexedDB. Runs entirely
 * in-page (this is the exact read proven during Phase 0 recon), so only plain
 * JSON crosses back — no live handles.
 */
export async function extractStores(page: Page): Promise<DODexieDump> {
  const dump = await page.evaluate(async (storeNames: string[]) => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const q = indexedDB.open("DODexie");
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    const readAll = (store: string) =>
      new Promise<any[]>((res) => {
        const out: any[] = [];
        const cur = db.transaction(store, "readonly").objectStore(store).openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { out.push(c.value); c.continue(); } else res(out);
        };
        cur.onerror = () => res(out);
      });
    const result: Record<string, any[]> = {};
    for (const s of storeNames) {
      result[s] = db.objectStoreNames.contains(s) ? await readAll(s) : [];
    }
    db.close();
    return result;
  }, DUMP_STORES as unknown as string[]);
  return dump as unknown as DODexieDump;
}

export interface JournalCompleteness {
  journalId: string;
  name: string;
  expectedEntries: number;
  loadedEntries: number;
  expectedMedia: number;
  loadedMedia: number;
  complete: boolean;
}

/**
 * Compare loaded records against `entry_counts_cache` (the server-side truth).
 * PURE — the core of the completeness gate.
 */
export function computeCompleteness(dump: DODexieDump): JournalCompleteness[] {
  const nameById = new Map<string, string>();
  for (const j of dump.journals) {
    if (j?.id != null) nameById.set(String(j.id), String(j.name ?? `journal-${j.id}`));
  }

  const loadedEntries = new Map<string, number>();
  for (const e of dump.entries) {
    if (e?.is_deleted) continue; // deleted rows don't count toward completeness
    const k = String(e?.journal_id);
    loadedEntries.set(k, (loadedEntries.get(k) ?? 0) + 1);
  }
  const loadedMedia = new Map<string, number>();
  for (const m of dump.moments) {
    const k = String(m?.journal_id);
    loadedMedia.set(k, (loadedMedia.get(k) ?? 0) + 1);
  }

  return dump.entry_counts_cache.map((c) => {
    const id = String(c.journal_id);
    const expectedEntries = Number(c.count ?? 0);
    const expectedMedia =
      Number(c.photo ?? 0) + Number(c.video ?? 0) + Number(c.audio ?? 0) + Number(c.pdf ?? 0);
    const loadedE = loadedEntries.get(id) ?? 0;
    const loadedM = loadedMedia.get(id) ?? 0;
    return {
      journalId: id,
      name: nameById.get(id) ?? `journal-${id}`,
      expectedEntries,
      loadedEntries: loadedE,
      expectedMedia,
      loadedMedia: loadedM,
      // Media can legitimately lag (thumbnails/promises); entries are the gate.
      complete: loadedE >= expectedEntries,
    };
  });
}

/** Journals still missing entries — the extractor must resolve these before dumping. */
export function incompleteJournals(rows: JournalCompleteness[]): JournalCompleteness[] {
  return rows.filter((r) => !r.complete);
}

/**
 * Force every journal's entries to load (recon Q2: the web cache is lazy — a
 * journal stays at 0 entries until visited). Opens each journal in turn and polls
 * `entry_counts_cache` vs loaded entries until complete or `timeoutMs` elapses.
 *
 * `openJournal` is the app-navigation step; its exact route/trigger still needs a
 * joint recon pass (see docs/tier-a-extractor.md) — kept injectable so the poll
 * loop and completeness logic are testable/stable regardless.
 */
export async function forceLoadAllJournals(
  page: Page,
  openJournal: (page: Page, journalId: string) => Promise<void>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<JournalCompleteness[]> {
  const timeoutMs = opts.timeoutMs ?? 180_000; // per journal (a big journal takes a while)
  const pollMs = opts.pollMs ?? 2_000;

  let rows = computeCompleteness(await extractStores(page));
  for (const j of rows) {
    if (j.complete) continue;
    await openJournal(page, j.journalId);
    // Each journal gets its own budget — one large journal must not starve later ones.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(pollMs);
      rows = computeCompleteness(await extractStores(page));
      const cur = rows.find((r) => r.journalId === j.journalId);
      if (cur?.complete) break;
    }
  }
  return rows;
}
