import { LiveThingConfigError } from '@livething/core';
import { dedup } from '~/primitives/dedup.ts';
import { describe, expect, it } from 'vitest';

describe('dedup() config checks', () => {
  it.each([Number.NaN, -1])('throws for windowMs %s', (windowMs) => {
    expect(() => dedup({ windowMs })).toThrow(LiveThingConfigError);
  });

  it('accepts a positive windowMs', () => {
    expect(() => dedup({ windowMs: 1000 })).not.toThrow();
  });
});
