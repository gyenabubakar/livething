import { WSKitConfigError } from '@wskit/core';
import type { SqlLimits } from '~/context.ts';

/**
 * Split `items` into batches sized so each batch's bound-parameter count stays
 * at or under `limits.maxBoundParams`.
 *
 * Every call site that builds one SQL statement per batch of items (a batched
 * `INSERT`, a `WHERE id IN (...)`, and similar) needs this — the adapter's
 * `SqlLimits.maxBoundParams` caps how many `?` placeholders one statement may
 * carry, and that cap is as low as 100 on Cloudflare. Do the batch-size math
 * here, once, instead of at each call site.
 *
 * `paramsPerItem` is how many `?` placeholders one item contributes (2 for
 * `(?, ?)` per row, 1 for a single `id IN (...)` entry). Each returned batch
 * holds at most `floor(limits.maxBoundParams / paramsPerItem)` items.
 *
 * An empty `items` returns an empty array — no batches, not one empty batch —
 * so a caller can `for (const batch of chunkForBind(...))` without a
 * zero-length special case.
 *
 * ```ts
 * const batches = chunkForBind(rows, 2, limits); // 2 params per row: (?, ?)
 * for (const batch of batches) {
 *   const placeholders = batch.map(() => '(?, ?)').join(', ');
 *   ctx.sql.exec(
 *     `INSERT INTO t (a, b) VALUES ${placeholders}`,
 *     ...batch.flatMap((row) => [row.a, row.b]),
 *   );
 * }
 * ```
 */
export function chunkForBind<T>(
  items: readonly T[],
  paramsPerItem: number,
  limits: SqlLimits,
): T[][] {
  if (!Number.isInteger(paramsPerItem) || paramsPerItem <= 0) {
    throw new WSKitConfigError(
      `chunkForBind: 'paramsPerItem' must be a positive integer, got ${paramsPerItem}.`,
    );
  }

  if (paramsPerItem > limits.maxBoundParams) {
    throw new WSKitConfigError(
      `chunkForBind: this adapter's SQL engine allows at most ${limits.maxBoundParams} bound parameters per statement, but a single item needs ${paramsPerItem}. No batch size can satisfy that — reduce the number of columns bound per item.`,
    );
  }

  if (items.length === 0) return [];

  const batchSize = Math.floor(limits.maxBoundParams / paramsPerItem);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  return batches;
}
