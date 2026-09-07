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

  it('passes the first frame, then throws RateLimited with a positive retryAfterMs when max=1', async () => {
    const prim = rateLimit({
      scopeRules: new Map([
        ['top', { id: 1, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }],
      ]),
      eventOverrides: new Map(),
    }) as any;
    const ctx = { id: 'c1' };

    expect(await prim.handler(ctx, { event: 'e', payload: {} })).toBeUndefined();

    let caught: any;
    try {
      await prim.handler(ctx, { event: 'e', payload: {} });
    } catch (err) {
      caught = err;
    }

    expect(RateLimited.matches(caught)).toBe(true);
    expect(caught.detail.retryAfterMs).toBeGreaterThanOrEqual(1_000);
  });
});
