import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import { incoming } from './incoming.ts';

describe('incoming', () => {
  it('creates a handler primitive with repeatable identity keyed by event', () => {
    const handler = vi.fn();
    const primitive = incoming('send-message', handler);

    expect(primitive.__livething).toBe('incoming');
    expect(primitive.__kind).toBe('handler');
    expect(primitive.__identity[1]).toBe('send-message');
    expect(primitive.handler).toBe(handler);
    expect(primitive.__requires).toEqual({});
  });

  it('stores an optional standard-schema validator', () => {
    const schemaPrimitive = incoming('send-message', vi.fn(), {
      validator: v.object({ text: v.string() }),
    });

    expect(schemaPrimitive.validator).toBeDefined();
  });
});
