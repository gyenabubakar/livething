import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { handleRequest } from './runtime.ts';
import type { RequestPrimitive } from './request.ts';

type AsyncContextStore = {
  connectionId?: string;
  [key: PropertyKey]: unknown;
};

function makeAsyncContext() {
  return new AsyncLocalStorage<AsyncContextStore>();
}

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

describe('request/runtime', () => {
  it('sends the request response with scope routing and correlation metadata', async () => {
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      asyncContext: makeAsyncContext(),
      sendThroughPipeline,
    };
    const connection = createConnection();
    const request = {
      __wskit: 'request',
      event: 'status',
      handler: vi.fn(async (ctx: { respond: (value: unknown) => void }) => {
        ctx.respond({ ok: true });
      }),
    } as unknown as RequestPrimitive;

    await handleRequest(runtime, {
      connection,
      ctx: { ok: true },
      scope: { channelName: 'room-1', channelScope: 'rooms' },
      event: 'status',
      request,
      payload: { room: 'room-1' },
      wskit: { channelScope: null, correlationId: 'req-1' },
    });

    expect(sendThroughPipeline).toHaveBeenCalledWith(connection, {
      routing: {
        namespace: undefined,
        channel: 'room-1',
        channelScope: 'rooms',
        correlationId: 'req-1',
      },
      event: 'status',
      payload: { ok: true },
    });
  });

  it('calling ctx.respond() twice in one invocation throws', async () => {
    const runtime = {
      asyncContext: makeAsyncContext(),
      sendThroughPipeline: vi.fn(() => true),
    };
    const connection = createConnection();
    const request = {
      __wskit: 'request',
      event: 'status',
      handler: vi.fn(async (ctx: { respond: (value: unknown) => void }) => {
        ctx.respond({ first: true });
        ctx.respond({ second: true });
      }),
    } as unknown as RequestPrimitive;

    await expect(
      handleRequest(runtime, {
        connection,
        ctx: { ok: true },
        scope: {},
        event: 'status',
        request,
        payload: {},
        wskit: undefined,
      }),
    ).rejects.toThrow('[wskit] ctx.respond() was already called');
  });

  it('throws RequestNoResponse when handler exits without calling ctx.respond()', async () => {
    // Pre-fix the runtime swallowed the missing-respond case silently — the
    // client's request promise hung until its own timeout, with no log, no
    // error, and no breadcrumb. The throw lets the outer dispatcher route a
    // correlated `__error__` back through handleRuntimeError using the
    // originating correlationId.
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      asyncContext: makeAsyncContext(),
      sendThroughPipeline,
    };
    const connection = createConnection();
    const request = {
      __wskit: 'request',
      event: 'status',
      handler: vi.fn(async () => {
        // Intentionally never calls ctx.respond().
      }),
    } as unknown as RequestPrimitive;

    await expect(
      handleRequest(runtime, {
        connection,
        ctx: { ok: true },
        scope: {},
        event: 'status',
        request,
        payload: {},
        wskit: { correlationId: 'req-1', channelScope: null },
      }),
    ).rejects.toMatchObject({ code: 'request-no-response' });

    expect(sendThroughPipeline).not.toHaveBeenCalled();
  });

  it('runs the request handler inside the connection async context, auto-scoped on throw', async () => {
    const asyncContext = makeAsyncContext();
    const runtime = {
      asyncContext,
      sendThroughPipeline: vi.fn(() => true),
    };
    const connection = createConnection();
    let seen: string | undefined;
    const request = {
      __wskit: 'request',
      event: 'status',
      handler: vi.fn(async () => {
        seen = asyncContext.getStore()?.connectionId;
        throw new Error('boom');
      }),
    } as unknown as RequestPrimitive;

    await expect(
      handleRequest(runtime, {
        connection,
        ctx: { ok: true },
        scope: {},
        event: 'status',
        request,
        payload: {},
        wskit: undefined,
      }),
    ).rejects.toThrow('boom');

    expect(seen).toBe('c1');
    expect(asyncContext.getStore()).toBeUndefined();
  });

  it('reuses the dispatch-shared ctx so request handlers can inject intercept-provided locals', async () => {
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      asyncContext: makeAsyncContext(),
      sendThroughPipeline,
    };
    const connection = createConnection();
    const shared = new Map<PropertyKey, unknown>();
    const key = Symbol('provided');
    const ctx = {
      provide(localKey: PropertyKey, value: unknown) {
        shared.set(localKey, value);
      },
      inject(localKey: PropertyKey) {
        return shared.get(localKey);
      },
    };
    ctx.provide(key, { tag: 'top' });
    const request = {
      __wskit: 'request',
      event: 'status',
      handler: vi.fn(async (requestCtx: typeof ctx & { respond: (value: unknown) => void }) => {
        requestCtx.respond({
          tag: (requestCtx.inject(key) as { tag: string } | undefined)?.tag ?? 'none',
        });
      }),
    } as unknown as RequestPrimitive;

    await handleRequest(runtime, {
      connection,
      ctx,
      scope: {},
      event: 'status',
      request,
      payload: {},
      wskit: { correlationId: 'req-2', channelScope: null },
    });

    expect(sendThroughPipeline).toHaveBeenCalledWith(connection, {
      routing: {
        namespace: undefined,
        channel: undefined,
        channelScope: undefined,
        correlationId: 'req-2',
      },
      event: 'status',
      payload: { tag: 'top' },
    });
  });
});
