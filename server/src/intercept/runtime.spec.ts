import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { intercept } from './intercept.ts';
import { runIntercepts, runWithScopedContext } from './runtime.ts';
import type { InterceptFrame } from './intercept.ts';

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

function makeFrame(event: string, payload: unknown): InterceptFrame {
  return { event, payload, kind: 'incoming', routing: {} };
}

describe('intercept/runtime', () => {
  it('runs intercepts in order and lets them rewrite the payload', async () => {
    const connection = createConnection();

    const first = intercept(async (_ctx, frame) => ({
      ...(frame.payload as Record<string, unknown>),
      a: 1,
    }));
    const second = intercept(async (_ctx, frame) => ({
      ...(frame.payload as Record<string, unknown>),
      b: 2,
    }));

    const next = await runIntercepts({}, connection, {
      intercepts: [first, second],
      frame: makeFrame('hello', {}),
      getCtx,
    });

    expect(next.event).toBe('hello');
    expect(next.payload).toEqual({ a: 1, b: 2 });
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

    await runIntercepts({}, connection, {
      intercepts: [a, b],
      frame: makeFrame('e', {}),
      getCtx: countingGetCtx,
    });

    expect(builds).toBe(1);
    expect(seen[0]).toBe(seen[1]);
  });

  it('does not build a context when there are no intercepts', async () => {
    const connection = createConnection();
    let builds = 0;

    const next = await runIntercepts({}, connection, {
      intercepts: [],
      frame: makeFrame('e', { keep: true }),
      getCtx: () => {
        builds += 1;
        return {};
      },
    });

    expect(builds).toBe(0);
    expect(next.payload).toEqual({ keep: true });
  });

  it('locks the event name: a returned {event, payload} object becomes the new payload as a whole', async () => {
    const connection = createConnection();

    // User code that "tries" to rewrite the event by returning a full
    // {event, payload} shape. The engine must NOT route based on this —
    // the wrapper object becomes the new payload verbatim.
    const aliasing = intercept(async () => ({
      event: 'real',
      payload: { count: 7 },
    }));

    const next = await runIntercepts({}, connection, {
      intercepts: [aliasing],
      frame: makeFrame('alias', { ignored: true }),
      getCtx,
    });

    // Event stays locked at the wire-level 'alias'. The whole returned
    // object becomes frame.payload.
    expect(next.event).toBe('alias');
    expect(next.payload).toEqual({ event: 'real', payload: { count: 7 } });
  });

  it('void return passes the payload through unchanged', async () => {
    const connection = createConnection();

    const passthrough = intercept(() => undefined);

    const next = await runIntercepts({}, connection, {
      intercepts: [passthrough],
      frame: makeFrame('foo', { keep: true }),
      getCtx,
    });

    expect(next.payload).toEqual({ keep: true });
  });

  it('null and other falsy non-undefined returns ARE treated as the new payload', async () => {
    // Only `undefined` means "no change". `null`, `0`, `false`, `''` are
    // valid replacement payloads.
    const connection = createConnection();

    const nuller = intercept(() => null);

    const next = await runIntercepts({}, connection, {
      intercepts: [nuller],
      frame: makeFrame('foo', { original: true }),
      getCtx,
    });

    expect(next.payload).toBeNull();
  });

  it('Block in an intercept still propagates as an error', async () => {
    const { Block } = await import('@wskit/core');
    const connection = createConnection();

    const blocker = intercept(async () => {
      throw Block;
    });

    await expect(
      runIntercepts({}, connection, {
        intercepts: [blocker],
        frame: makeFrame('test', {}),
        getCtx,
      }),
    ).rejects.toBe(Block);
  });

  it('preserves kind and routing across the chain', async () => {
    const connection = createConnection();

    const seen: InterceptFrame[] = [];
    const recorder = intercept((_ctx, frame) => {
      seen.push(frame);
      return { stamped: true };
    });
    const second = intercept((_ctx, frame) => {
      seen.push(frame);
      return undefined;
    });

    const start: InterceptFrame = {
      event: 'go',
      payload: { v: 1 },
      kind: 'request',
      routing: { correlationId: 'abc-123' },
    };
    const next = await runIntercepts({}, connection, {
      intercepts: [recorder, second],
      frame: start,
      getCtx,
    });

    expect(seen[0]?.kind).toBe('request');
    expect(seen[0]?.routing.correlationId).toBe('abc-123');
    expect(seen[1]?.payload).toEqual({ stamped: true });
    expect(seen[1]?.kind).toBe('request');
    expect(seen[1]?.routing.correlationId).toBe('abc-123');
    expect(next.kind).toBe('request');
    expect(next.routing.correlationId).toBe('abc-123');
  });

  it('runs the scoped callback inside the connection async context, auto-scoped on throw', async () => {
    const asyncContext = new AsyncLocalStorage<string>();
    const connection = createConnection();

    let seen: string | undefined;
    await expect(
      runWithScopedContext({ asyncContext }, connection, {
        ctx: {},
        handler: async () => {
          seen = asyncContext.getStore();
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    // The callback ran with the connection id in scope; the throw does not
    // leak the context — `run()` auto-scopes it.
    expect(seen).toBe('c1');
    expect(asyncContext.getStore()).toBeUndefined();
  });
});
