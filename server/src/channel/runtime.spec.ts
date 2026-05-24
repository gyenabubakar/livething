import { scope } from '~/channel/channel.ts';
import {
  addChannelMembership,
  createChannelMembershipKey,
  leaveChannel,
  subscribeConnection,
  subscribeConnectionAsServer,
  unsubscribeConnection,
} from '~/channel/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id = 'conn_1', meta: Record<string, unknown> = {}) {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: id,
    },
    meta,
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good' as const,
  };
}

function createRuntime(
  channelMembers: Map<string, Set<RuntimeConnection>> = new Map<string, Set<RuntimeConnection>>(),
) {
  const protocol: {
    connectionId: string;
    event: string;
    payload: Record<string, unknown>;
    wskit: Record<string, unknown>;
  }[] = [];
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
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    intercepts: [],
  };

  const connections = new Map<string, ReturnType<typeof createConnection>>();

  return {
    protocol,
    broadcasts,
    connections,
    channelMembers,
    runtime: {
      compiled: {
        channels: new Map(),
        channelFamilies: new Map([['rooms', rooms]]),
      },
      connections,
      channelMembers,
      checkHooks: new Map(),
      commitHooks: new Map(),
      subscribeHooks: new Map(),
      unsubscribeHooks: new Map(),
      sessionEndHooks: new Map(),
      toConnectionInfo(connection: ReturnType<typeof createConnection>) {
        return {
          id: connection.id,
          identity: connection.identity,
          meta: connection.meta,
          tags: [],
          channels: [...connection.channelMemberships.values()].map((m) => m.channelName),
          latency: connection.latency,
          quality: connection.quality,
          bufferedAmount: 0,
          ref: () => ({
            __wskit: 'connection-ref' as const,
            id: connection.id,
            instance: undefined,
            identity: connection.identity,
          }),
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
        wskit: Record<string, unknown>,
      ) {
        protocol.push({ connectionId: connection.id, event, payload, wskit });
      },
      wskitStampHooks: [],
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
      isChannelPersistent: () => false,
      persistMembership: () => {},
      deleteDurableMembership: () => {},
      hasDurableMembership: () => true,
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
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const first = createConnection('conn_1', { userId: 'a' });
    addChannelMembership(channelMembers, first, 'room:general', 'rooms');

    const second = createConnection('conn_2', { userId: 'b' });
    const { runtime, connections, protocol, broadcasts } = createRuntime(channelMembers);
    connections.set(first.id, first);
    connections.set(second.id, second);

    await subscribeConnection(runtime, second, 'room:general', 'rooms', undefined);

    expect(
      [...second.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
    // Subscribing must not auto-tag the connection. Tags are scope-blind by
    // design (a tag is just a string in a Set), so an auto `channel:<name>`
    // tag would collapse static-vs-family and family-vs-family distinctions.
    // subscribe must not auto-tag
    expect(protocol).toEqual([
      {
        connectionId: 'conn_2',
        event: '__subscribeOk__',
        payload: { source: 'client' },
        wskit: { channel: 'room:general', channelScope: 'rooms' },
      },
      {
        connectionId: 'conn_2',
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'conn_1', meta: { userId: 'a' } }] },
        wskit: { channel: 'room:general', channelScope: 'rooms' },
      },
    ]);
    expect(broadcasts).toEqual([
      {
        channelName: 'room:general',
        event: '__memberJoin__',
        payload: {
          connectionId: 'conn_2',
          meta: { userId: 'b' },
        },
        excludeConnectionId: 'conn_2',
        channelScope: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOnline__',
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
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1', { userId: 'a' });
    addChannelMembership(channelMembers, connection, 'room:general', 'rooms');

    const { runtime, connections, broadcasts } = createRuntime(channelMembers);
    connections.set(connection.id, connection);

    await unsubscribeConnection(
      {
        ...runtime,
        leaveChannel: async (nextConnection, scope, kickedReason) =>
          leaveChannel(runtime, nextConnection, scope, kickedReason),
      },
      connection,
      'room:general',
      'rooms',
    );

    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(false);
    // unsubscribe must not touch tags
    expect(broadcasts).toEqual([
      {
        channelName: 'room:general',
        event: '__memberLeave__',
        payload: { connectionId: 'conn_1', meta: { userId: 'a' } },
        excludeConnectionId: 'conn_1',
        channelScope: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOffline__',
        payload: { connectionId: 'conn_1' },
        excludeConnectionId: 'conn_1',
        channelScope: 'rooms',
      },
    ]);
  });

  it('keeps same-name memberships isolated across channel families', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1');

    addChannelMembership(channelMembers, connection, 'room:general', 'rooms');
    addChannelMembership(channelMembers, connection, 'room:general', 'lobbies');

    const { runtime, connections, broadcasts } = createRuntime(channelMembers);
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
      'room:general',
      'rooms',
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
        event: '__memberLeave__',
        payload: { connectionId: 'conn_1', meta: {} },
        excludeConnectionId: 'conn_1',
        channelScope: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOffline__',
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
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const roomsMember = createConnection('rooms-member', { userId: 'a' });
    const lobbiesMember = createConnection('lobbies-member', { userId: 'b' });
    addChannelMembership(channelMembers, roomsMember, 'room:general', 'rooms');
    addChannelMembership(channelMembers, lobbiesMember, 'room:general', 'lobbies');

    const newSubscriber = createConnection('new-sub');
    const { runtime, connections, protocol } = createRuntime(channelMembers);
    runtime.compiled.channelFamilies.set('lobbies', {
      ...runtime.compiled.channelFamilies.get('rooms')!,
      key: 'lobbies',
      pattern: scope('lobbies', /^room:/),
    });
    connections.set(roomsMember.id, roomsMember);
    connections.set(lobbiesMember.id, lobbiesMember);
    connections.set(newSubscriber.id, newSubscriber);

    await subscribeConnection(runtime, newSubscriber, 'room:general', 'rooms', undefined);

    // __memberSync__ to the new subscriber must include only the 'rooms'
    // scope member, not the 'lobbies' scope member.
    const sync = protocol.find((m) => m.connectionId === 'new-sub' && m.event === '__memberSync__');
    const members = (sync?.payload.members ?? []) as { connectionId: string }[];
    expect(members.map((m) => m.connectionId)).toEqual(['rooms-member']);
  });

  it('check with an async validator throws WskitConfigError without routing through handleValidationError', async () => {
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
          checkHooks: new Map([['rooms', [{ handler: hook, validator: v.objectAsync({}) }]]]),
        },
        connection,
        'room:general',
        'rooms',
        undefined,
      ),
    ).rejects.toThrow(/async validators are not supported/);

    expect(handleValidationError).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it('check fires before addChannelMembership (ordering guarantee)', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    let wasMemberDuringCheck = true;
    const hook = vi.fn(async () => {
      wasMemberDuringCheck = [...connection.channelMemberships.values()].some(
        (m) => m.channelName === 'room:general',
      );
    });

    await subscribeConnection(
      {
        ...runtime,
        checkHooks: new Map([['rooms', [{ handler: hook, validator: undefined }]]]),
      },
      connection,
      'room:general',
      'rooms',
      undefined,
    );

    expect(hook).toHaveBeenCalledTimes(1);
    // The connection must NOT be a member yet when check runs.
    expect(wasMemberDuringCheck).toBe(false);
    // After subscribe completes the connection IS a member.
    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
  });

  it('commit throwing rejects the subscribe and does not write membership', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    const err = new Error('capacity full');
    await expect(
      subscribeConnection(
        {
          ...runtime,
          commitHooks: new Map([
            [
              'rooms',
              [
                {
                  handler: () => {
                    throw err;
                  },
                },
              ],
            ],
          ]),
        },
        connection,
        'room:general',
        'rooms',
        undefined,
      ),
    ).rejects.toThrow('capacity full');

    expect([...connection.channelMemberships.values()]).toHaveLength(0);
  });

  it('async commit handler is detected at runtime and throws', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    await expect(
      subscribeConnection(
        {
          ...runtime,
          commitHooks: new Map([
            [
              'rooms',
              [{ handler: (async () => {}) as unknown as (ctx: unknown, r: unknown) => void }],
            ],
          ]),
        },
        connection,
        'room:general',
        'rooms',
        undefined,
      ),
    ).rejects.toThrow(/commit\(\) must be synchronous/);
  });

  it('check result flows as typed second arg to commit', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    const checkResult = { userId: 'abc' };
    let receivedInCommit: unknown;

    await subscribeConnection(
      {
        ...runtime,
        checkHooks: new Map([
          ['rooms', [{ handler: async () => checkResult, validator: undefined }]],
        ]),
        commitHooks: new Map([
          [
            'rooms',
            [
              {
                handler: (_ctx, r) => {
                  receivedInCommit = r;
                },
              },
            ],
          ],
        ]),
      },
      connection,
      'room:general',
      'rooms',
      undefined,
    );

    expect(receivedInCommit).toBe(checkResult);
  });

  it('two concurrent subscribes with check each see the other in the initial sync', async () => {
    const connA = createConnection('conn_A', { who: 'a' });
    const connB = createConnection('conn_B', { who: 'b' });
    const { runtime, connections, protocol, broadcasts } = createRuntime();
    connections.set(connA.id, connA);
    connections.set(connB.id, connB);

    // A resolves first so B's member snapshot includes A.
    let resolveA!: () => void;
    let resolveB!: () => void;
    const aReady = new Promise<void>((r) => (resolveA = r));
    const bReady = new Promise<void>((r) => (resolveB = r));

    const hook = vi.fn(async (ctx: { id: string }) => {
      if (ctx.id === 'conn_A') await aReady;
      else await bReady;
    });

    const runtimeWithHook = {
      ...runtime,
      checkHooks: new Map([['rooms', [{ handler: hook, validator: undefined }]]]),
    };

    const subA = subscribeConnection(runtimeWithHook, connA, 'room:general', 'rooms', undefined);
    const subB = subscribeConnection(runtimeWithHook, connB, 'room:general', 'rooms', undefined);

    // Release A first so it commits, then B so it commits and snapshots A.
    resolveA();
    await subA;
    resolveB();
    await subB;

    // Initial sync to A: empty (A committed first, no peers yet).
    const aSync = protocol.find((m) => m.connectionId === 'conn_A' && m.event === '__memberSync__');
    const aSyncIds = ((aSync?.payload.members ?? []) as { connectionId: string }[]).map(
      (m) => m.connectionId,
    );
    expect(aSyncIds).toEqual([]);

    // Initial sync to B: includes A (committed before B snapshotted).
    const bSync = protocol.find((m) => m.connectionId === 'conn_B' && m.event === '__memberSync__');
    const bSyncIds = ((bSync?.payload.members ?? []) as { connectionId: string }[]).map(
      (m) => m.connectionId,
    );
    expect(bSyncIds).toEqual(['conn_A']);

    // Broadcasts: A broadcast __memberJoin__{A} (no recipients yet),
    // B broadcast __memberJoin__{B} (A receives via the broadcast path).
    const broadcastJoiners = broadcasts
      .filter((b) => b.event === '__memberJoin__')
      .map((b) => (b.payload as { connectionId: string }).connectionId);
    expect(broadcastJoiners).toEqual(['conn_A', 'conn_B']);

    // Self-filter: neither connection's own id appears in its initial sync.
    expect(aSyncIds).not.toContain('conn_A');
    expect(bSyncIds).not.toContain('conn_B');
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
      'room:general',
      'rooms',
      undefined,
    );

    expect(hook).toHaveBeenCalledTimes(1);
    // __subscribeOk__ had already been sent before the side-effect hook ran.
    expect(protocol[0]?.event).toBe('__subscribeOk__');
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
        'room:general',
        'rooms',
        undefined,
      ),
    ).resolves.toBeUndefined();

    // Subscription was committed — the throw is observational, not a gate.
    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
    // The client received __subscribeOk__ before the throw fired.
    expect(protocol.find((p) => p.event === '__subscribeOk__')).toBeDefined();
    // The runtime-error path was invoked with the channel routing markers
    // so the client receives an __error__ frame addressed to this channel.
    expect(seenRuntimeErrors).toHaveLength(1);
    expect(seenRuntimeErrors[0]!.event).toBe('__subscribe__');
    expect(seenRuntimeErrors[0]!.routing).toEqual({
      channel: 'room:general',
      channelScope: 'rooms',
    });
  });

  it('leaveChannel runs membership removal, persistAttachment, and _memberLeave broadcast even when an onUnsubscribe hook throws, then re-throws', async () => {
    // Pre-fix a throwing onUnsubscribe rejected leaveChannel before the
    // tail ran — peers never saw `_memberLeave`, the attachment stayed
    // stale. The hook throw is now contained, the tail runs
    // unconditionally, and the original error is re-thrown so kick
    // callers still observe it.
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1');
    addChannelMembership(channelMembers, connection, 'room:general', 'rooms');

    const { runtime, broadcasts } = createRuntime(channelMembers);
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
        event: '__memberLeave__',
        payload: { connectionId: 'conn_1', meta: {} },
        excludeConnectionId: 'conn_1',
        channelScope: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOffline__',
        payload: { connectionId: 'conn_1' },
        excludeConnectionId: 'conn_1',
        channelScope: 'rooms',
      },
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('subscribeConnectionAsServer', () => {
  it('runs the gate, commits, and sends _subscribeOk with source server', async () => {
    const { protocol, broadcasts, connections, runtime } = createRuntime();
    const target = createConnection('target', { userId: 't' });
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, 'room:general', 'rooms', {
      invitedBy: 'mod-1',
    });

    expect(target.channelMemberships.has(createChannelMembershipKey('room:general', 'rooms'))).toBe(
      true,
    );
    expect(protocol).toEqual([
      {
        connectionId: 'target',
        event: '__subscribeOk__',
        payload: { source: 'server' },
        wskit: { channel: 'room:general', channelScope: 'rooms' },
      },
      {
        connectionId: 'target',
        event: '__memberSync__',
        payload: { members: [] },
        wskit: { channel: 'room:general', channelScope: 'rooms' },
      },
    ]);
    expect(broadcasts).toEqual([
      {
        channelName: 'room:general',
        event: '__memberJoin__',
        payload: { connectionId: 'target', meta: { userId: 't' } },
        excludeConnectionId: 'target',
        channelScope: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOnline__',
        payload: { connectionId: 'target', meta: { userId: 't' } },
        excludeConnectionId: 'target',
        channelScope: 'rooms',
      },
    ]);
  });

  it('rejoin skips a channel whose durable membership was dropped while it waited', async () => {
    const { protocol, connections, runtime } = createRuntime();
    const target = createConnection('target', { userId: 't' });
    connections.set(target.id, target);

    // Persistent channel, but the saved membership is already gone — rejoin must not resurrect it.
    const rejoinRuntime = {
      ...runtime,
      isChannelPersistent: () => true,
      hasDurableMembership: () => false,
    };

    await subscribeConnectionAsServer(
      rejoinRuntime,
      target,
      'room:general',
      'rooms',
      undefined,
      true,
    );

    expect(target.channelMemberships.has(createChannelMembershipKey('room:general', 'rooms'))).toBe(
      false,
    );
    expect(protocol).toEqual([]);
  });

  it('runs check with the supplied payload', async () => {
    const { connections, runtime } = createRuntime();
    const seen: unknown[] = [];
    runtime.checkHooks = new Map([
      [
        'rooms',
        [
          {
            handler: async (_ctx: unknown, data: unknown) => {
              seen.push(data);
            },
          },
        ],
      ],
    ]);
    const target = createConnection('target', {});
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, 'room:general', 'rooms', { gate: 'pass' });

    expect(seen).toEqual([{ gate: 'pass' }]);
    expect(target.channelMemberships.has(createChannelMembershipKey('room:general', 'rooms'))).toBe(
      true,
    );
  });

  it('rejects when check throws — connection stays out of the channel', async () => {
    const { connections, runtime } = createRuntime();
    runtime.checkHooks = new Map([
      [
        'rooms',
        [
          {
            handler: async () => {
              throw new Error('gate refused');
            },
          },
        ],
      ],
    ]);
    const target = createConnection('target', {});
    connections.set(target.id, target);

    await expect(
      subscribeConnectionAsServer(runtime, target, 'room:general', 'rooms', undefined),
    ).rejects.toThrow(/gate refused/);

    expect(target.channelMemberships.size).toBe(0);
  });

  it('no-ops when the connection is already a member', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const { protocol, broadcasts, connections, runtime } = createRuntime(channelMembers);
    const target = createConnection('target', {});
    addChannelMembership(channelMembers, target, 'room:general', 'rooms');
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, 'room:general', 'rooms', undefined);

    expect(protocol).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('throws ChannelNotFound for an unknown channel scope', async () => {
    const { connections, runtime } = createRuntime();
    const target = createConnection('target', {});
    connections.set(target.id, target);

    await expect(
      subscribeConnectionAsServer(runtime, target, 'mystery', 'no-such-family', undefined),
    ).rejects.toThrow();
  });

  it('works for a static channel (channelScope null)', async () => {
    const { protocol, connections, runtime } = createRuntime();
    // Register a static channel — the runtime fixture only carries a family
    // by default. Static and family channels resolve through different
    // branches of resolveCompiledChannel, so both deserve a test.
    runtime.compiled.channels.set('lobby', {
      key: 'lobby',
      kind: 'channel' as const,
      pattern: 'lobby',
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      intercepts: [],
    } as never);
    const target = createConnection('target', {});
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, 'lobby', null, undefined);

    expect(target.channelMemberships.has(createChannelMembershipKey('lobby', null))).toBe(true);
    expect(protocol).toEqual([
      {
        connectionId: 'target',
        event: '__subscribeOk__',
        payload: { source: 'server' },
        wskit: { channel: 'lobby' },
      },
      {
        connectionId: 'target',
        event: '__memberSync__',
        payload: { members: [] },
        wskit: { channel: 'lobby' },
      },
    ]);
  });

  it('works on a channel with no check/commit hooks', async () => {
    // Both hooks are optional. A channel without them should
    // accept the subscribe without complaint and commit the membership.
    const { protocol, connections, runtime } = createRuntime();
    const target = createConnection('target', {});
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, 'room:general', 'rooms', undefined);

    expect(target.channelMemberships.has(createChannelMembershipKey('room:general', 'rooms'))).toBe(
      true,
    );
    expect(protocol.some((p) => p.event === '__subscribeOk__')).toBe(true);
  });

  it('sends a member sync to the new subscriber for existing members', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const { protocol, connections, runtime } = createRuntime(channelMembers);
    // Seed two existing members of room:general so the new subscriber
    // receives them in one __memberSync__ frame.
    const existingA = createConnection('existing-a', { who: 'a' });
    const existingB = createConnection('existing-b', { who: 'b' });
    addChannelMembership(channelMembers, existingA, 'room:general', 'rooms');
    addChannelMembership(channelMembers, existingB, 'room:general', 'rooms');
    connections.set(existingA.id, existingA);
    connections.set(existingB.id, existingB);

    const target = createConnection('target', {});
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, 'room:general', 'rooms', undefined);

    const sync = protocol.find((p) => p.connectionId === 'target' && p.event === '__memberSync__');
    const members = (sync?.payload.members ?? []) as { connectionId: string }[];
    expect(members.map((m) => m.connectionId).sort()).toEqual(['existing-a', 'existing-b']);
  });

  it('runs onSubscribe after the subscribe is committed and the wire events have been sent', async () => {
    const { protocol, connections, runtime } = createRuntime();
    const order: string[] = [];
    runtime.subscribeHooks = new Map([
      [
        'rooms',
        [
          async () => {
            order.push('onSubscribe');
          },
        ],
      ],
    ]);
    const originalSend = runtime.sendProtocolMessage;
    runtime.sendProtocolMessage = (conn, event, payload, wskit) => {
      order.push(`wire:${event}`);
      originalSend(conn, event, payload, wskit);
    };

    const target = createConnection('target', {});
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, 'room:general', 'rooms', undefined);

    // onSubscribe must run AFTER the __subscribeOk__ frame is on the wire.
    expect(order[0]).toBe('wire:__subscribeOk__');
    expect(order[order.length - 1]).toBe('onSubscribe');
    expect(
      protocol.some((p) => p.event === '__subscribeOk__' && p.payload.source === 'server'),
    ).toBe(true);
  });
});
