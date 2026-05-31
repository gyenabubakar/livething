import { describe, expect, it } from 'vitest';
import { outgoing } from './outgoing.ts';

describe('outgoing', () => {
  it('creates a contract primitive keyed by event name', () => {
    const primitive = outgoing<'message', { text: string }>('message');

    expect(primitive.__wskit).toBe('outgoing');
    expect(primitive.__kind).toBe('contract');
    expect(primitive.__identity[1]).toBe('message');
    expect(primitive.event).toBe('message');
    expect(primitive.__requires).toEqual({});
  });
});
