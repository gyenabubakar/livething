import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { handleRequest } from './runtime.ts';
import type { RequestPrimitive } from './request.ts';

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
      buildConnectionContext: () => ({ ok: true }),
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

    await handleRequest(
      runtime,
      connection,
      { channelName: 'room-1', channelScope: 'rooms' },
      'status',
      request,
      { room: 'room-1' },
      { channelScope: null, correlationId: 'req-1' },
    );

    expect(sendThroughPipeline).toHaveBeenCalledWith(
      connection,
      {
        namespace: undefined,
        channel: 'room-1',
        channelScope: 'rooms',
        correlationId: 'req-1',
      },
      'status',
      { ok: true },
    );
  });

  it('calling ctx.respond() twice in one invocation throws', async () => {
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
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
      handleRequest(runtime, connection, {}, 'status', request, {}, undefined),
    ).rejects.toThrow('[wskit] ctx.respond() was already called');
  });

  it('does not call sendThroughPipeline when handler never calls ctx.respond()', async () => {
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      sendThroughPipeline,
    };
    const connection = createConnection();
    const request = {
      __wskit: 'request',
      event: 'status',
      handler: vi.fn(async () => {
        // Never calls ctx.respond() — leave the request hanging on the
        // client. Pushing `undefined` through the pipeline would fail the
        // payload-must-be-an-object check and surface as a spurious _error.
      }),
    } as unknown as RequestPrimitive;

    await handleRequest(runtime, connection, {}, 'status', request, {}, undefined);

    expect(sendThroughPipeline).not.toHaveBeenCalled();
  });

  it('runs the request handler inside the connection async context, auto-scoped on throw', async () => {
    const asyncContext = new AsyncLocalStorage<string>();
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      asyncContext,
      sendThroughPipeline: vi.fn(() => true),
    };
    const connection = createConnection();
    let seen: string | undefined;
    const request = {
      __wskit: 'request',
      event: 'status',
      handler: vi.fn(async () => {
        seen = asyncContext.getStore();
        throw new Error('boom');
      }),
    } as unknown as RequestPrimitive;

    await expect(
      handleRequest(runtime, connection, {}, 'status', request, {}, undefined),
    ).rejects.toThrow('boom');

    expect(seen).toBe('c1');
    expect(asyncContext.getStore()).toBeUndefined();
  });
});
