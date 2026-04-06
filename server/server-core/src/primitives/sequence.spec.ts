import { sequence } from '~/primitives/sequence.ts';
import { describe, expect, it } from 'vitest';

describe('sequence', () => {
  it('produces correct tag and kind', () => {
    const p = sequence();
    expect(p.__wskit).toBe('sequence');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = sequence();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(sequence.__key);
  });

  it('instances have empty dependencies and requires', () => {
    const p = sequence();
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
