/* oxlint-disable @typescript-eslint/no-explicit-any */
import { RateLimited } from '@wskit/core';
import { describe, expect, it } from 'vitest';
import { rateLimit } from './rate-limit.ts';

describe('rateLimit primitive', () => {
  it('returns an intercept primitive', () => {
    const prim = rateLimit({
      scopeRules: new Map([
        ['top', { id: 1, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }],
      ]),
      eventOverrides: new Map(),
    }) as any;
    expect(prim.__wskit).toBe('intercept');
    expect(typeof prim.handler).toBe('function');
  });

  it('passes the first frame and throws RateLimited on the second when max=1', async () => {
    const prim = rateLimit({
      scopeRules: new Map([
        ['top', { id: 1, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }],
      ]),
      eventOverrides: new Map(),
    }) as any;
    const ctx = { id: 'c1' };
    expect(await prim.handler(ctx, { event: 'e', payload: {} })).toBeUndefined();
    let caught: unknown;
    try {
      await prim.handler(ctx, { event: 'e', payload: {} });
    } catch (err) {
      caught = err;
    }
    expect(RateLimited.matches(caught)).toBe(true);
  });

  it('throws with a positive retryAfter on rejection', async () => {
    const prim = rateLimit({
      scopeRules: new Map([
        ['top', { id: 1, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }],
      ]),
      eventOverrides: new Map(),
    }) as any;
    const ctx = { id: 'c1' };
    await prim.handler(ctx, { event: 'e', payload: {} });
    try {
      await prim.handler(ctx, { event: 'e', payload: {} });
      throw new Error('did not throw');
    } catch (err: any) {
      expect(RateLimited.matches(err)).toBe(true);
      expect(err.detail.retryAfter).toBeGreaterThanOrEqual(1);
    }
  });
});
