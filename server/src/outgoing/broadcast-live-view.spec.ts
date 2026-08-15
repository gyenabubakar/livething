import { broadcastToConnections } from '~/outgoing/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string, onSend: (id: string) => void): RuntimeConnection {
  return {
    id,
    userId: id,
    wsKey: Symbol(id),
    descriptor: {
      send() {
        onSend(id);
      },
      close() {},
      bufferedAmount: () => 0,
      identity: id,
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  } as unknown as RuntimeConnection;
}

function createRuntime(): Parameters<typeof broadcastToConnections>[0] {
  return {
    afterSendHooks: [],
    beforeSendHooks: [],
    compiled: {
      outgoing: new Map([['tick', { event: 'tick' }]]),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      channels: new Map(),
    },
    generateId: () => 'id',
    logger: undefined,
    outgoingHooks: [],
    waitUntil: () => {},
    wskitStampHooks: [],
  } as unknown as Parameters<typeof broadcastToConnections>[0];
}

describe('broadcastToConnections over a live view', () => {
  it('walks the connections as they stand, not a copy taken up front', () => {
    const delivered: string[] = [];
    const connections = new Map<string, RuntimeConnection>();

    // The only way to reach the connection map mid-fan-out is from inside a
    // send. A socket opening over the network cannot, because it arrives on a
    // callback and this loop never yields.
    function record(id: string): void {
      delivered.push(id);
      if (id === 'a') connections.set('late', createConnection('late', record));
    }

    connections.set('a', createConnection('a', record));
    connections.set('b', createConnection('b', record));

    broadcastToConnections(createRuntime(), connections.values(), {
      event: 'tick',
      payload: {},
      options: undefined,
      excludeConnectionId: undefined,
    });

    expect(delivered).toEqual(['a', 'b', 'late']);
  });

  it('skips a connection dropped before the fan-out reaches it', () => {
    const delivered: string[] = [];
    const connections = new Map<string, RuntimeConnection>();

    function record(id: string): void {
      delivered.push(id);
      if (id === 'a') connections.delete('c');
    }

    for (const id of ['a', 'b', 'c']) {
      connections.set(id, createConnection(id, record));
    }

    broadcastToConnections(createRuntime(), connections.values(), {
      event: 'tick',
      payload: {},
      options: undefined,
      excludeConnectionId: undefined,
    });

    expect(delivered).toEqual(['a', 'b']);
  });

  it('serializes nothing when every peer is excluded', () => {
    let serialized = 0;
    const runtime = createRuntime() as unknown as {
      wskitStampHooks: ((...args: unknown[]) => unknown)[];
    };
    runtime.wskitStampHooks = [
      (...args: unknown[]) => {
        serialized += 1;
        return args[0];
      },
    ];

    const self = createConnection('self', () => {
      throw new Error('excluded peer must not be sent to');
    });

    broadcastToConnections(runtime as never, [self], {
      event: 'tick',
      payload: {},
      options: undefined,
      excludeConnectionId: 'self',
    });

    expect(serialized).toBe(0);
  });
});
