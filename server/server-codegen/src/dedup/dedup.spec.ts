import { dedup } from '~/dedup/dedup.ts';
import { describe, expect, it } from 'vitest';

describe('dedup', () => {
  it('produces correct tag and kind', () => {
    const p = dedup();
    expect(p.__wskit).toBe('dedup');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = dedup();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(dedup.__key);
  });

  it('instances have empty dependencies and requires', () => {
    const p = dedup();
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
