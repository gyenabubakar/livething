import { processTextMessage } from '~/_engine/runtime/messages.ts';
import { bufferStreamNudge } from '~/stream/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

interface SendMessageOptions {
  event: string;
  payload?: unknown;
  wskit?: Record<string, unknown>;
}

async function send(
  runtime: ReturnType<typeof makeRuntime>,
  connection: RuntimeConnection,
  { event, payload, wskit }: SendMessageOptions,
) {
  await processTextMessage(runtime, connection, JSON.stringify({ event, payload, __wskit: wskit }));
}

function makeConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    userId: id,
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
      channels: new Map(),
      channelFamilies: new Map(),
      scheduled: new Map(),
      intercepts: [],
    },
    activeStreams: new Map(),
    protocolHandlers: new Map(),
    incomingHooks: [incomingHook],
    activityHooks: [],
    messageActivityHooks: [],
    errorHooks: [],
    incomingDedupCap: cap,
    streamNudgeBuffer: bufferStreamNudge,
    connections: new Map(),
    logger: { warn() {}, error() {} },
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

    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'abc' } });
    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'abc' } });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(1);
  });

  it('does not dedup frames without a messageId', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);

    await send(runtime, connection, { event: 'echo', payload: { text: 'hi' } });
    await send(runtime, connection, { event: 'echo', payload: { text: 'hi' } });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest id when the ring fills', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(2);

    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'a' } });
    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'b' } });
    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'c' } });
    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'a' } });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(4);
  });

  it('still dedups ids still inside the window after eviction', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(2);

    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'a' } });
    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'b' } });
    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'b' } });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
  });

  it('keeps each connection isolated', async () => {
    const c1 = makeConnection('c1');
    const c2 = makeConnection('c2');
    const runtime = makeRuntime(16);

    await send(runtime, c1, { event: 'echo', payload: {}, wskit: { messageId: 'shared' } });
    await send(runtime, c2, { event: 'echo', payload: {}, wskit: { messageId: 'shared' } });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
  });

  it('is disabled when cap is 0', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(0);

    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'abc' } });
    await send(runtime, connection, { event: 'echo', payload: {}, wskit: { messageId: 'abc' } });

    expect(runtime.incomingHook).toHaveBeenCalledTimes(2);
    expect(connection.seenIncomingIds).toBeUndefined();
  });

  it('drops duplicate stream nudge frames before they reach the active stream buffer', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);
    const nudges: Array<{ event: string; payload: unknown }> = [];
    runtime.activeStreams.set('s-1', {
      id: 's-1',
      connectionId: connection.id,
      closed: false,
      nudges,
      nudgeValidators: new Map([
        ['speed-up', { '~standard': { validate: (v: unknown) => ({ value: v }) } }],
      ]),
    } as unknown as Parameters<typeof runtime.activeStreams.set>[1]);

    await send(runtime, connection, {
      event: 'speed-up',
      payload: { factor: 2 },
      wskit: { streamId: 's-1', messageId: 'n-1' },
    });
    await send(runtime, connection, {
      event: 'speed-up',
      payload: { factor: 2 },
      wskit: { streamId: 's-1', messageId: 'n-1' },
    });

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
    await send(runtime, connection, {
      event: '__subscribe__',
      payload: undefined,
      wskit: { channel: 'room' },
    });
    await send(runtime, connection, {
      event: '__subscribe__',
      payload: undefined,
      wskit: { channel: 'room' },
    });

    expect(handleSubscribe).toHaveBeenCalledTimes(2);
  });

  it('does not dedup __unsubscribe__ frames', async () => {
    const connection = makeConnection();
    const runtime = makeRuntime(16);
    const handleUnsubscribe = vi.fn(async () => {});
    (runtime as unknown as { handleUnsubscribe: typeof handleUnsubscribe }).handleUnsubscribe =
      handleUnsubscribe;

    await send(runtime, connection, {
      event: '__unsubscribe__',
      payload: {},
      wskit: { channel: 'room' },
    });
    await send(runtime, connection, {
      event: '__unsubscribe__',
      payload: {},
      wskit: { channel: 'room' },
    });

    expect(handleUnsubscribe).toHaveBeenCalledTimes(2);
  });
});
