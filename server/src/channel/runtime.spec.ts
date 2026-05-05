import { scope } from '~/channel/channel.ts';
import {
  addChannelMembership,
  createChannelMembershipKey,
  leaveChannel,
  subscribeConnection,
  unsubscribeConnection,
} from '~/channel/runtime.ts';
import { describe, expect, it, vi } from 'vitest';

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
          channels: [...connection.channelMemberships.values()].map((m) => m.channelName),
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
        excludeConnectionId: string | undefined,
        channelScope: string | null,
      ) {
        broadcasts.push({
          channelName,
          event,
          payload,
          excludeConnectionId,
          channelScope: channelScope ?? undefined,
        });
      },
      async handleValidationError() {},
      async handleRuntimeError() {},
    },
  };
}

describe('createChannelMembershipKey', () => {
  it('produces distinct keys for previously colliding (scope, name) pairs', () => {
    // Family 'rooms' + name 'private::lobby' would have collided with family
    // 'rooms::private' + name 'lobby' under the old `${scope}::${name}` join.
    const a = createChannelMembershipKey('private::lobby', 'rooms');
    const b = createChannelMembershipKey('lobby', 'rooms::private');
    expect(a).not.toBe(b);
  });

  it('uses JSON-encoded tuples as the key format', () => {
    expect(createChannelMembershipKey('lobby', null)).toBe(JSON.stringify([null, 'lobby']));
    expect(createChannelMembershipKey('lobby', 'rooms')).toBe(JSON.stringify(['rooms', 'lobby']));
  });
});

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

    expect(
      [...second.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
    // Subscribing must not auto-tag the connection. Tags are scope-blind by
    // design (a tag is just a string in a Set), so an auto `channel:<name>`
    // tag would collapse static-vs-family and family-vs-family distinctions.
    expect(second.tags.has('channel:room:general')).toBe(false);
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

    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(false);
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

    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
    expect(connection.channelMemberships.size).toBe(1);
    expect(
      connection.channelMemberships.has(createChannelMembershipKey('room:general', 'lobbies')),
    ).toBe(true);
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

  it('subscribeConnection only syncs members from the same scope (cross-scope isolation)', async () => {
    // Two channel families that share the concrete channel name 'room:general'.
    // A connection joining one scope should only see the other scope's members
    // when subscribing — not connections from a sibling scope.
    const roomsMember = createConnection('rooms-member', { userId: 'a' });
    const lobbiesMember = createConnection('lobbies-member', { userId: 'b' });
    addChannelMembership(roomsMember, 'room:general', 'rooms');
    addChannelMembership(lobbiesMember, 'room:general', 'lobbies');

    const newSubscriber = createConnection('new-sub');
    const { runtime, connections, protocol } = createRuntime();
    runtime.compiled.channelFamilies.set('lobbies', {
      ...runtime.compiled.channelFamilies.get('rooms')!,
      key: 'lobbies',
      pattern: scope('lobbies', /^room:/),
    });
    connections.set(roomsMember.id, roomsMember);
    connections.set(lobbiesMember.id, lobbiesMember);
    connections.set(newSubscriber.id, newSubscriber);

    await subscribeConnection(runtime, newSubscriber, {
      _channel: 'room:general',
      _channelScope: 'rooms',
    });

    // _memberJoin syncs sent to the new subscriber must include only the
    // 'rooms' scope member, not the 'lobbies' scope member.
    const memberJoins = protocol.filter(
      (m) => m.connectionId === 'new-sub' && m.event === '_memberJoin',
    );
    expect(memberJoins.map((m) => m.payload.connectionId)).toEqual(['rooms-member']);
  });

  it('onBeforeSubscribe with an async validator throws WskitConfigError without routing through handleValidationError', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    const handleValidationError = vi.fn();
    const hook = vi.fn();

    await expect(
      subscribeConnection(
        {
          ...runtime,
          handleValidationError,
          beforeSubscribeHooks: new Map([
            ['rooms', [{ handler: hook, validator: (v: unknown) => Promise.resolve(v) }]],
          ]),
        },
        connection,
        { _channel: 'room:general', _channelScope: 'rooms' },
      ),
    ).rejects.toThrow(/async validators are not supported/);

    expect(handleValidationError).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it('onBeforeSubscribe fires before addChannelMembership (ordering guarantee)', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    let wasMemberDuringHook = true;
    const hook = vi.fn(async () => {
      wasMemberDuringHook = [...connection.channelMemberships.values()].some(
        (m) => m.channelName === 'room:general',
      );
    });

    await subscribeConnection(
      {
        ...runtime,
        beforeSubscribeHooks: new Map([['rooms', [{ handler: hook, validator: undefined }]]]),
      },
      connection,
      { _channel: 'room:general', _channelScope: 'rooms' },
    );

    expect(hook).toHaveBeenCalledTimes(1);
    // At hook invocation time the connection must NOT yet be a member.
    expect(wasMemberDuringHook).toBe(false);
    // After subscribe completes the connection IS a member.
    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
  });

  it('sends _subscribeOk before running onSubscribe side effects', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections, protocol } = createRuntime();
    connections.set(connection.id, connection);

    let protocolCountDuringHook = -1;
    const hook = vi.fn(async () => {
      protocolCountDuringHook = protocol.length;
    });

    await subscribeConnection(
      {
        ...runtime,
        subscribeHooks: new Map([['rooms', [hook]]]),
      },
      connection,
      { _channel: 'room:general', _channelScope: 'rooms' },
    );

    expect(hook).toHaveBeenCalledTimes(1);
    // _subscribeOk had already been sent before the side-effect hook ran.
    expect(protocol[0]?.event).toBe('_subscribeOk');
    expect(protocolCountDuringHook).toBeGreaterThanOrEqual(1);
  });

  it('routes a throwing onSubscribe through handleRuntimeError instead of escaping', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections, protocol } = createRuntime();
    connections.set(connection.id, connection);

    const seenRuntimeErrors: Array<{ event?: string; routing?: Record<string, unknown> }> = [];

    await expect(
      subscribeConnection(
        {
          ...runtime,
          subscribeHooks: new Map([
            [
              'rooms',
              [
                async () => {
                  throw new Error('side-effect sink down');
                },
              ],
            ],
          ]),
          async handleRuntimeError(_conn, _error, event, routing) {
            seenRuntimeErrors.push({ event, routing });
          },
        },
        connection,
        { _channel: 'room:general', _channelScope: 'rooms' },
      ),
    ).resolves.toBeUndefined();

    // Subscription was committed — the throw is observational, not a gate.
    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
    // The client received _subscribeOk before the throw fired.
    expect(protocol.find((p) => p.event === '_subscribeOk')).toBeDefined();
    // The runtime-error path was invoked with the channel routing markers
    // so the client receives an _error frame addressed to this channel.
    expect(seenRuntimeErrors).toHaveLength(1);
    expect(seenRuntimeErrors[0]!.event).toBe('_subscribe');
    expect(seenRuntimeErrors[0]!.routing).toEqual({
      _channel: 'room:general',
      _channelScope: 'rooms',
    });
  });

  it('leaveChannel runs membership removal, persistAttachment, and _memberLeave broadcast even when an onUnsubscribe hook throws, then re-throws', async () => {
    // Pre-fix a throwing onUnsubscribe rejected leaveChannel before the
    // tail ran — peers never saw `_memberLeave`, the attachment stayed
    // stale. The hook throw is now contained, the tail runs
    // unconditionally, and the original error is re-thrown so kick
    // callers still observe it.
    const connection = createConnection('conn_1');
    addChannelMembership(connection, 'room:general', 'rooms');

    const { runtime, broadcasts } = createRuntime();
    const persisted: string[] = [];
    const logger = { error: vi.fn() };
    const runtimeWithHook = {
      ...runtime,
      logger,
      persistAttachment(c: ReturnType<typeof createConnection>) {
        persisted.push(c.id);
      },
      unsubscribeHooks: new Map<string, readonly ((ctx: unknown) => Promise<void>)[]>([
        [
          'rooms',
          [
            async () => {
              throw new Error('hook boom');
            },
          ],
        ],
      ]),
    };

    await expect(
      leaveChannel(runtimeWithHook as never, connection, {
        channel: { key: 'rooms' } as never,
        channelName: 'room:general',
        channelScope: 'rooms',
      }),
    ).rejects.toThrow(/hook boom/);

    // Tail ran despite the hook throwing.
    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(false);
    expect(persisted).toEqual(['conn_1']);
    expect(broadcasts).toEqual([
      {
        channelName: 'room:general',
        event: '_memberLeave',
        payload: { connectionId: 'conn_1' },
        excludeConnectionId: 'conn_1',
        channelScope: 'rooms',
      },
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
