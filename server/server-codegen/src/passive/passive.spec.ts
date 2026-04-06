import { dedup } from '~/dedup/dedup.ts';
import { heartbeat } from '~/heartbeat/heartbeat.ts';
import { passive } from '~/passive/passive.ts';
import { sequence } from '~/sequence/sequence.ts';
import { describe, expect, it } from 'vitest';

describe('passive', () => {
  it('produces correct tag and kind', () => {
    const p = passive(heartbeat({ timeout: 30_000 }), sequence(), dedup());
    expect(p.__wskit).toBe('passive');
    expect(p.__kind).toBe('infrastructure');
  });

  it('stores child primitives in order', () => {
    const p = passive(heartbeat({ timeout: 30_000 }), sequence(), dedup());
    expect(p.primitives).toHaveLength(3);
    expect(p.primitives[0]!.__wskit).toBe('heartbeat');
    expect(p.primitives[1]!.__wskit).toBe('sequence');
    expect(p.primitives[2]!.__wskit).toBe('dedup');
    expect(Object.isFrozen(p.primitives)).toBe(true);
  });

  it('uses one stable primitive ref', () => {
    const p = passive(sequence());
    expect(p.__identity[0]).toBe(passive.__key);
  });
});
