/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { RateLimited } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { rateLimit as rateLimitCapability } from './capability.ts';
import { rateLimit } from './rate-limit.ts';
import { RateLimitRuntime } from './runtime.ts';

function buildEngine(definition: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'rate-limit',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  runAdapter(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  return captured;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('rateLimit primitive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an intercept primitive', () => {
    const prim = rateLimit({
      scopeRules: new Map([
        ['top', { id: 1, windowMs: 60_000, max: 1, per: (ctx: any) => ctx.id }],
      ]),
      eventOverrides: new Map(),
    }) as any;
    expect(prim.__livething).toBe('intercept');
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

  it('drops the budget of each connection once it closes', async () => {
    // The runtime is built inside assemble(); the spy only captures the instance.
    const check = vi.spyOn(RateLimitRuntime.prototype, 'check');
    const base = server({ capabilities: [rateLimitCapability({ windowMs: 60_000, max: 10 })] });
    const say = base.on('say', { input: v.object({}), run() {} });
    const engine = buildEngine(base.assemble({ handlers: [say] }));
    await engine.initialize();

    for (let i = 0; i < 20; i += 1) {
      const handle = engine.accept(Symbol(`u${i}`), {
        send() {},
        close() {},
        bufferedAmount: () => 0,
        userId: `u${i}`,
      });
      await settle();

      await handle.handleMessage(JSON.stringify(['say', {}, null]));
      await settle();

      await handle.handleClose(1000, 'bye');
      await settle();
    }

    const runtime = check.mock.contexts[0] as RateLimitRuntime;
    expect(check).toHaveBeenCalledTimes(20);
    expect(runtime.size).toBe(0);
  });
});
