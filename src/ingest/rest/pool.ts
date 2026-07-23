/**
 * Bounded-concurrency worker pool. Keeps up to `concurrency` calls to `run` in
 * flight continuously — as soon as one finishes, the next queued item starts —
 * rather than fetching in fixed-size batches with a barrier between each batch.
 *
 * A per-item failure does not stop the pool by itself: if `run` should treat a
 * rejection as non-fatal (log it and move on), it must catch it internally.
 * An uncaught rejection from `run` propagates through `Promise.all` as usual.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(concurrency, items.length || 1));
  const workers = Array.from({ length: poolSize }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      await run(item, index);
    }
  });
  await Promise.all(workers);
}
