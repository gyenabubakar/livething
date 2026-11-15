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
    userId: 'c1',
    socketKey: 'ws1',
    descriptor: {
      send() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
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
      logger: { error: vi.fn() },
      sendThroughPipeline,
    };

    const connection = createConnection();
    const request = {
      __livething: 'request',
      event: 'status',
      handler: vi.fn(async (ctx: { respond: (value: unknown) => void }) => {
        ctx.respond({ ok: true });
      }),
    } as unknown as RequestPrimitive;

    await handleRequest(runtime, {
      connection,
      ctx: { ok: true },
      scope: { channelName: 'room-1', channelFamily: 'rooms' },
      event: 'status',
      request,
      payload: { room: 'room-1' },
      livething: { channelFamily: null, correlationId: 'req-1' },
    });

    expect(sendThroughPipeline).toHaveBeenCalledWith(connection, {
      routing: {
        channel: 'room-1',
        channelFamily: 'rooms',
        correlationId: 'req-1',
        source: 'client',
      },
      event: 'status',
      payload: { ok: true },
    });
  });

  it('calling ctx.respond() twice logs server-side and sends only the first response', async () => {
    const sendThroughPipeline = vi.fn(() => true);
    const error = vi.fn();
    const runtime = {
      asyncContext: makeAsyncContext(),
      logger: { error },
      sendThroughPipeline,
    };

    const connection = createConnection();
    const request = {
      __livething: 'request',
      event: 'status',
      handler: vi.fn(async (ctx: { respond: (value: unknown) => void }) => {
        ctx.respond({ first: true });
        ctx.respond({ second: true });
      }),
    } as unknown as RequestPrimitive;

    // The second respond() is a server bug, not a client concern. It must not
    // reach the client (which already got the first response) — it's logged.
    await handleRequest(runtime, {
      connection,
      ctx: { ok: true },
      scope: {},
      event: 'status',
      request,
      payload: {},
      livething: { correlationId: 'req-1', channelFamily: null },
    });

    expect(error).toHaveBeenCalledWith(
      '[livething] ctx.respond() was already called for this request invocation; ignoring the extra call',
      { event: 'status' },
    );
    expect(sendThroughPipeline).toHaveBeenCalledTimes(1);
    expect(sendThroughPipeline).toHaveBeenCalledWith(connection, {
      routing: {
        channel: undefined,
        channelFamily: undefined,
        correlationId: 'req-1',
        source: 'client',
      },
      event: 'status',
      payload: { first: true },
    });
  });

  it('sends an undefined-payload void-ack frame when the handler exits without calling ctx.respond()', async () => {
    // A handler that answers nothing is a void acknowledgement, not a failure:
    // the runtime sends a correlated frame with an undefined payload, which the
    // client resolves with no value. To reject instead, a handler throws.
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      asyncContext: makeAsyncContext(),
      logger: { error: vi.fn() },
      sendThroughPipeline,
    };

    const connection = createConnection();
    const request = {
      __livething: 'request',
      event: 'status',
      handler: vi.fn(async () => {}),
    } as unknown as RequestPrimitive;

    await handleRequest(runtime, {
      connection,
      ctx: { ok: true },
      scope: {},
      event: 'status',
      request,
      payload: {},
      livething: { correlationId: 'req-1', channelFamily: null },
    });

    expect(sendThroughPipeline).toHaveBeenCalledTimes(1);
    expect(sendThroughPipeline).toHaveBeenCalledWith(connection, {
      routing: {
        channel: undefined,
        channelFamily: undefined,
        correlationId: 'req-1',
        source: 'client',
      },
      event: 'status',
      payload: undefined,
    });
  });

  it('sends an undefined payload when the handler explicitly responds with null', async () => {
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      asyncContext: makeAsyncContext(),
      logger: { error: vi.fn() },
      sendThroughPipeline,
    };

    const connection = createConnection();
    const request = {
      __livething: 'request',
      event: 'status',
      handler: vi.fn(async (ctx: { respond: (value: unknown) => void }) => {
        ctx.respond(null);
      }),
    } as unknown as RequestPrimitive;

    await handleRequest(runtime, {
      connection,
      ctx: { ok: true },
      scope: {},
      event: 'status',
      request,
      payload: {},
      livething: { correlationId: 'req-1', channelFamily: null },
    });

    expect(sendThroughPipeline).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({ payload: undefined }),
    );
  });

  it.each([
    ['0', 0],
    ['false', false],
    ["''", ''],
  ])('preserves a genuinely falsy response of %s', async (_label, value) => {
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      asyncContext: makeAsyncContext(),
      logger: { error: vi.fn() },
      sendThroughPipeline,
    };

    const connection = createConnection();
    const request = {
      __livething: 'request',
      event: 'status',
      handler: vi.fn(async (ctx: { respond: (v: unknown) => void }) => {
        ctx.respond(value);
      }),
    } as unknown as RequestPrimitive;

    await handleRequest(runtime, {
      connection,
      ctx: { ok: true },
      scope: {},
      event: 'status',
      request,
      payload: {},
      livething: { correlationId: 'req-1', channelFamily: null },
    });

    expect(sendThroughPipeline).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({ payload: value }),
    );
  });

  it('preserves a normal object response', async () => {
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      asyncContext: makeAsyncContext(),
      logger: { error: vi.fn() },
      sendThroughPipeline,
    };

    const connection = createConnection();
    const request = {
      __livething: 'request',
      event: 'status',
      handler: vi.fn(async (ctx: { respond: (v: unknown) => void }) => {
        ctx.respond({ ok: true, count: 3 });
      }),
    } as unknown as RequestPrimitive;

    await handleRequest(runtime, {
      connection,
      ctx: { ok: true },
      scope: {},
      event: 'status',
      request,
      payload: {},
      livething: { correlationId: 'req-1', channelFamily: null },
    });

    expect(sendThroughPipeline).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({ payload: { ok: true, count: 3 } }),
    );
  });

  it('runs the request handler inside the connection async context, auto-scoped on throw', async () => {
    const asyncContext = makeAsyncContext();
    const runtime = {
      asyncContext,
      logger: { error: vi.fn() },
      sendThroughPipeline: vi.fn(() => true),
    };

    const connection = createConnection();
    let seen: string | undefined;
    const request = {
      __livething: 'request',
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
        livething: { correlationId: 'req-async', channelFamily: null },
      }),
    ).rejects.toThrow('boom');

    expect(seen).toBe('c1');
    expect(asyncContext.getStore()).toBeUndefined();
  });

  it('reuses the dispatch-shared ctx so request handlers can inject intercept-provided locals', async () => {
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      asyncContext: makeAsyncContext(),
      logger: { error: vi.fn() },
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
      __livething: 'request',
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
      livething: { correlationId: 'req-2', channelFamily: null },
    });

    expect(sendThroughPipeline).toHaveBeenCalledWith(connection, {
      routing: {
        channel: undefined,
        channelFamily: undefined,
        correlationId: 'req-2',
        source: 'client',
      },
      event: 'status',
      payload: { tag: 'top' },
    });
  });
});
