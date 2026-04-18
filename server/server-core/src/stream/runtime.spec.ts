import { describe, expect, it, vi } from 'vitest';
import type { ActiveStream, RuntimeConnection } from '~/_engine/runtime/types.ts';
import { cancelStream, runStream } from './runtime.ts';

function createConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
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

function createStreamRuntime() {
  const protocolMessages: { event: string; payload: Record<string, unknown> }[] = [];
  const pipelineSends: { event: string; payload: unknown }[] = [];
  const broadcasts: { event: string; payload: unknown; excludeConnectionId?: string }[] = [];

  return {
    protocolMessages,
    pipelineSends,
    broadcasts,
    runtime: {
      activeStreams: new Map(),
      connections: new Map<string, RuntimeConnection>(),
      generateId: () => 'stream_1',
      buildConnectionContext: () => ({ id: 'c1', nudges: () => [] }),
      sendProtocolMessage: (
        _conn: RuntimeConnection,
        event: string,
        payload: Record<string, unknown>,
      ) => {
        protocolMessages.push({ event, payload });
      },
      sendThroughPipeline: (
        _conn: RuntimeConnection,
        _scope: unknown,
        event: string,
        payload: unknown,
      ) => {
        pipelineSends.push({ event, payload });
        return true;
      },
      broadcastToConnections: (
        _conns: readonly RuntimeConnection[],
        event: string,
        payload: unknown,
        _options?: unknown,
        excludeConnectionId?: string,
      ) => {
        broadcasts.push({ event, payload, excludeConnectionId });
      },
      setActiveConnectionId: vi.fn(),
      async handleRuntimeError() {},
      async handleValidationError() {},
    },
  };
}

describe('stream/runtime', () => {
  it('_streamEnd includes namespace routing metadata', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      { namespace: { name: 'ai' } as never },
      'stream-prompt',
      stream as never,
      {},
    );

    const streamEnd = protocolMessages.find((m) => m.event === '_streamEnd');
    expect(streamEnd).toBeDefined();
    expect(streamEnd!.payload._namespace).toBe('ai');
  });

  it('_streamEnd includes channel routing metadata', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      { channelName: 'chat', channelScope: 'rooms' },
      'chat-stream',
      stream as never,
      {},
    );

    const streamEnd = protocolMessages.find((m) => m.event === '_streamEnd');
    expect(streamEnd).toBeDefined();
    expect(streamEnd!.payload._channel).toBe('chat');
    expect(streamEnd!.payload._channelScope).toBe('rooms');
  });

  it('broadcast stream sends chunks to all connections', async () => {
    const { runtime, broadcasts, pipelineSends } = createStreamRuntime();
    const trigger = createConnection('trigger');
    const other = createConnection('other');
    runtime.connections.set(trigger.id, trigger);
    runtime.connections.set(other.id, other);

    const stream = {
      stream: { nudges: [], broadcast: true },
      generator: async function* () {
        yield { token: 'hello' };
      },
    };

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      trigger,
      {},
      'broadcast-stream',
      stream as never,
      {},
    );

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.event).toBe('broadcast-stream');
    expect(broadcasts[0]!.excludeConnectionId).toBe('trigger');
    expect(pipelineSends).toHaveLength(1);
    expect(pipelineSends[0]!.event).toBe('broadcast-stream');
  });

  it('_streamCancel from a non-owner connection is ignored', async () => {
    const owner = createConnection('owner');
    const stranger = createConnection('stranger');

    const generator = {
      return: vi.fn(async () => ({ done: true, value: undefined })),
      next: vi.fn(),
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as AsyncGenerator<unknown, void, unknown>;

    const activeStreams = new Map<string, ActiveStream>();
    const streamId = 'stream_owned_by_owner';
    activeStreams.set(streamId, {
      id: streamId,
      connectionId: owner.id,
      generator,
      nudges: [],
      nudgeValidators: new Map(),
      closed: false,
    });

    await cancelStream({ activeStreams }, stranger, { _streamId: streamId });

    expect(generator.return as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(activeStreams.has(streamId)).toBe(true);
    expect(activeStreams.get(streamId)?.closed).toBe(false);
  });

  it('non-broadcast stream does not call broadcastToConnections', async () => {
    const { runtime, broadcasts } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      {},
      'my-stream',
      stream as never,
      {},
    );

    expect(broadcasts).toHaveLength(0);
  });
});
