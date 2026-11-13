/* oxlint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { connectionBudgetKey, RateLimitRuntime, resolveScopeKey } from './runtime.ts';
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

describe('forgetConnection', () => {
  it('keeps a shared bucket whose key equals the closing connection id', () => {
    const rule = { id: 1, windowMs: 60_000, maxMessages: 1, per: (ctx: any) => ctx.user.id };
    const runtime = new RateLimitRuntime(plan([['top', rule]]), () => 1_000);
    const ctx = { user: { id: 'conn_1' }, connection: { id: 'conn_2' } };
    expect(runtime.check(ctx, 'send', 0)).toBeNull();

    runtime.forgetConnection('conn_1');

    expect(runtime.check(ctx, 'send', 0)).not.toBeNull();
  });
});

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
    expect(rt.check({ id: 'c1' }, 'ev', 0)).toBeNull();
  });

  it('allows up to maxMessages in a fresh window then rejects with retryAfterMs', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, maxMessages: 3, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'e', 0)).toBeNull();
    expect(rt.check({ id: 'c1' }, 'e', 0)).toBeNull();
    expect(rt.check({ id: 'c1' }, 'e', 0)).toBeNull();

    const verdict = rt.check({ id: 'c1' }, 'e', 0);
    expect(verdict).not.toBeNull();
    expect(verdict!.retryAfterMs).toBeGreaterThanOrEqual(1_000);
  });

  it('keeps the minimum retryAfterMs at one second', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 1_000, maxMessages: 1, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    rt.check({ id: 'c1' }, 'e', 0);

    c.advance(999);
    expect(rt.check({ id: 'c1' }, 'e', 0)!.retryAfterMs).toBe(1_000);
  });

  it('refills tokens over time and accepts again after retryAfterMs', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, maxMessages: 3, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    rt.check({ id: 'c1' }, 'e', 0);
    rt.check({ id: 'c1' }, 'e', 0);
    rt.check({ id: 'c1' }, 'e', 0);

    expect(rt.check({ id: 'c1' }, 'e', 0)).not.toBeNull();

    c.advance(20_000);
    expect(rt.check({ id: 'c1' }, 'e', 0)).toBeNull();
  });

  it('isolates buckets per `per` key', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, maxMessages: 1, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'a' }, 'e', 0)).toBeNull();
    expect(rt.check({ id: 'a' }, 'e', 0)).not.toBeNull();
    expect(rt.check({ id: 'b' }, 'e', 0)).toBeNull();
  });

  it('gives each connection its own budget when `per` returns an empty key', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, maxMessages: 1, per: (ctx: any) => ctx.user.id }]]),
      c.read.bind(c),
    );
    const anonymousA = { user: { id: '' }, connection: { id: 'conn-a' } };
    const anonymousB = { user: { id: '' }, connection: { id: 'conn-b' } };

    expect(rt.check(anonymousA, 'e', 0)).toBeNull();
    expect(rt.check(anonymousA, 'e', 0)).not.toBeNull();
    expect(rt.check(anonymousB, 'e', 0)).toBeNull();
  });

  it('shares a bucket across events under one scope rule', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, maxMessages: 2, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'send', 0)).toBeNull();
    expect(rt.check({ id: 'c1' }, 'typing', 0)).toBeNull();
    expect(rt.check({ id: 'c1' }, 'send', 0)).not.toBeNull();
  });

  it('per-event override uses its own bucket separate from scope rule', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      withOverrides(
        [['top', { id: 1, windowMs: 60_000, maxMessages: 5, per: (ctx: any) => ctx.id }]],
        [
          [
            'top',
            [['expensive', { id: 2, windowMs: 60_000, maxMessages: 1, per: (ctx: any) => ctx.id }]],
          ],
        ],
      ),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'expensive', 0)).toBeNull();
    expect(rt.check({ id: 'c1' }, 'expensive', 0)).not.toBeNull();
    expect(rt.check({ id: 'c1' }, 'cheap', 0)).toBeNull();
  });

  it('retryAfterMs reflects the configured refill rate', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 10_000, maxMessages: 10, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    for (let i = 0; i < 10; i += 1) rt.check({ id: 'c1' }, 'e', 0);
    const verdict = rt.check({ id: 'c1' }, 'e', 0);
    expect(verdict).not.toBeNull();
    // Tokens went to 0; one token comes back in 1000ms.
    expect(verdict!.retryAfterMs).toBe(1000);
  });

  it('refill clamps at maxMessages even after a very long idle', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, maxMessages: 3, per: (ctx: any) => ctx.id }]]),
      c.read.bind(c),
    );
    rt.check({ id: 'c1' }, 'e', 0);
    rt.check({ id: 'c1' }, 'e', 0);
    rt.check({ id: 'c1' }, 'e', 0);

    expect(rt.check({ id: 'c1' }, 'e', 0)).not.toBeNull();

    // Sleep way longer than one window. Bucket should be capped at maxMessages, not larger.
    c.advance(60 * 60 * 1000);
    for (let i = 0; i < 3; i += 1) {
      expect(rt.check({ id: 'c1' }, 'e', 0)).toBeNull();
    }

    expect(rt.check({ id: 'c1' }, 'e', 0)).not.toBeNull();
  });

  it("custom `per: ctx => ctx.user.id` shares the bucket across that user's sockets", () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, maxMessages: 2, per: (ctx: any) => ctx.user.id }]]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1', user: { id: 'u-42' } }, 'e', 0)).toBeNull();
    expect(rt.check({ id: 'c2', user: { id: 'u-42' } }, 'e', 0)).toBeNull();
    expect(rt.check({ id: 'c3', user: { id: 'u-42' } }, 'e', 0)).not.toBeNull();

    expect(rt.check({ id: 'c4', user: { id: 'u-99' } }, 'e', 0)).toBeNull();
  });

  it('routes the same connection to different buckets depending on scope', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([
        ['top', { id: 1, windowMs: 60_000, maxMessages: 1, per: (ctx: any) => ctx.id }],
        ['channel:rooms', { id: 2, windowMs: 60_000, maxMessages: 1, per: (ctx: any) => ctx.id }],
      ]),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'e', 0)).toBeNull();
    expect(rt.check({ id: 'c1' }, 'e', 0)).not.toBeNull();
    expect(rt.check({ id: 'c1', channel: { name: 'room-a', family: 'rooms' } }, 'e', 0)).toBeNull();

    expect(
      rt.check({ id: 'c1', channel: { name: 'room-a', family: 'rooms' } }, 'e', 0),
    ).not.toBeNull();
  });

  it('per-event override with null rule disables for that event', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      withOverrides(
        [['top', { id: 1, windowMs: 60_000, maxMessages: 1, per: (ctx: any) => ctx.id }]],
        [['top', [['exempt', null]]]],
      ),
      c.read.bind(c),
    );
    expect(rt.check({ id: 'c1' }, 'exempt', 0)).toBeNull();
    expect(rt.check({ id: 'c1' }, 'exempt', 0)).toBeNull();
    expect(rt.check({ id: 'c1' }, 'exempt', 0)).toBeNull();

    expect(rt.check({ id: 'c1' }, 'other', 0)).toBeNull();
    expect(rt.check({ id: 'c1' }, 'other', 0)).not.toBeNull();
  });
});

describe('RateLimitRuntime — memory', () => {
  it('drops the buckets of users who went quiet once their budgets have refilled', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, maxMessages: 2, per: (ctx: any) => ctx.user.id }]]),
      c.read.bind(c),
    );
    for (let i = 0; i < 100; i += 1) {
      rt.check({ id: `c${i}`, user: { id: `u-${i}` } }, 'e', 0);
    }

    expect(rt.size).toBe(100);

    c.advance(2 * 60 * 60 * 1000);
    rt.check({ id: 'c-new', user: { id: 'u-new' } }, 'e', 0);

    expect(rt.size).toBe(1);
  });

  it('keeps a bucket that has not refilled, so a quiet user cannot reset the budget', () => {
    const c = clock();
    const rt = new RateLimitRuntime(
      plan([
        [
          'top',
          { id: 1, windowMs: 60 * 60 * 1000, maxMessages: 1, per: (ctx: any) => ctx.user.id },
        ],
      ]),
      c.read.bind(c),
    );
    rt.check({ id: 'c1', user: { id: 'u-1' } }, 'e', 0);

    c.advance(30 * 60 * 1000);
    rt.check({ id: 'c2', user: { id: 'u-2' } }, 'e', 0);

    expect(rt.check({ id: 'c3', user: { id: 'u-1' } }, 'e', 0)).not.toBeNull();
  });
});

describe('RateLimitRuntime maxBytes', () => {
  const byteRule = {
    id: 1,
    windowMs: 60_000,
    maxMessages: 100,
    maxBytes: 1_000,
    per: connectionBudgetKey,
  };

  const ctx = { connection: { id: 'c1' } };

  it('refuses a frame once the byte budget is used, while messages are left', () => {
    const c = clock();
    const rt = new RateLimitRuntime(plan([['top', byteRule]]), c.read.bind(c));

    expect(rt.check(ctx, 'upload', 600)).toBeNull();
    const verdict = rt.check(ctx, 'upload', 600);

    expect(verdict).not.toBeNull();
    // 200 bytes are missing, at 1000 bytes per 60 s.
    expect(verdict!.retryAfterMs).toBe(12_000);
  });

  it('lets a frame bigger than maxBytes pass only when the bucket is full, and empties it', () => {
    const c = clock();
    const rt = new RateLimitRuntime(plan([['top', byteRule]]), c.read.bind(c));

    expect(rt.check(ctx, 'upload', 5_000)).toBeNull();
    expect(rt.check(ctx, 'upload', 1)).not.toBeNull();

    c.advance(30_000);
    expect(rt.check(ctx, 'upload', 5_000)).not.toBeNull();

    c.advance(30_000);
    expect(rt.check(ctx, 'upload', 5_000)).toBeNull();
  });

  it('counts only messages when the rule has no maxBytes', () => {
    const rt = new RateLimitRuntime(
      plan([['top', { id: 1, windowMs: 60_000, maxMessages: 2, per: connectionBudgetKey }]]),
    );

    expect(rt.check(ctx, 'upload', 50_000_000)).toBeNull();
    expect(rt.check(ctx, 'upload', 50_000_000)).toBeNull();
    expect(rt.check(ctx, 'upload', 1)).not.toBeNull();
  });

  it('refuses on the message count even when bytes are left', () => {
    const rt = new RateLimitRuntime(plan([['top', { ...byteRule, maxMessages: 1 }]]));

    expect(rt.check(ctx, 'upload', 1)).toBeNull();
    expect(rt.check(ctx, 'upload', 1)).not.toBeNull();
  });
});
