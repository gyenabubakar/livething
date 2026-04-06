import { dedup } from '~/dedup/dedup.ts';
import { replay } from '~/replay/replay.ts';
import { sequence } from '~/sequence/sequence.ts';
import { describe, expect, it } from 'vitest';

describe('replay', () => {
  it('produces correct tag and kind', () => {
    const p = replay();
    expect(p.__wskit).toBe('replay');
    expect(p.__kind).toBe('infrastructure');
  });

  it('uses singleton identity', () => {
    const p = replay();
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(replay.__key);
  });

  it('declares dependencies and requires', () => {
    const p = replay();
    expect(p.__dependencies).toEqual([sequence, dedup]);
    expect(p.__requires).toEqual({ storage: true });
  });

  it('stores the onReplay handler when provided', () => {
    async function handler() {}
    const p = replay({ onReplay: handler });
    expect(p.onReplay).toBe(handler);
  });
});
