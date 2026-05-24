import { error } from '~/errors/errors.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import { definePlugin, PLUGIN_API_MAP } from './define.ts';

const Forbidden = error('forbidden', v.object({ reason: v.string() }));

describe('definePlugin', () => {
  it('creates a plugin factory with id, key, outgoing, errors, dependencies, and requires', () => {
    const key = Symbol('analytics');
    const dependency = { __key: Symbol('dep') };
    const setup = vi.fn(() => () => ({ track() {} }));
    const errorsPrimitive = { __wskit: 'errors', defs: [Forbidden] } as unknown as ErrorsPrimitive;

    const analytics = definePlugin({
      id: 'acme:analytics',
      key,
      dependencies: [dependency],
      requires: { storage: true, timers: true },
      outgoing: { flushed: v.object({ ok: v.boolean() }) },
      errors: errorsPrimitive,
      setup,
    });

    const instance = analytics({ sampleRate: 1 });

    expect(analytics.id).toBe('acme:analytics');
    expect(analytics.__key).toBe(key);
    expect(instance.__wskit).toBe('plugin');
    expect(instance.id).toBe('acme:analytics');
    expect(instance.args).toEqual({ sampleRate: 1 });
    expect(instance.outgoing).toEqual({ flushed: expect.anything() });
    expect(instance.errors).toBe(errorsPrimitive);
    expect(instance.__requires).toEqual({ storage: true, timers: true });
    expect(instance.setupPlugin).toBe(setup);
  });

  it('rejects invalid plugin ids', () => {
    expect(() =>
      definePlugin({
        id: 'AcmeAnalytics',
        key: Symbol('bad'),
        setup: () => () => ({}),
      }),
    ).toThrow(/invalid/);
  });

  it('reads plugin api from the hidden plugin api map', () => {
    const key = Symbol('presence');
    const presence = definePlugin({
      id: 'acme:presence',
      key,
      setup: () => () => ({ online: true }),
    });

    const api = presence.use({
      [PLUGIN_API_MAP]: {
        [key]: { online: true },
      },
    });

    expect(api).toEqual({ online: true });
  });

  it('throws when use(ctx) is called outside an active wskit context', () => {
    const key = Symbol('presence');
    const presence = definePlugin({
      id: 'acme:presence',
      key,
      setup: () => () => ({ online: true }),
    });

    expect(() => presence.use({})).toThrow(/outside an active wskit context/);
  });

  it('preserves typed api access from use(ctx)', () => {
    const key = Symbol('metrics');
    const metrics = definePlugin({
      id: 'acme:metrics',
      key,
      setup: () => () => ({
        increment(name: string) {
          return name.length;
        },
      }),
    });

    const value = metrics.use({
      [PLUGIN_API_MAP]: {
        [key]: {
          increment(name: string) {
            return name.length;
          },
        },
      },
    });

    const result: number = value.increment('messages');
    expect(result).toBe(8);
  });
});
