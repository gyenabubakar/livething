import { AsyncLocalStorage } from 'node:async_hooks';
import { CloseCodes, RateLimited } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import { rateLimit } from './capability.ts';

function buildEngine(definition: ServerDefinition): Engine {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'rate-limit-on-error',
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

describe('rate limit and onError', () => {
  it('passes each rejected frame to onError, so the app can see who goes over the limit', async () => {
    const seen: { connectionId: string; event: string | undefined; retryAfterMs: number }[] = [];
    const base = server({
      capabilities: [rateLimit({ windowMs: 60_000, max: 1 })],
      onError(ctx, error, event) {
        if (RateLimited.matches(error)) {
          seen.push({
            connectionId: ctx.connection.id,
            event,
            retryAfterMs: error.detail.retryAfterMs,
          });
        }
      },
    });
    let runs = 0;
    const handleSay = base.on('say', {
      input: v.object({}),
      run() {
        runs += 1;
      },
    });

    const engine = buildEngine(base.assemble({ handlers: [handleSay] }));
    await engine.initialize();

    const handle = engine.accept(Symbol('u1'), {
      send() {},
      close() {},
      bufferedAmount: () => 0,
      userId: 'u1',
    });
    await settle();

    for (let i = 0; i < 3; i += 1) {
      await handle.handleMessage(JSON.stringify(['say', {}, null]));
      await settle();
    }

    expect(runs).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.event).toBe('say');
    expect(seen[0]?.retryAfterMs).toBeGreaterThan(0);
  });

  it('lets the app close a connection that keeps going over the limit', async () => {
    const strikes = new Map<string, number>();
    const base = server({
      capabilities: [rateLimit({ windowMs: 60_000, max: 1 })],
      onError(ctx, error) {
        if (!RateLimited.matches(error)) return;

        const count = (strikes.get(ctx.connection.id) ?? 0) + 1;
        strikes.set(ctx.connection.id, count);
        if (count >= 3) ctx.close(CloseCodes.RATE_LIMITED, 'Too many messages');
      },
    });

    const handleSay = base.on('say', { input: v.object({}), run() {} });
    const engine = buildEngine(base.assemble({ handlers: [handleSay] }));
    await engine.initialize();

    const closes: (number | undefined)[] = [];
    const handle = engine.accept(Symbol('u1'), {
      send() {},
      close(code?: number) {
        closes.push(code);
      },
      bufferedAmount: () => 0,
      userId: 'u1',
    });
    await settle();

    for (let i = 0; i < 4; i += 1) {
      await handle.handleMessage(JSON.stringify(['say', {}, null]));
      await settle();
    }

    expect(closes).toEqual([CloseCodes.RATE_LIMITED]);
  });
});
