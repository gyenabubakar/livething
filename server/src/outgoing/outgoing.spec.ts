import { t } from '~/_api/definitions.ts';
import { emits } from '~/emits/emits.ts';
import { describe, expect, it } from 'vitest';
import { outgoing } from './outgoing.ts';

describe('outgoing', () => {
  it('creates a contract primitive keyed by event name', () => {
    const primitive = outgoing<'message', { text: string }>('message');

    expect(primitive.__livething).toBe('outgoing');
    expect(primitive.__identity[1]).toBe('message');
    expect(primitive.event).toBe('message');
    expect(primitive.__requires).toEqual({});
  });

  it('refuses a reserved event name declared through emits', () => {
    expect(() => emits({ __x: t<{ text: string }>() })).toThrow(/reserved/);
  });
});
