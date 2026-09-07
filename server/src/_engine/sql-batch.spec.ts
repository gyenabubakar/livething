import { isWSKitConfigError, WSKitConfigError } from '@wskit/core';
import { describe, expect, it } from 'vitest';
import type { SqlLimits } from '~/context.ts';
import { chunkForBind } from './sql-batch.ts';

const limits: SqlLimits = {
  maxBoundParams: 10,
  maxStatementBytes: 100_000,
  maxValueBytes: 2_000_000,
};

describe('chunkForBind', () => {
  it('keeps every batch at or under maxBoundParams', () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const batches = chunkForBind(items, 3, limits);

    for (const batch of batches) {
      expect(batch.length * 3).toBeLessThanOrEqual(limits.maxBoundParams);
    }
  });

  it('sizes each batch to floor(maxBoundParams / paramsPerItem)', () => {
    const items = Array.from({ length: 9 }, (_, i) => i);
    const batches = chunkForBind(items, 3, limits); // floor(10 / 3) = 3 per batch

    expect(batches).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ]);
  });

  it('covers every item across batches with none dropped or duplicated', () => {
    const items = Array.from({ length: 47 }, (_, i) => i);
    const batches = chunkForBind(items, 4, limits);

    expect(batches.flat()).toEqual(items);
  });

  it('returns an empty array for empty input — not one empty batch', () => {
    expect(chunkForBind([], 2, limits)).toEqual([]);
  });

  it('returns one batch when everything fits under the limit', () => {
    const items = [1, 2];
    expect(chunkForBind(items, 2, limits)).toEqual([[1, 2]]);
  });

  it('throws a WSKitConfigError naming the limit when paramsPerItem alone exceeds maxBoundParams', () => {
    let captured: unknown;
    try {
      chunkForBind([1, 2, 3], 11, limits);
    } catch (error) {
      captured = error;
    }

    expect(isWSKitConfigError(captured)).toBe(true);
    expect(String(captured)).toMatch(/10/);
    expect(String(captured)).toMatch(/11/);
  });

  it('does not loop forever or return empty batches when paramsPerItem exceeds the limit', () => {
    expect(() => chunkForBind([1, 2, 3], 11, limits)).toThrow();
  });

  it('throws for paramsPerItem of zero', () => {
    expect(() => chunkForBind([1, 2, 3], 0, limits)).toThrow(WSKitConfigError);
  });

  it('throws for a negative paramsPerItem', () => {
    expect(() => chunkForBind([1, 2, 3], -1, limits)).toThrow(WSKitConfigError);
  });

  it('throws for a non-integer paramsPerItem', () => {
    expect(() => chunkForBind([1, 2, 3], 1.5, limits)).toThrow(WSKitConfigError);
  });
});
