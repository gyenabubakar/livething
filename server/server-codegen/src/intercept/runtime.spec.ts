import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { intercept } from './intercept.ts';
import { runPostIntercepts, runPreIntercepts, runWithScopedContext } from './runtime.ts';

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
    latency: null,
    quality: 'good',
  };
}

describe('intercept/runtime', () => {
  it('runs pre intercepts in order and lets them rewrite the message', async () => {
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      setActiveConnectionId: vi.fn(),
    };
    const connection = createConnection();

    const first = intercept(async (_ctx, message) => ({
      event: message.event,
      payload: { ...(message.payload as Record<string, unknown>), a: 1 },
    }));
    const second = intercept(async (_ctx, message) => ({
      event: message.event,
      payload: { ...(message.payload as Record<string, unknown>), b: 2 },
    }));

    const next = await runPreIntercepts(runtime, connection, {}, [first, second], {
      event: 'hello',
      payload: {},
    });

    expect(next).toEqual({ event: 'hello', payload: { a: 1, b: 2 } });
    expect(runtime.setActiveConnectionId).toHaveBeenNthCalledWith(1, 'c1');
    expect(runtime.setActiveConnectionId).toHaveBeenNthCalledWith(2, undefined);
    expect(runtime.setActiveConnectionId).toHaveBeenNthCalledWith(3, 'c1');
    expect(runtime.setActiveConnectionId).toHaveBeenNthCalledWith(4, undefined);
  });

  it('runs post intercepts in order and lets them rewrite the payload', async () => {
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      setActiveConnectionId: vi.fn(),
    };
    const connection = createConnection();

    const first = intercept('hello', async (_ctx, payload: { count: number }) => ({
      count: payload.count + 1,
    }));
    const second = intercept('hello', async (_ctx, payload: { count: number }) => ({
      count: payload.count + 1,
    }));

    const next = await runPostIntercepts(runtime, connection, {}, [first, second], { count: 1 });

    expect(next).toEqual({ count: 3 });
  });

  it('always clears the active connection id even when a scoped callback throws', async () => {
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      setActiveConnectionId: vi.fn(),
    };
    const connection = createConnection();

    await expect(
      runWithScopedContext(runtime, connection, {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(runtime.setActiveConnectionId).toHaveBeenNthCalledWith(1, 'c1');
    expect(runtime.setActiveConnectionId).toHaveBeenNthCalledWith(2, undefined);
  });
});
