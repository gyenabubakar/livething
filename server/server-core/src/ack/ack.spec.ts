import { ack } from '~/ack/ack.ts';
import { describe, expect, it } from 'vitest';

describe('ack', () => {
  it('produces correct tag and kind', () => {
    const p = ack();
    expect(p.__wskit).toBe('ack');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = ack();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(ack.__key);
  });

  it('instances have empty dependencies and requires', () => {
    const p = ack();
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });

  it('factory has a symbol key for dependency references', () => {
    expect(typeof ack.__key).toBe('symbol');
  });
});
