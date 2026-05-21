import { processTextMessage } from '~/_engine/runtime/messages.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

async function send(
  runtime: ReturnType<typeof makeRuntime>,
  connection: RuntimeConnection,
  event: string,
  payload?: unknown,
  wskit?: Record<string, unknown>,
) {
  await processTextMessage(runtime, connection, JSON.stringify({ event, payload, __wskit: wskit }));
}

function makeConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: {},
    descriptor: { send() {}, close() {} } as unknown as RuntimeConnection['descriptor'],
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
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
      resumableStreams: new Map(),
      recordedStreams: new Map(),
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
    activityHooks: [],
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
    async handleRuntimeError() {},
    async handleValidationError() {},
    broadcastToConnections() {},
    async handleSubscribe() {},
    async handleUnsubscribe() {},
    incomingHook,
  } as unknown as Parameters<typeof processTextMessage>[0] & {
    incomingHook: ReturnType<typeof vi.fn>;
  };
}

describe('incoming dedup', () => {
  it('drops a second frame with the same __wskit.messageId', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);

    await send(runtime, connection, 'echo', {}, { messageId: 'abc' });
    await send(runtime, connection, 'echo', {}, { messageId: 'abc' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(1);
  });

  it('does not dedup frames without a messageId', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);

    await send(runtime, connection, 'echo', { text: 'hi' });
    await send(runtime, connection, 'echo', { text: 'hi' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest id when the ring fills', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(2);

    await send(runtime, connection, 'echo', {}, { messageId: 'a' });
    await send(runtime, connection, 'echo', {}, { messageId: 'b' });
    await send(runtime, connection, 'echo', {}, { messageId: 'c' });
    // 'a' was evicted by 'c', so resending 'a' should dispatch again
    await send(runtime, connection, 'echo', {}, { messageId: 'a' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(4);
  });

  it('still dedups ids still inside the window after eviction', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(2);

    await send(runtime, connection, 'echo', {}, { messageId: 'a' });
    await send(runtime, connection, 'echo', {}, { messageId: 'b' });
    // 'b' is still in the window; resending must be dropped
    await send(runtime, connection, 'echo', {}, { messageId: 'b' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
  });

  it('keeps each connection isolated', async () => {
    const c1 = makeConnection('c1');
    const c2 = makeConnection('c2');
    const runtime = makeRuntime(16);

    await send(runtime, c1, 'echo', {}, { messageId: 'shared' });
    await send(runtime, c2, 'echo', {}, { messageId: 'shared' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
  });

  it('default cap is 256 (DEDUP_DEFAULT_INCOMING_CAP)', async () => {
    const connection = makeConnection();
    // Cap of 256 mirrors the default set by the dedup() primitive.
    const runtime = makeRuntime(256);

    await send(runtime, connection, 'echo', {}, { messageId: 'first' });
    // Fill the ring so 'first' is evicted.
    for (let i = 0; i < 256; i += 1) {
      await send(runtime, connection, 'echo', {}, { messageId: `id-${i}` });
    }
    // After 256 more entries, 'first' was evicted — resending it must dispatch again.
    await send(runtime, connection, 'echo', {}, { messageId: 'first' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(1 + 256 + 1);
  });

  it('is disabled when cap is 0', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(0);

    await send(runtime, connection, 'echo', {}, { messageId: 'abc' });
    await send(runtime, connection, 'echo', {}, { messageId: 'abc' });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
    expect(connection.seenIncomingIds).toBeUndefined();
  });

  it('drops duplicate stream nudge frames before they reach the active stream buffer', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);
    // Set up a fake active stream so the nudge path can buffer.
    const nudges: Array<{ event: string; payload: unknown }> = [];
    runtime.activeStreams.set('s-1', {
      id: 's-1',
      connectionId: connection.id,
      closed: false,
      nudges,
      nudgeValidators: new Map([
        // Pass-through validator — the frame is valid as long as it parses.
        ['speed-up', { '~standard': { validate: (v: unknown) => ({ value: v }) } }],
      ]),
    } as unknown as Parameters<typeof runtime.activeStreams.set>[1]);

    await send(
      runtime,
      connection,
      'speed-up',
      { factor: 2 },
      { streamId: 's-1', messageId: 'n-1' },
    );
    await send(
      runtime,
      connection,
      'speed-up',
      { factor: 2 },
      { streamId: 's-1', messageId: 'n-1' },
    );

    expect(nudges).toHaveLength(1);
  });

  it('does not dedup protocol frames such as __subscribe__', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);
    const handleSubscribe = vi.fn(async () => {});
    (runtime as unknown as { handleSubscribe: typeof handleSubscribe }).handleSubscribe =
      handleSubscribe;

    // Protocol frames take the protocol path before dedup runs, so a repeated
    // frame always reaches its handler.
    await send(runtime, connection, '__subscribe__', undefined, { channel: 'room' });
    await send(runtime, connection, '__subscribe__', undefined, { channel: 'room' });

    expect(handleSubscribe).toHaveBeenCalledTimes(2);
  });

  it('does not dedup __unsubscribe__ frames', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);
    const handleUnsubscribe = vi.fn(async () => {});
    (runtime as unknown as { handleUnsubscribe: typeof handleUnsubscribe }).handleUnsubscribe =
      handleUnsubscribe;

    await send(runtime, connection, '__unsubscribe__', {}, { channel: 'room' });
    await send(runtime, connection, '__unsubscribe__', {}, { channel: 'room' });

    expect(handleUnsubscribe).toHaveBeenCalledTimes(2);
  });
});
