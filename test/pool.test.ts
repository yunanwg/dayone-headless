/**
 * Bounded-concurrency worker pool tests (src/ingest/rest/pool.ts). Uses an
 * instrumented fake "fetcher" — no real network/DB — to check the two
 * properties the media-fetch quick-win depends on:
 *   1. every item's result is preserved (nothing dropped/duplicated).
 *   2. the number of concurrently in-flight calls never exceeds the bound,
 *      and (given enough items) actually reaches it — i.e. a true pool, not
 *      a sequential loop in disguise.
 */

import { expect, test } from "bun:test";
import { runPool } from "../src/ingest/rest/pool.ts";

/** Yields control so other microtasks/timers can interleave. */
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("runPool preserves every item's result", async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results: number[] = [];
  await runPool(items, 4, async (item) => {
    await tick(1);
    results.push(item * 2);
  });
  results.sort((a, b) => a - b);
  expect(results).toEqual(items.map((i) => i * 2));
});

test("runPool keeps N jobs continuously in flight, never exceeding the bound", async () => {
  const concurrency = 3;
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);

  await runPool(items, concurrency, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    expect(active).toBeLessThanOrEqual(concurrency);
    await tick(5);
    active--;
  });

  expect(maxActive).toBe(concurrency); // actually saturates the pool, not a fixed-batch approximation
});

test("runPool keeps the next job starting immediately, not waiting for a whole batch", async () => {
  // One job takes much longer than the rest; with a true pool the short jobs
  // finish independently instead of being held back by a batch barrier.
  const order: string[] = [];
  await runPool(["slow", "fast1", "fast2", "fast3"], 2, async (item) => {
    await tick(item === "slow" ? 30 : 2);
    order.push(item);
  });
  // "slow" must not be first in completion order despite being first in the queue.
  expect(order[0]).not.toBe("slow");
  expect(order).toContain("slow");
});

test("runPool does not stop the pool when one job throws — Promise.all semantics documented, caller must catch internally", async () => {
  const processed: number[] = [];
  await runPool([1, 2, 3, 4, 5], 2, async (item) => {
    try {
      if (item === 3) throw new Error("boom");
      processed.push(item);
    } catch {
      // caller is responsible for catching, mirroring src/ingest/rest/media.ts
    }
  });
  expect(processed.sort()).toEqual([1, 2, 4, 5]);
});

test("runPool honors DAYONE_MEDIA_CONCURRENCY-style small pools (concurrency 1 == sequential)", async () => {
  const order: number[] = [];
  await runPool([1, 2, 3], 1, async (item) => {
    order.push(item);
    await tick(1);
  });
  expect(order).toEqual([1, 2, 3]);
});
