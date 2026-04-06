import { error } from '~/errors.ts';
import { errors } from '~/primitives/errors.ts';
import { describe, expect, it } from 'vitest';

const Forbidden = error('forbidden', (value: unknown) => value as { reason: string });
const ChannelNotFound = error(
  'channel-not-found',
  (value: unknown) => value as { channel: string },
);

describe('errors', () => {
  it('produces correct tag and kind', () => {
    const p = errors(Forbidden);
    expect(p.__wskit).toBe('errors');
    expect(p.__kind).toBe('contract');
  });

  it('uses singleton identity', () => {
    const p = errors(Forbidden);
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(errors.__key);
  });

  it('stores defs in order', () => {
    const p = errors(Forbidden, ChannelNotFound);
    expect(p.defs).toHaveLength(2);
    expect(p.defs[0]).toBe(Forbidden);
    expect(p.defs[1]).toBe(ChannelNotFound);
  });

  it('instances have empty dependencies and requires', () => {
    const p = errors(Forbidden);
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });

  it('factory has a symbol key for dependency references', () => {
    expect(typeof errors.__key).toBe('symbol');
  });
});
