/* oxlint-disable @typescript-eslint/no-explicit-any */
import { scope } from '~/channel/channel.ts';
import { channel } from '~/channel/definition.ts';
import { incoming } from '~/incoming/definition.ts';
import { namespace } from '~/namespace/definition.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { resolvePlan } from './plan.ts';
import type { RateLimitConfig } from './rate-limit.ts';

const emptyOverrides = new Map<string, Map<string, RateLimitConfig>>();

describe('resolvePlan — cascade', () => {
  it('returns null when nothing is configured anywhere', () => {
    const plan = resolvePlan({
      contractRateLimit: undefined,
      definitions: [],
      overrides: emptyOverrides,
    });
    expect(plan).toBeNull();
  });

  it('attaches a rule to top when contract has rateLimit', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60 },
      definitions: [],
      overrides: emptyOverrides,
    });
    expect(plan).not.toBeNull();
    expect(plan!.scopeRules.get('top')?.max).toBe(60);
  });

  it('inherits parent rule for scopes with no rateLimit', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60 },
      definitions: [namespace('ai', { definitions: [] })],
      overrides: emptyOverrides,
    });
    // Inheritance shares the parent rule (same id, same bucket).
    expect(plan!.scopeRules.get('ns:ai')?.id).toBe(plan!.scopeRules.get('top')?.id);
  });

  it('partial override at a child scope keeps parent fields', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60, windowMs: 30_000 },
      definitions: [namespace('ai', { rateLimit: { enabled: true, max: 100 }, definitions: [] })],
      overrides: emptyOverrides,
    });
    const nsRule = plan!.scopeRules.get('ns:ai');
    expect(nsRule?.max).toBe(100);
    expect(nsRule?.windowMs).toBe(30_000);
    // New rule id — different bucket than top.
    expect(nsRule?.id).not.toBe(plan!.scopeRules.get('top')?.id);
  });

  it('disable at a child scope nulls that scope', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60 },
      definitions: [
        namespace('public', {
          rateLimit: { enabled: false },
          definitions: [incoming('msg', v.object({}))],
        }),
      ],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('ns:public')).toBeNull();
  });

  it('child can re-enable inside a disabled parent', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: false },
      definitions: [
        namespace('strict', {
          rateLimit: { enabled: true, max: 5 },
          definitions: [],
        }),
      ],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('top')).toBeNull();
    expect(plan!.scopeRules.get('ns:strict')?.max).toBe(5);
  });

  it('uses family key (not concrete name) for dynamic channels', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60 },
      definitions: [
        channel(scope('rooms', 'room-{id}'), {
          rateLimit: { enabled: true, max: 200 },
          definitions: [],
        }),
      ],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('channel:rooms')?.max).toBe(200);
  });

  it('per-event override merges against the resolved scope rule', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60, windowMs: 30_000 },
      definitions: [],
      overrides: new Map([
        ['top', new Map([['expensive', { enabled: true, max: 5 } as RateLimitConfig]])],
      ]),
    });
    const override = plan!.eventOverrides.get('top')?.get('expensive');
    expect(override?.max).toBe(5);
    expect(override?.windowMs).toBe(30_000);
    // Separate id → separate bucket from scope rule.
    expect(override?.id).not.toBe(plan!.scopeRules.get('top')?.id);
  });

  it('per-event override can disable for one event', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60 },
      definitions: [],
      overrides: new Map([
        ['top', new Map([['public-ping', { enabled: false } as RateLimitConfig]])],
      ]),
    });
    expect(plan!.eventOverrides.get('top')?.get('public-ping')).toBeNull();
  });

  it('uses the string as the scope key for static channels', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60 },
      definitions: [
        channel('lobby', {
          rateLimit: { enabled: true, max: 10 },
          definitions: [],
        }),
      ],
      overrides: emptyOverrides,
    });
    expect(plan!.scopeRules.get('channel:lobby')?.max).toBe(10);
  });

  it('per-event override under a channel scope merges against the channel rule', () => {
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60 },
      definitions: [
        channel('rooms', {
          rateLimit: { enabled: true, max: 200 },
          definitions: [],
        }),
      ],
      overrides: new Map([
        ['channel:rooms', new Map([['expensive', { enabled: true, max: 5 } as RateLimitConfig]])],
      ]),
    });
    const override = plan!.eventOverrides.get('channel:rooms')?.get('expensive');
    expect(override?.max).toBe(5);
    // windowMs falls back to the channel's resolved rule (= top's via cascade).
    expect(override?.windowMs).toBe(60_000);
    expect(override?.id).not.toBe(plan!.scopeRules.get('channel:rooms')?.id);
  });

  it('`per` callback inherits down the cascade', () => {
    function perByIdentity(ctx: any) {
      return ctx.identity;
    }
    const plan = resolvePlan({
      contractRateLimit: { enabled: true, max: 60, per: perByIdentity },
      definitions: [namespace('ai', { rateLimit: { enabled: true, max: 100 }, definitions: [] })],
      overrides: emptyOverrides,
    });
    // namespace inherited `per` from contract.
    expect(plan!.scopeRules.get('ns:ai')?.per).toBe(perByIdentity);
  });

  it('emits a plan when only per-event overrides exist (no scope rules)', () => {
    const plan = resolvePlan({
      contractRateLimit: undefined,
      definitions: [],
      overrides: new Map([
        ['top', new Map([['critical', { enabled: true, max: 1 } as RateLimitConfig]])],
      ]),
    });
    expect(plan).not.toBeNull();
    expect(plan!.eventOverrides.get('top')?.get('critical')?.max).toBe(1);
  });
});
