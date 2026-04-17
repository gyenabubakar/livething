import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { scheduled } from './scheduled.ts';

describe('scheduled', () => {
  it('creates a handler-backed scheduled primitive with storage/timer requirements', () => {
    function handler() {}
    const dataSchema = v.object({ roomId: v.string() });
    const primitive = scheduled('cleanup', handler, {
      every: 60_000,
      retry: true,
      data: dataSchema,
    });

    expect(primitive.__wskit).toBe('scheduled');
    expect(primitive.__kind).toBe('infrastructure');
    expect(primitive.__identity[1]).toBe('cleanup');
    expect(primitive.__requires).toEqual({ storage: true, timers: true });
    expect(primitive.handler).toBe(handler);
    expect(primitive.dataSchema).toBe(dataSchema);
    expect(primitive.options).toEqual({
      every: 60_000,
      retry: true,
      data: dataSchema,
    });
  });

  it('treats standard schema values as schema-only declarations', () => {
    const schema = v.object({ roomId: v.string() });
    const primitive = scheduled('cleanup', schema, { retry: false });

    expect(primitive.handler).toBeUndefined();
    expect(primitive.dataSchema).toBe(schema);
    expect(primitive.options).toEqual({ retry: false });
  });
});
