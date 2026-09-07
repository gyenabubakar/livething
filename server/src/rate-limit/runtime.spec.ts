/* oxlint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { RateLimitRuntime, resolveScopeKey } from './runtime.ts';
import type { ResolvedRateLimitPlan } from './runtime.ts';

interface Clock {
  now: number;
  advance(ms: number): void;
  read(): number;
}

function clock(): Clock {
  const c = {
    now: 1_000_000,
    advance(ms: number) {
      this.now += ms;
    },
    read() {
      return this.now;
    },
  };

  return c;
}

function plan(rules: ConstructorParameters<typeof Map>[0]): ResolvedRateLimitPlan {
  return {
    scopeRules: new Map(rules as any),
    eventOverrides: new Map(),
  };
}

function withOverrides(
  scope: Array<[string, any]>,
  overrides: Array<[string, Array<[string, any]>]>,
): ResolvedRateLimitPlan {
  return {
    scopeRules: new Map(scope),
    eventOverrides: new Map(overrides.map(([k, v]) => [k, new Map(v)])),
  };
}

describe('resolveScopeKey', () => {
  it('returns "top" for a context without scope', () => {
    expect(resolveScopeKey({ id: 'c1' })).toBe('top');
  });

  it('uses channel family key when present', () => {
    expect(resolveScopeKey({ id: 'c1', channel: { name: 'room-1', family: 'rooms' } })).toBe(
      'channel:rooms',
    );
  });

  it('falls back to channel name for static channels (scope null)', () => {
    expect(resolveScopeKey({ id: 'c1', channel: { name: 'lobby', family: null } })).toBe(
      'channel:lobby',
    );
  });
});

describe('RateLimitRuntime — token bucket math', () => {
  it('passes through when no rule applies for the scope', () => {
    const c = clock();
    const rt = new RateLimitRuntime(plan([['top', null]]), c.read.bind(c));
    expect(rt.check({ id: 'c1' }, 'ev')).toBeNull();
  });

  it('allows up to max in a fresh window then rejects with retryAfterMs', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, max: 3, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'e')).toBeNull();
    expect(rt.check({ id: 'c1' }, 'e')).toBeNull();
    expect(rt.check({ id: 'c1' }, 'e')).toBeNull();

    const verdict = rt.check({ id: 'c1' }, 'e');
    expect(verdict).not.toBeNull();
    expect(verdict!.retryAfterMs).toBeGreaterThanOrEqual(1_000);
  });

  it('keeps the minimum retryAfterMs at one second', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 1_000, max: 1, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    rt.check({ id: 'c1' }, 'e');

    c.advance(999);
    expect(rt.check({ id: 'c1' }, 'e')!.retryAfterMs).toBe(1_000);
  });

  it('refills tokens over time and accepts again after retryAfterMs', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, max: 3, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    rt.check({ id: 'c1' }, 'e');
    rt.check({ id: 'c1' }, 'e');
    rt.check({ id: 'c1' }, 'e');

    expect(rt.check({ id: 'c1' }, 'e')).not.toBeNull();

    c.advance(20_000);
    expect(rt.check({ id: 'c1' }, 'e')).toBeNull();
  });

  it('isolates buckets per `per` key', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'a' }, 'e')).toBeNull();
    expect(rt.check({ id: 'a' }, 'e')).not.toBeNull();
    expect(rt.check({ id: 'b' }, 'e')).toBeNull();
  });

  it('shares a bucket across events under one scope rule', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, max: 2, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'send')).toBeNull();
    expect(rt.check({ id: 'c1' }, 'typing')).toBeNull();
    expect(rt.check({ id: 'c1' }, 'send')).not.toBeNull();
  });

  it('per-event override uses its own bucket separate from scope rule', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      withOverrides(
        [['top', { id: 1, windowMs: 60_000, max: 5, per: (ctx: any) => ctx.id }]],
        [['top', [['expensive', { id: 2, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }]]]],
      ),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'expensive')).toBeNull();
    expect(rt.check({ id: 'c1' }, 'expensive')).not.toBeNull();
    expect(rt.check({ id: 'c1' }, 'cheap')).toBeNull();
  });

  it('retryAfterMs reflects the configured refill rate', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 10_000, max: 10, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    for (let i = 0; i < 10; i += 1) rt.check({ id: 'c1' }, 'e');
    const verdict = rt.check({ id: 'c1' }, 'e');
    expect(verdict).not.toBeNull();
    // Tokens went to 0; one token comes back in 1000ms.
    expect(verdict!.retryAfterMs).toBe(1000);
  });

  it('refill clamps at max even after a very long idle', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, max: 3, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    rt.check({ id: 'c1' }, 'e');
    rt.check({ id: 'c1' }, 'e');
    rt.check({ id: 'c1' }, 'e');

    expect(rt.check({ id: 'c1' }, 'e')).not.toBeNull();

    // Sleep way longer than one window. Bucket should be capped at max, not larger.
    c.advance(60 * 60 * 1000);
    for (let i = 0; i < 3; i += 1) {
      expect(rt.check({ id: 'c1' }, 'e')).toBeNull();
    }

    expect(rt.check({ id: 'c1' }, 'e')).not.toBeNull();
  });

  it("custom `per: ctx => ctx.user.id` shares the bucket across that user's sockets", () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, max: 2, per: (ctx: any) => ctx.user.id }]]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1', user: { id: 'u-42' } }, 'e')).toBeNull();
    expect(rt.check({ id: 'c2', user: { id: 'u-42' } }, 'e')).toBeNull();
    expect(rt.check({ id: 'c3', user: { id: 'u-42' } }, 'e')).not.toBeNull();

    expect(rt.check({ id: 'c4', user: { id: 'u-99' } }, 'e')).toBeNull();
  });

  it('routes the same connection to different buckets depending on scope', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([
        ['top', { id: 1, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }],
        ['channel:rooms', { id: 2, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }],
      ]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'e')).toBeNull();
    expect(rt.check({ id: 'c1' }, 'e')).not.toBeNull();
    expect(rt.check({ id: 'c1', channel: { name: 'room-a', family: 'rooms' } }, 'e')).toBeNull();

    expect(
      rt.check({ id: 'c1', channel: { name: 'room-a', family: 'rooms' } }, 'e'),
    ).not.toBeNull();
  });

  it('per-event override with null rule disables for that event', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      withOverrides(
        [['top', { id: 1, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }]],
        [['top', [['exempt', null]]]],
      ),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'exempt')).toBeNull();
    expect(rt.check({ id: 'c1' }, 'exempt')).toBeNull();
    expect(rt.check({ id: 'c1' }, 'exempt')).toBeNull();

    expect(rt.check({ id: 'c1' }, 'other')).toBeNull();
    expect(rt.check({ id: 'c1' }, 'other')).not.toBeNull();
  });
});
