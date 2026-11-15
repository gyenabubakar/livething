/* oxlint-disable @typescript-eslint/no-explicit-any */
import { LiveThingConfigError } from '@livething/core';
import { keepalive } from '~/primitives/keepalive/index.ts';
import { describe, expect, it } from 'vitest';

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }

  return undefined;
}

describe('keepalive() config checks', () => {
  it.each([0, -1, 1.5, Number.NaN, '2' as any])(
    'throws for maxMissedPongs %s',
    (maxMissedPongs) => {
      const error = thrownBy(() => keepalive({ maxMissedPongs }));

      expect(error).toBeInstanceOf(LiveThingConfigError);
      expect((error as Error).message).toMatch(/maxMissedPongs/);
    },
  );

  it.each([
    ['a NaN cut-off', { excellent: Number.NaN, good: 300, degraded: 1000 }],
    ['a negative cut-off', { excellent: -1, good: 300, degraded: 1000 }],
    ['a non-number cut-off', { excellent: 100, good: '300' as any, degraded: 1000 }],
    ['a missing cut-off', { excellent: 100, good: 300 } as any],
    ['cut-offs out of order', { excellent: 300, good: 100, degraded: 1000 }],
  ])('throws for thresholds with %s', (_name, thresholds) => {
    const error = thrownBy(() => keepalive({ thresholds }));

    expect(error).toBeInstanceOf(LiveThingConfigError);
    expect((error as Error).message).toMatch(/thresholds/);
  });

  it('accepts valid maxMissedPongs and thresholds', () => {
    expect(() =>
      keepalive({ maxMissedPongs: 3, thresholds: { excellent: 50, good: 200, degraded: 800 } }),
    ).not.toThrow();
  });
});
