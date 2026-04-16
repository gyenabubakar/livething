import { scope } from '~/channel/channel.ts';
import {
  addChannelMembership,
  leaveChannel,
  subscribeConnection,
  unsubscribeConnection,
} from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';

function createConnection(id = 'conn_1', meta: Record<string, unknown> = {}) {
  return {
    id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    },
    meta,
    tags: new Set<string>(),
    channels: new Set<string>(),
    channelMemberships: new Map(),
    latency: null,
    quality: 'good' as const,
  };
}

function createRuntime() {
  const protocol: { connectionId: string; event: string; payload: Record<string, unknown> }[] = [];
  const broadcasts: {
    channelName: string;
    event: string;
    payload: unknown;
    excludeConnectionId?: string;
    channelScope?: string;
  }[] = [];

  const rooms = {
    key: 'rooms' as string,
    kind: 'channel' as const,
    pattern: scope('rooms', /^room:/) as ReturnType<typeof scope>,
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    preIntercepts: [],
    postIntercepts: new Map(),
  };

  const connections = new Map<string, ReturnType<typeof createConnection>>();

  return {
    protocol,
    broadcasts,
    connections,
    runtime: {
      compiled: {
        channels: new Map(),
        channelFamilies: new Map([['rooms', rooms]]),
      },
      connections,
      beforeSubscribeHooks: new Map(),
      subscribeHooks: new Map(),
      unsubscribeHooks: new Map(),
      toConnectionInfo(connection: ReturnType<typeof createConnection>) {
        return {
          id: connection.id,
          meta: connection.meta,
          tags: [...connection.tags],
          channels: [...connection.channels],
          latency: connection.latency,
          quality: connection.quality,
          bufferedAmount: 0,
        };
      },
      buildConnectionContext(connection: ReturnType<typeof createConnection>, scope?: unknown) {
        return {
          id: connection.id,
          meta: connection.meta,
          scope,
        };
      },
      persistAttachment() {},
      sendProtocolMessage(
        connection: ReturnType<typeof createConnection>,
        event: string,
        payload: Record<string, unknown>,
      ) {
        protocol.push({ connectionId: connection.id, event, payload });
      },
      broadcastToChannel(
        channelName: string,
        event: string,
        payload: unknown,
        excludeConnectionId?: string,
        channelScope?: string,
      ) {
        broadcasts.push({ channelName, event, payload, excludeConnectionId, channelScope });
      },
      async handleValidationError() {},
    },
  };
}

describe('channel runtime', () => {
  it('subscribes a connection and sends member sync events', async () => {
    const first = createConnection('conn_1', { userId: 'a' });
    addChannelMembership(first, 'room:general', 'rooms');

    const second = createConnection('conn_2', { userId: 'b' });
    const { runtime, connections, protocol, broadcasts } = createRuntime();
    connections.set(first.id, first);
    connections.set(second.id, second);

    await subscribeConnection(runtime, second, {
      _channel: 'room:general',
      _channelScope: 'rooms',
    });

    expect(second.channels.has('room:general')).toBe(true);
    expect(second.tags.has('channel:room:general')).toBe(true);
    expect(protocol).toEqual([
      {
        connectionId: 'conn_2',
        event: '_subscribeOk',
        payload: { _channel: 'room:general', _channelScope: 'rooms' },
      },
      {
        connectionId: 'conn_2',
        event: '_memberJoin',
        payload: {
          _channel: 'room:general',
          _channelScope: 'rooms',
          connectionId: 'conn_1',
          meta: { userId: 'a' },
        },
      },
    ]);
    expect(broadcasts).toEqual([
      {
        channelName: 'room:general',
        event: '_memberJoin',
        payload: {
          connectionId: 'conn_2',
          meta: { userId: 'b' },
        },
        excludeConnectionId: 'conn_2',
        channelScope: 'rooms',
      },
    ]);
  });

  it('unsubscribes a connection and broadcasts member leave', async () => {
    const connection = createConnection('conn_1', { userId: 'a' });
    addChannelMembership(connection, 'room:general', 'rooms');

    const { runtime, connections, broadcasts } = createRuntime();
    connections.set(connection.id, connection);

    await unsubscribeConnection(
      {
        ...runtime,
        leaveChannel: async (nextConnection, scope, kickedReason) =>
          leaveChannel(runtime, nextConnection, scope, kickedReason),
      },
      connection,
      {
        _channel: 'room:general',
        _channelScope: 'rooms',
      },
    );

    expect(connection.channels.has('room:general')).toBe(false);
    expect(connection.tags.has('channel:room:general')).toBe(false);
    expect(broadcasts).toEqual([
      {
        channelName: 'room:general',
        event: '_memberLeave',
        payload: { connectionId: 'conn_1' },
        excludeConnectionId: 'conn_1',
        channelScope: 'rooms',
      },
    ]);
  });

  it('keeps same-name memberships isolated across channel families', async () => {
    const connection = createConnection('conn_1');

    addChannelMembership(connection, 'room:general', 'rooms');
    addChannelMembership(connection, 'room:general', 'lobbies');

    const { runtime, connections, broadcasts } = createRuntime();
    runtime.compiled.channelFamilies.set('lobbies', {
      ...runtime.compiled.channelFamilies.get('rooms')!,
      key: 'lobbies',
      pattern: scope('lobbies', /^room:/),
    });
    connections.set(connection.id, connection);

    await unsubscribeConnection(
      {
        ...runtime,
        leaveChannel: async (nextConnection, scopeArg, kickedReason) =>
          leaveChannel(runtime, nextConnection, scopeArg, kickedReason),
      },
      connection,
      {
        _channel: 'room:general',
        _channelScope: 'rooms',
      },
    );

    expect(connection.channels.has('room:general')).toBe(true);
    expect(connection.channelMemberships.size).toBe(1);
    expect(connection.channelMemberships.has('lobbies::room:general')).toBe(true);
    expect(broadcasts).toEqual([
      {
        channelName: 'room:general',
        event: '_memberLeave',
        payload: { connectionId: 'conn_1' },
        excludeConnectionId: 'conn_1',
        channelScope: 'rooms',
      },
    ]);
  });
});
