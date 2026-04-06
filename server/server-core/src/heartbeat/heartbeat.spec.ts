import { heartbeat } from '~/heartbeat/heartbeat.ts';
import { describe, expect, it } from 'vitest';

describe('heartbeat', () => {
  it('produces correct tag, kind, and timeout', () => {
    const p = heartbeat({ timeout: 30_000 });
    expect(p.__wskit).toBe('heartbeat');
    expect(p.__kind).toBe('infrastructure');
    expect(p.timeout).toBe(30_000);
  });

  it('uses singleton identity', () => {
    const p = heartbeat({ timeout: 30_000 });
    expect(p.__identity).toHaveLength(1);
    expect(p.__identity[0]).toBe(heartbeat.__key);
  });

  it('instances have empty dependencies and timer requirement', () => {
    const p = heartbeat({ timeout: 30_000 });
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({ timers: true });
  });
});
