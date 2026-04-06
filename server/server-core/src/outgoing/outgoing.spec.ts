import { outgoing } from '~/outgoing/outgoing.ts';
import { t } from '~/t.ts';
import { describe, expect, it } from 'vitest';

describe('outgoing', () => {
  it('produces correct tag and kind', () => {
    const p = outgoing('message', t<{ text: string }>());
    expect(p.__wskit).toBe('outgoing');
    expect(p.__kind).toBe('contract');
  });

  it('produces compound identity keyed by event name', () => {
    const p = outgoing('message', t());
    expect(p.__identity[1]).toBe('message');
  });

  it('stores the event name', () => {
    const p = outgoing('alert', t<{ level: string }>());
    expect(p.event).toBe('alert');
  });

  it('stores the payload marker', () => {
    const marker = t<{ text: string }>();
    const p = outgoing('message', marker);
    expect(p.payload).toBe(marker);
  });

  it('different events have different identities with the same primitive key', () => {
    const a = outgoing('message', t());
    const b = outgoing('alert', t());
    expect(a.__identity[0]).toBe(b.__identity[0]);
    expect(a.__identity[1]).toBe('message');
    expect(b.__identity[1]).toBe('alert');
  });

  it('instances have empty dependencies and requires', () => {
    const p = outgoing('message', t());
    expect(p.__dependencies).toEqual([]);
    expect(p.__requires).toEqual({});
  });
});
