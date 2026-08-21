import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { scheduled } from './scheduled.ts';

describe('scheduled', () => {
  it('creates a handler-backed scheduled primitive', () => {
    function handler() {}
    const dataSchema = v.object({ roomId: v.string() });
    const primitive = scheduled('cleanup', (t) => t.data(dataSchema).retry(true).run(handler));

    expect(primitive.__wskit).toBe('scheduled');
    expect(primitive.__kind).toBe('infrastructure');
    expect(primitive.__identity[1]).toBe('cleanup');
    expect(primitive.__requires).toEqual({});
    expect(primitive.handler).toBe(handler);
    expect(primitive.hasData).toBe(true);
    expect(primitive.dataSchema).toBe(dataSchema);
    expect(primitive.options).toEqual({
      retry: true,
    });
  });

  it('creates no-data tasks without a data schema', () => {
    function handler() {}
    const primitive = scheduled('cleanup', (t) => t.retry(false).run(handler));

    expect(primitive.handler).toBe(handler);
    expect(primitive.hasData).toBe(false);
    expect(primitive.dataSchema).toBeUndefined();
    expect(primitive.options).toEqual({ retry: false });
  });

  it('throws when .run(...) is omitted', () => {
    expect(() => scheduled('cleanup', ((t: unknown) => t) as never)).toThrow(/must call \.run/);
  });

  describe('.every() input validation', () => {
    function handler() {}
    function build(value: number) {
      return () => scheduled('tick', (t) => t.every(value).run(handler));
    }

    it('rejects zero', () => {
      expect(build(0)).toThrow(/positive safe integer/);
    });

    it('rejects negative numbers', () => {
      expect(build(-1)).toThrow(/positive safe integer/);
      expect(build(-1000)).toThrow(/positive safe integer/);
    });

    it('rejects fractional numbers', () => {
      expect(build(1.5)).toThrow(/positive safe integer/);
    });

    it('rejects NaN and Infinity', () => {
      expect(build(Number.NaN)).toThrow(/positive safe integer/);
      expect(build(Number.POSITIVE_INFINITY)).toThrow(/positive safe integer/);
      expect(build(Number.NEGATIVE_INFINITY)).toThrow(/positive safe integer/);
    });

    it('accepts positive integers', () => {
      expect(build(1)).not.toThrow();
      expect(build(60_000)).not.toThrow();
    });
  });

  describe('.retry([...]) input validation', () => {
    function handler() {}
    function build(value: readonly number[]) {
      return () => scheduled('tick', (t) => t.retry(value).run(handler));
    }

    it('rejects an empty array', () => {
      expect(() => scheduled('tick', (t) => t.retry([]).run(handler))).toThrow(
        /at least one entry/,
      );
    });

    it('rejects zero entries', () => {
      expect(build([0])).toThrow(/positive safe integer/);
      expect(build([100, 0, 200])).toThrow(/positive safe integer/);
    });

    it('rejects negative entries', () => {
      expect(build([-1])).toThrow(/positive safe integer/);
      expect(build([100, -50])).toThrow(/positive safe integer/);
    });

    it('rejects fractional entries', () => {
      expect(build([1.5])).toThrow(/positive safe integer/);
    });

    it('rejects NaN and Infinity entries', () => {
      expect(build([Number.NaN])).toThrow(/positive safe integer/);
      expect(build([Number.POSITIVE_INFINITY])).toThrow(/positive safe integer/);
      expect(build([Number.NEGATIVE_INFINITY])).toThrow(/positive safe integer/);
    });

    it('accepts a non-empty array of positive integers', () => {
      expect(build([100])).not.toThrow();
      expect(build([50, 100, 200, 1_000])).not.toThrow();
    });

    it('still accepts boolean retry values', () => {
      expect(() => scheduled('tick', (t) => t.retry(true).run(handler))).not.toThrow();
      expect(() => scheduled('tick', (t) => t.retry(false).run(handler))).not.toThrow();
    });
  });

  describe('.data() + .every() rejection', () => {
    function handler() {}

    it('rejects .every(...) called after .data(...)', () => {
      expect(() =>
        scheduled('cleanup', (t) => {
          // The TS overload also blocks this; cast through unknown so the
          // runtime guard can be exercised at the .every(...) call site.
          const builderWithData = t.data(v.object({ batchSize: v.number() })) as unknown as {
            every(ms: number): { run(h: typeof handler): unknown };
          };
          return builderWithData.every(60_000).run(handler) as never;
        }),
      ).toThrow(/cannot combine \.every\(\.\.\.\) with \.data\(\.\.\.\)/);
    });

    it('rejects .data(...) called after .every(...)', () => {
      expect(() =>
        scheduled('cleanup', (t) => {
          // The TS overload disallows this combination; cast through
          // unknown so the runtime guard can be exercised.
          const builderWithEvery = t.every(60_000) as unknown as {
            data(s: ReturnType<typeof v.object>): { run(h: typeof handler): unknown };
          };
          return builderWithEvery.data(v.object({ batchSize: v.number() })).run(handler) as never;
        }),
      ).toThrow(/cannot combine \.data\(\.\.\.\) with \.every\(\.\.\.\)/);
    });

    it('still accepts .data(...) without .every(...)', () => {
      expect(() =>
        scheduled('cleanup', (t) => t.data(v.object({ batchSize: v.number() })).run(handler)),
      ).not.toThrow();
    });

    it('still accepts .every(...) without .data(...)', () => {
      expect(() => scheduled('tick', (t) => t.every(60_000).run(handler))).not.toThrow();
    });
  });
});
