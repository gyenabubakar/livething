import { dispatchIncoming } from '~/_engine/runtime/messages.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function makeConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    wsKey: {},
    descriptor: { send() {}, close() {} } as unknown as RuntimeConnection['descriptor'],
    meta: {},
    tags: new Set(),
    channels: new Set(),
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function makeRuntime(cap: number) {
  const incomingHook = vi.fn((m: { event: string; payload: unknown }) => m);
  return {
    compiled: {
      incoming: new Map(),
      outgoing: new Map(),
      requests: new Map(),
      streams: new Map(),
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map(),
      scheduled: new Map(),
      preIntercepts: [],
      postIntercepts: new Map(),
    },
    activeStreams: new Map(),
    protocolHandlers: new Map(),
    incomingHooks: [incomingHook],
    errorHooks: [],
    incomingDedupCap: cap,
    connections: new Map(),
    moduleRuntimes: [],
    logger: { warn() {}, error() {} },
    requireTimers: () => ({ setTimeout: () => undefined, clearTimeout() {} }),
    buildConnectionContext: () => ({}),
    sendProtocolMessage() {},
    sendReplay() {},
    persistAttachment() {},
    setActiveConnectionId() {},
    async handleRuntimeError() {},
    async handleValidationError() {},
    broadcastToConnections() {},
    async handleSubscribe() {},
    async handleUnsubscribe() {},
    incomingHook,
  } as unknown as Parameters<typeof dispatchIncoming>[0] & {
    incomingHook: ReturnType<typeof vi.fn>;
  };
}

describe('incoming dedup', () => {
  it('drops a second frame with the same _messageId', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);

    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'abc' });
    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'abc' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(1);
  });

  it('does not dedup frames without a _messageId', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);

    await dispatchIncoming(runtime, connection, 'echo', { text: 'hi' });
    await dispatchIncoming(runtime, connection, 'echo', { text: 'hi' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest id when the ring fills', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(2);

    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'a' });
    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'b' });
    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'c' });
    // 'a' was evicted by 'c', so resending 'a' should dispatch again
    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'a' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(4);
  });

  it('still dedups ids still inside the window after eviction', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(2);

    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'a' });
    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'b' });
    // 'b' is still in the window; resending must be dropped
    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'b' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
  });

  it('keeps each connection isolated', async () => {
    const c1 = makeConnection('c1');
    const c2 = makeConnection('c2');
    const runtime = makeRuntime(16);

    await dispatchIncoming(runtime, c1, 'echo', { _messageId: 'shared' });
    await dispatchIncoming(runtime, c2, 'echo', { _messageId: 'shared' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
  });

  it('is disabled when cap is 0', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(0);

    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'abc' });
    await dispatchIncoming(runtime, connection, 'echo', { _messageId: 'abc' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
    expect(connection.seenIncomingIds).toBeUndefined();
  });
});
