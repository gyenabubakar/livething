import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { incoming } from './incoming.ts';

describe('incoming', () => {
  it('creates a handler primitive with repeatable identity keyed by event', () => {
    const handler = vi.fn();
    const primitive = incoming('send-message', handler);

    expect(primitive.__wskit).toBe('incoming');
    expect(primitive.__kind).toBe('handler');
    expect(primitive.__identity[1]).toBe('send-message');
    expect(primitive.handler).toBe(handler);
    expect(primitive.__dependencies).toEqual([]);
    expect(primitive.__requires).toEqual({});
  });

  it('stores optional validators from parse functions and standard schema objects', () => {
    const parse = (value: unknown) => value as { text: string };
    const parsePrimitive = incoming('send-message', vi.fn(), { validator: parse });
    const schemaPrimitive = incoming('send-message', vi.fn(), {
      validator: v.object({ text: v.string() }),
    });

    expect(parsePrimitive.validator).toBe(parse);
    expect(schemaPrimitive.validator).toBeDefined();
  });
});
