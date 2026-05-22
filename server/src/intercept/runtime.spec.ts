import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { intercept } from './intercept.ts';
import { runPostIntercepts, runPreIntercepts, runWithScopedContext } from './runtime.ts';

function createConnection(): RuntimeConnection {
  return {
    id: 'c1',
    identity: 'c1',
    wsKey: 'ws1',
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: 'c1',
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function getCtx(): Record<PropertyKey, unknown> {
  return {};
}

describe('intercept/runtime', () => {
  it('runs pre intercepts in order and lets them rewrite the payload', async () => {
    const connection = createConnection();

    const first = intercept(async (_ctx, message) => ({
      ...(message.payload as Record<string, unknown>),
      a: 1,
    }));
    const second = intercept(async (_ctx, message) => ({
      ...(message.payload as Record<string, unknown>),
      b: 2,
    }));

    const next = await runPreIntercepts(
      {},
      connection,
      [first, second],
      { event: 'hello', payload: {} },
      getCtx,
    );

    expect(next).toEqual({ event: 'hello', payload: { a: 1, b: 2 } });
  });

  it('builds the connection context once and shares it across intercepts', async () => {
    const connection = createConnection();

    let builds = 0;
    function countingGetCtx(): Record<PropertyKey, unknown> {
      builds += 1;
      return { build: builds };
    }

    const seen: unknown[] = [];
    const a = intercept((ctx) => {
      seen.push(ctx);
      return undefined;
    });
    const b = intercept((ctx) => {
      seen.push(ctx);
      return undefined;
    });

    await runPreIntercepts({}, connection, [a, b], { event: 'e', payload: {} }, countingGetCtx);

    expect(builds).toBe(1);
    expect(seen[0]).toBe(seen[1]);
  });

  it('does not build a context when there are no intercepts', async () => {
    const connection = createConnection();
    let builds = 0;

    const next = await runPreIntercepts(
      {},
      connection,
      [],
      { event: 'e', payload: { keep: true } },
      () => {
        builds += 1;
        return {};
      },
    );

    expect(builds).toBe(0);
    expect(next).toEqual({ event: 'e', payload: { keep: true } });
  });

  it('locks the event name: a returned {event, payload} object becomes the new payload as a whole', async () => {
    const connection = createConnection();

    // User code that "tries" to rewrite the event by returning a full
    // {event, payload} shape. The engine must NOT route based on this —
    // the wrapper object becomes the new payload verbatim.
    const aliasing = intercept(async (_ctx, _message) => ({
      event: 'real',
      payload: { count: 7 },
    }));

    const next = await runPreIntercepts(
      {},
      connection,
      [aliasing],
      { event: 'alias', payload: { ignored: true } },
      getCtx,
    );

    // Event stays locked at the wire-level 'alias'. The whole returned
    // object becomes message.payload.
    expect(next.event).toBe('alias');
    expect(next.payload).toEqual({ event: 'real', payload: { count: 7 } });
  });

  it('void return from a pre-intercept passes the payload through unchanged', async () => {
    const connection = createConnection();

    const passthrough = intercept(() => undefined);

    const next = await runPreIntercepts(
      {},
      connection,
      [passthrough],
      { event: 'foo', payload: { keep: true } },
      getCtx,
    );

    expect(next).toEqual({ event: 'foo', payload: { keep: true } });
  });

  it('null and other falsy non-undefined returns from a pre-intercept ARE treated as the new payload', async () => {
    // Only `undefined` means "no change". `null`, `0`, `false`, `''` are
    // valid replacement payloads.
    const connection = createConnection();

    const nuller = intercept(() => null);

    const next = await runPreIntercepts(
      {},
      connection,
      [nuller],
      { event: 'foo', payload: { original: true } },
      getCtx,
    );

    expect(next).toEqual({ event: 'foo', payload: null });
  });

  it('runs post intercepts in order and lets them rewrite the payload', async () => {
    const connection = createConnection();

    const first = intercept('hello', async (_ctx, payload: { count: number }) => ({
      count: payload.count + 1,
    }));
    const second = intercept('hello', async (_ctx, payload: { count: number }) => ({
      count: payload.count + 1,
    }));

    const next = await runPostIntercepts({}, connection, [first, second], { count: 1 }, getCtx);

    expect(next).toEqual({ count: 3 });
  });

  it('Block in a pre-intercept still propagates as an error', async () => {
    const { Block } = await import('@wskit/core');
    const connection = createConnection();

    const blocker = intercept(async () => {
      throw Block;
    });

    await expect(
      runPreIntercepts({}, connection, [blocker], { event: 'test', payload: {} }, getCtx),
    ).rejects.toBe(Block);
  });

  it('validation runs before post-intercepts: post-intercept receives already-validated payload', async () => {
    // This test documents the ordering contract: validation fires at step 3
    // and post-intercepts fire at step 4, so by the time a post-intercept
    // runs the payload has already been validated. Changing the order would
    // break this assumption.
    const connection = createConnection();

    const payloadsSeenByPost: unknown[] = [];
    const enricher = intercept('hello', async (_ctx, payload: { count: number }) => {
      payloadsSeenByPost.push(payload);
      return payload;
    });

    // Simulate: validation has already run and produced { count: 42 }.
    // Post-intercept should receive the post-validation value.
    const result = await runPostIntercepts({}, connection, [enricher], { count: 42 }, getCtx);

    expect(payloadsSeenByPost).toEqual([{ count: 42 }]);
    expect(result).toEqual({ count: 42 });
  });

  it('runs the scoped callback inside the connection async context, auto-scoped on throw', async () => {
    const asyncContext = new AsyncLocalStorage<string>();
    const connection = createConnection();

    let seen: string | undefined;
    await expect(
      runWithScopedContext({ asyncContext }, connection, {}, async () => {
        seen = asyncContext.getStore();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The callback ran with the connection id in scope; the throw does not
    // leak the context — `run()` auto-scopes it.
    expect(seen).toBe('c1');
    expect(asyncContext.getStore()).toBeUndefined();
  });
});
