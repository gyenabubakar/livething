import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { handleRequest, readCorrelationId } from './runtime.ts';
import type { RequestPrimitive } from './request.ts';

function createConnection(): RuntimeConnection {
  return {
    id: 'c1',
    wsKey: 'ws1',
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: new Set(),
    channels: new Set(),
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

describe('request/runtime', () => {
  it('reads the request correlation id from the raw payload', () => {
    expect(readCorrelationId({ _correlationId: 123 })).toBe('123');
    expect(readCorrelationId({})).toBeUndefined();
    expect(readCorrelationId(null)).toBeUndefined();
  });

  it('sends the request response with scope routing and correlation metadata', async () => {
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      setActiveConnectionId: vi.fn(),
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
      { room: 'room-1', _correlationId: 'req-1' },
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
      setActiveConnectionId: vi.fn(),
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

    await expect(handleRequest(runtime, connection, {}, 'status', request, {}, {})).rejects.toThrow(
      '[wskit] ctx.respond() was already called',
    );
  });

  it('passes undefined to sendThroughPipeline when handler never calls ctx.respond()', async () => {
    const sendThroughPipeline = vi.fn(() => true);
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      setActiveConnectionId: vi.fn(),
      sendThroughPipeline,
    };
    const connection = createConnection();
    const request = {
      __wskit: 'request',
      event: 'status',
      handler: vi.fn(async () => {
        // Never calls ctx.respond() — response stays undefined.
      }),
    } as unknown as RequestPrimitive;

    await handleRequest(runtime, connection, {}, 'status', request, {}, {});

    expect(sendThroughPipeline).toHaveBeenCalledWith(
      connection,
      expect.anything(),
      'status',
      undefined,
    );
  });

  it('clears the active connection id when a request handler throws', async () => {
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      setActiveConnectionId: vi.fn(),
      sendThroughPipeline: vi.fn(() => true),
    };
    const connection = createConnection();
    const request = {
      __wskit: 'request',
      event: 'status',
      handler: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as RequestPrimitive;

    await expect(handleRequest(runtime, connection, {}, 'status', request, {}, {})).rejects.toThrow(
      'boom',
    );

    expect(runtime.setActiveConnectionId).toHaveBeenNthCalledWith(1, 'c1');
    expect(runtime.setActiveConnectionId).toHaveBeenNthCalledWith(2, undefined);
  });
});
