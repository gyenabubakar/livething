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
    channelMemberships: new Map(),
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

  it('Block in a pre-intercept still propagates as an error', async () => {
    const { Block } = await import('@wskit/core');
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      setActiveConnectionId: vi.fn(),
    };
    const connection = createConnection();

    const blocker = intercept(async () => {
      throw Block;
    });

    await expect(
      runPreIntercepts(runtime, connection, {}, [blocker], { event: 'test', payload: {} }),
    ).rejects.toBe(Block);
  });

  it('validation runs before post-intercepts: post-intercept receives already-validated payload', async () => {
    // This test documents the ordering contract: validation fires at step 3
    // and post-intercepts fire at step 4, so by the time a post-intercept
    // runs the payload has already been validated. Changing the order would
    // break this assumption.
    const runtime = {
      buildConnectionContext: () => ({ ok: true }),
      setActiveConnectionId: vi.fn(),
    };
    const connection = createConnection();

    const payloadsSeenByPost: unknown[] = [];
    const enricher = intercept('hello', async (_ctx, payload: { count: number }) => {
      payloadsSeenByPost.push(payload);
      return payload;
    });

    // Simulate: validation has already run and produced { count: 42 }.
    // Post-intercept should receive the post-validation value.
    const result = await runPostIntercepts(runtime, connection, {}, [enricher], { count: 42 });

    expect(payloadsSeenByPost).toEqual([{ count: 42 }]);
    expect(result).toEqual({ count: 42 });
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
