import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { scheduled } from './scheduled.ts';

describe('scheduled', () => {
  it('creates a handler-backed scheduled primitive with storage/timer requirements', () => {
    function handler() {}
    const dataSchema = v.object({ roomId: v.string() });
    const primitive = scheduled('cleanup', (t) => t.data(dataSchema).retry(true).run(handler));

    expect(primitive.__wskit).toBe('scheduled');
    expect(primitive.__kind).toBe('infrastructure');
    expect(primitive.__identity[1]).toBe('cleanup');
    expect(primitive.__requires).toEqual({ storage: true, timers: true });
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
});
