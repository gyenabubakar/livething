import { intercept } from '~/intercept/intercept.ts';
import { describe, expect, it } from 'vitest';

describe('intercept', () => {
  it('creates an intercept primitive', () => {
    async function handler() {}

    const p = intercept(handler);

    expect(p.__livething).toBe('intercept');
    expect(p.handler).toBe(handler);
  });

  it('uses repeatable identity', () => {
    const a = intercept(async () => {});
    const b = intercept(async () => {});

    expect(a.__identity).toEqual(b.__identity);
    expect(a.__identity[1]).toBe('intercept');
  });

  it('instances have empty requires', () => {
    const p = intercept(async () => {});
    expect(p.__requires).toEqual({});
  });
});
