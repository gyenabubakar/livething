import { error } from '~/errors/errors.ts';
import { outgoing } from '~/outgoing/outgoing.ts';
import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { defineModule, MODULE_API_MAP } from './define.ts';

const flushed = outgoing<'flushed', { ok: true }>('flushed');
const Forbidden = error('forbidden', v.object({ reason: v.string() }));

describe('defineModule', () => {
  it('creates a module factory with id, key, outgoing, errors, dependencies, and requires', () => {
    const key = Symbol('analytics');
    const dependency = { __key: Symbol('dep') };
    const setup = vi.fn(() => () => ({ track() {} }));
    const errorsPrimitive = { __wskit: 'errors', defs: [Forbidden] } as any;

    const analytics = defineModule({
      id: 'acme:analytics',
      key,
      dependencies: [dependency],
      requires: { storage: true, timers: true },
      outgoing: [flushed],
      errors: errorsPrimitive,
      setup,
    });

    const instance = analytics({ sampleRate: 1 });

    expect(analytics.id).toBe('acme:analytics');
    expect(analytics.__key).toBe(key);
    expect(instance.__wskit).toBe('module');
    expect(instance.id).toBe('acme:analytics');
    expect(instance.args).toEqual({ sampleRate: 1 });
    expect(instance.outgoing).toEqual([flushed]);
    expect(instance.errors).toBe(errorsPrimitive);
    expect(instance.__dependencies).toEqual([dependency]);
    expect(instance.__requires).toEqual({ storage: true, timers: true });
    expect(instance.setupModule).toBe(setup);
  });

  it('rejects invalid module ids', () => {
    expect(() =>
      defineModule({
        id: 'AcmeAnalytics',
        key: Symbol('bad'),
        setup: () => () => ({}),
      }),
    ).toThrow(/invalid/);
  });

  it('reads module api from the hidden module api map', () => {
    const key = Symbol('presence');
    const presence = defineModule({
      id: 'acme:presence',
      key,
      setup: () => () => ({ online: true }),
    });

    const api = presence.use({
      [MODULE_API_MAP]: {
        [key]: { online: true },
      },
    });

    expect(api).toEqual({ online: true });
  });

  it('throws when use(ctx) is called outside an active wskit context', () => {
    const key = Symbol('presence');
    const presence = defineModule({
      id: 'acme:presence',
      key,
      setup: () => () => ({ online: true }),
    });

    expect(() => presence.use({})).toThrow(/outside an active wskit context/);
  });

  it('preserves typed api access from use(ctx)', () => {
    const key = Symbol('metrics');
    const metrics = defineModule({
      id: 'acme:metrics',
      key,
      setup: () => () => ({
        increment(name: string) {
          return name.length;
        },
      }),
    });

    const value = metrics.use({
      [MODULE_API_MAP]: {
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
