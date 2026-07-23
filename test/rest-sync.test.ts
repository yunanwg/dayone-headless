/**
 * `fetchChangedEntries` (src/ingest/rest/sync.ts) — the bounded-concurrency
 * entry fetch/decrypt/map loop that replaced the fixed-size-batch barrier.
 * Uses a fake `decrypt` — no network/DB/crypto — mirroring the style of
 * test/pool.test.ts and test/media.test.ts's injected-fetcher tests.
 */

import { expect, test } from "bun:test";
import type { EntryRef } from "../src/ingest/rest/reader.ts";
import { fetchChangedEntries } from "../src/ingest/rest/sync.ts";

/** Yields control so other microtasks/timers can interleave. */
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ref = (entryId: string, revisionId = "r1"): EntryRef => ({
  entryId,
  revisionId,
  deleted: false,
  editDate: 1_700_000_000_000,
});

/** Synthetic decrypted content string mapEntry can turn into a DayOneEntry. */
const syntheticContent = (uuid: string) =>
  JSON.stringify({ id: uuid, date: 1_700_000_000_000, body: `synthetic body for ${uuid}` });

test("fetchChangedEntries: every entry is fetched and mapped, none dropped/duplicated", async () => {
  const refs = Array.from({ length: 20 }, (_, i) => ref(`E${String(i).padStart(4, "0")}`));
  const { mapped, done } = await fetchChangedEntries(
    refs,
    async (r) => {
      await tick(1);
      return syntheticContent(r.entryId);
    },
    4,
  );
  expect(mapped.map((e) => e.uuid).sort()).toEqual(refs.map((r) => r.entryId).sort());
  expect(done.map((r) => r.entryId).sort()).toEqual(refs.map((r) => r.entryId).sort());
});

test("fetchChangedEntries: results match a plain sequential fetch (order-independent)", async () => {
  const refs = Array.from({ length: 9 }, (_, i) => ref(`S${i}`));
  const decrypt = async (r: EntryRef) => syntheticContent(r.entryId);

  const pooled = await fetchChangedEntries(refs, decrypt, 3);
  // "Before" behavior: fetch everything sequentially, one at a time.
  const sequential: { mapped: string[]; done: string[] } = { mapped: [], done: [] };
  for (const r of refs) {
    const content = await decrypt(r);
    if (content) {
      sequential.mapped.push(JSON.parse(content).id);
      sequential.done.push(r.entryId);
    }
  }

  expect(pooled.mapped.map((e) => e.uuid).sort()).toEqual(sequential.mapped.sort());
  expect(pooled.done.map((r) => r.entryId).sort()).toEqual(sequential.done.sort());
});

test("fetchChangedEntries: no batch barrier — one slow entry does not hold back the rest", async () => {
  // With the old fixed-slice-of-8 pattern, a slow item in slot 0 would stall the
  // other 7 in its slice until it finished. With a true pool of width 2, "slow"
  // occupies one worker while "fast*" entries stream through the other.
  const order: string[] = [];
  const refs = [ref("slow"), ref("fast1"), ref("fast2"), ref("fast3")];
  await fetchChangedEntries(
    refs,
    async (r) => {
      await tick(r.entryId === "slow" ? 30 : 2);
      order.push(r.entryId);
      return syntheticContent(r.entryId);
    },
    2,
  );
  // "slow" must not be first in completion order despite being first in the queue.
  expect(order[0]).not.toBe("slow");
  expect(order).toContain("slow");
});

test("fetchChangedEntries: a failing entry (decrypt throws) does not abort the rest", async () => {
  const refs = [ref("A"), ref("B"), ref("BOOM"), ref("D"), ref("E")];
  const { mapped, done, failed } = await fetchChangedEntries(
    refs,
    async (r) => {
      if (r.entryId === "BOOM") throw new Error("decrypt failed");
      return syntheticContent(r.entryId);
    },
    2,
  );
  expect(mapped.map((e) => e.uuid).sort()).toEqual(["A", "B", "D", "E"]);
  expect(done.map((r) => r.entryId).sort()).toEqual(["A", "B", "D", "E"]);
  expect(failed).toBe(1);
});

test("fetchChangedEntries: an entry whose key is unavailable counts as incomplete", async () => {
  const refs = [ref("A"), ref("NOKEY"), ref("C")];
  const { mapped, done, failed } = await fetchChangedEntries(
    refs,
    async (r) => (r.entryId === "NOKEY" ? null : syntheticContent(r.entryId)),
    2,
  );
  expect(mapped.map((e) => e.uuid).sort()).toEqual(["A", "C"]);
  expect(done.map((r) => r.entryId).sort()).toEqual(["A", "C"]);
  expect(failed).toBe(1);
});

test("fetchChangedEntries: concurrency 1 behaves like the old sequential path", async () => {
  const order: string[] = [];
  const refs = [ref("1"), ref("2"), ref("3")];
  await fetchChangedEntries(
    refs,
    async (r) => {
      order.push(r.entryId);
      await tick(1);
      return syntheticContent(r.entryId);
    },
    1,
  );
  expect(order).toEqual(["1", "2", "3"]);
});
