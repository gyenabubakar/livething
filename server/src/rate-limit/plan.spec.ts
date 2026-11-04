/* oxlint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { resolvePlan } from './plan.ts';
import type { RateLimitConfig } from './rate-limit.ts';

const emptyOverrides = new Map<string, Map<string, RateLimitConfig>>();

describe('resolvePlan — cascade', () => {
  it('returns null when nothing is configured anywhere', () => {
    const plan = resolvePlan({
      contractRateLimit: undefined,
      channels: [],
      overrides: emptyOverrides,
    });
    expect(plan).toBeNull();
  });

  it('attaches a rule to top when contract has rateLimit', () => {
    const plan = resolvePlan({
      contractRateLimit: { maxMessages: 60 },
      channels: [],
      overrides: emptyOverrides,
    });
    expect(plan).not.toBeNull();
    expect(plan!.scopeRules.get('top')?.maxMessages).toBe(60);
  });

  it('inherits parent rule for scopes with no rateLimit', () => {
    const plan = resolvePlan({
      contractRateLimit: { maxMessages: 60 },
      channels: [{ key: 'ai' }],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('channel:ai')?.id).toBe(plan!.scopeRules.get('top')?.id);
  });

  it('partial override at a child scope keeps parent fields', () => {
    const plan = resolvePlan({
      contractRateLimit: { maxMessages: 60, windowMs: 30_000 },
      channels: [{ key: 'ai', rateLimit: { maxMessages: 100 } }],
      overrides: emptyOverrides,
    });
    const chRule = plan!.scopeRules.get('channel:ai');
    expect(chRule?.maxMessages).toBe(100);
    expect(chRule?.windowMs).toBe(30_000);
    expect(chRule?.id).not.toBe(plan!.scopeRules.get('top')?.id);
  });

  it('disable at a child scope nulls that scope', () => {
    const plan = resolvePlan({
      contractRateLimit: { maxMessages: 60 },
      channels: [{ key: 'public', rateLimit: false }],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('channel:public')).toBeNull();
  });

  it('child can re-enable inside a disabled parent', () => {
    const plan = resolvePlan({
      contractRateLimit: false,
      channels: [{ key: 'strict', rateLimit: { maxMessages: 5 } }],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('top')).toBeNull();
    expect(plan!.scopeRules.get('channel:strict')?.maxMessages).toBe(5);
  });

  it('per-event override merges against the resolved scope rule', () => {
    const plan = resolvePlan({
      contractRateLimit: { maxMessages: 60, windowMs: 30_000 },
      channels: [],
      overrides: new Map([
        ['top', new Map([['expensive', { maxMessages: 5 } as RateLimitConfig]])],
      ]),
    });
    const override = plan!.eventOverrides.get('top')?.get('expensive');
    expect(override?.maxMessages).toBe(5);
    expect(override?.windowMs).toBe(30_000);
    expect(override?.id).not.toBe(plan!.scopeRules.get('top')?.id);
  });

  it('per-event override can disable for one event', () => {
    const plan = resolvePlan({
      contractRateLimit: { maxMessages: 60 },
      channels: [],
      overrides: new Map([['top', new Map([['public-ping', false as RateLimitConfig]])]]),
    });
    expect(plan!.eventOverrides.get('top')?.get('public-ping')).toBeNull();
  });

  it('keys a channel scope as channel:<key>', () => {
    const plan = resolvePlan({
      contractRateLimit: { maxMessages: 60 },
      channels: [{ key: 'lobby', rateLimit: { maxMessages: 10 } }],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('channel:lobby')?.maxMessages).toBe(10);
  });

  it('per-event override under a channel scope merges against the channel rule', () => {
    const plan = resolvePlan({
      contractRateLimit: { maxMessages: 60 },
      channels: [{ key: 'rooms', rateLimit: { maxMessages: 200 } }],
      overrides: new Map([
        ['channel:rooms', new Map([['expensive', { maxMessages: 5 } as RateLimitConfig]])],
      ]),
    });
    const override = plan!.eventOverrides.get('channel:rooms')?.get('expensive');
    expect(override?.maxMessages).toBe(5);
    expect(override?.windowMs).toBe(60_000);
    expect(override?.id).not.toBe(plan!.scopeRules.get('channel:rooms')?.id);
  });

  it('`per` callback inherits down the cascade', () => {
    function perByUserId(ctx: any) {
      return ctx.user.id;
    }

    const plan = resolvePlan({
      contractRateLimit: { maxMessages: 60, per: perByUserId },
      channels: [{ key: 'ai', rateLimit: { maxMessages: 100 } }],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('channel:ai')?.per).toBe(perByUserId);
  });

  it('emits a plan when only per-event overrides exist (no scope rules)', () => {
    const plan = resolvePlan({
      contractRateLimit: undefined,
      channels: [],
      overrides: new Map([['top', new Map([['critical', { maxMessages: 1 } as RateLimitConfig]])]]),
    });
    expect(plan).not.toBeNull();
    expect(plan!.eventOverrides.get('top')?.get('critical')?.maxMessages).toBe(1);
  });
});

describe('resolvePlan — maxBytes', () => {
  it('has no byte limit unless one is set, and a child keeps the parent maxBytes', () => {
    const plan = resolvePlan({
      contractRateLimit: { maxBytes: 4096 },
      channels: [
        { key: 'ai', rateLimit: { maxMessages: 10 } },
        { key: 'files', rateLimit: { maxBytes: 1_000_000 } },
      ],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('top')?.maxBytes).toBe(4096);
    expect(plan!.scopeRules.get('channel:ai')?.maxBytes).toBe(4096);
    expect(plan!.scopeRules.get('channel:files')?.maxBytes).toBe(1_000_000);

    const noBytes = resolvePlan({
      contractRateLimit: { maxMessages: 60 },
      channels: [],
      overrides: emptyOverrides,
    });
    expect(noBytes!.scopeRules.get('top')?.maxBytes).toBeUndefined();
  });

  it('throws when maxBytes is not a positive integer', () => {
    for (const maxBytes of [0, -1, 1.5]) {
      expect(() =>
        resolvePlan({ contractRateLimit: { maxBytes }, channels: [], overrides: emptyOverrides }),
      ).toThrow(/maxBytes/);
    }
  });
});
