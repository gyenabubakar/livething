import { RejoinRejected, WSKitConfigError } from '@wskit/core';
import { scope } from '~/channel/channel.ts';
import {
  addChannelMembership,
  createChannelMembershipKey,
  leaveChannel,
  matchScopeParams,
  resyncChannelMembers,
  subscribeConnection,
  subscribeConnectionAsServer,
  unsubscribeConnection,
} from '~/channel/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { BroadcastToChannelOptions, LeaveChannelOptions } from '~/channel/runtime.ts';
import type { SendRuntimeErrorOptions } from '~/errors/runtime.ts';

function createConnection(id = 'conn_1', meta: Record<string, unknown> = {}) {
  return {
    id,
    userId: id,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
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
    channelFamily?: string;
  }[] = [];

  const rooms = {
    key: 'rooms' as string,
    kind: 'channel' as const,
    pattern: scope('rooms', 'room:{id}') as ReturnType<typeof scope>,
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
      revalidateHooks: new Map(),
      commitHooks: new Map(),
      subscribeHooks: new Map(),
      unsubscribeHooks: new Map(),
      sessionEndHooks: new Map(),
      toConnectionInfo(connection: ReturnType<typeof createConnection>) {
        return {
          id: connection.id,
          userId: connection.userId,
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
            userId: connection.userId,
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
        { event, payload, wskit }: SendProtocolMessageOptions,
      ) {
        protocol.push({ connectionId: connection.id, event, payload, wskit });
      },
      wskitStampHooks: [],
      broadcastToChannel({
        channelName,
        event,
        payload,
        excludeConnectionId,
        channelFamily,
      }: BroadcastToChannelOptions) {
        broadcasts.push({
          channelName,
          event,
          payload,
          excludeConnectionId,
          channelFamily: channelFamily ?? undefined,
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
  it('produces distinct keys for previously colliding (family, name) pairs', () => {
    // Family 'rooms' + name 'private::lobby' would have collided with family
    // 'rooms::private' + name 'lobby' under the old `${scope}::${name}` join.
    const a = createChannelMembershipKey('private::lobby', 'rooms');
    const b = createChannelMembershipKey('lobby', 'rooms::private');
    expect(a).not.toBe(b);
  });
});

describe('channel runtime', () => {
  it('subscribes a connection and sends member sync events', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const first = createConnection('conn_1', { userId: 'a' });
    addChannelMembership(channelMembers, first, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });

    const second = createConnection('conn_2', { userId: 'b' });
    const { runtime, connections, protocol, broadcasts } = createRuntime(channelMembers);
    connections.set(first.id, first);
    connections.set(second.id, second);

    await subscribeConnection(runtime, second, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });

    expect(
      [...second.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
    // Subscribing must not auto-tag the connection. Tags are scope-blind by
    // design (a tag is just a string in a Set), so an auto `channel:<name>`
    // tag would collapse static-vs-family and family-vs-family distinctions.
    expect(protocol).toEqual([
      {
        connectionId: 'conn_2',
        event: '__subscribeOk__',
        payload: {},
        wskit: {
          channel: 'room:general',
          channelFamily: 'rooms',
          source: 'client',
          channelPersistent: false,
        },
      },
      {
        connectionId: 'conn_2',
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'conn_1', meta: { userId: 'a' } }] },
        wskit: { channel: 'room:general', channelFamily: 'rooms', source: 'client' },
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
        channelFamily: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOnline__',
        payload: {
          connectionId: 'conn_2',
          meta: { userId: 'b' },
        },
        excludeConnectionId: 'conn_2',
        channelFamily: 'rooms',
      },
    ]);
  });

  it('unsubscribes a connection and broadcasts member leave', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1', { userId: 'a' });
    addChannelMembership(channelMembers, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });

    const { runtime, connections, broadcasts } = createRuntime(channelMembers);
    connections.set(connection.id, connection);

    await unsubscribeConnection(
      {
        ...runtime,
        leaveChannel: async (nextConnection: RuntimeConnection, opts: LeaveChannelOptions) =>
          leaveChannel(runtime, nextConnection, opts),
      },
      connection,
      { channelName: 'room:general', channelFamily: 'rooms' },
    );

    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(false);
    expect(broadcasts).toEqual([
      {
        channelName: 'room:general',
        event: '__memberLeave__',
        payload: { connectionId: 'conn_1', meta: { userId: 'a' } },
        excludeConnectionId: 'conn_1',
        channelFamily: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOffline__',
        payload: { connectionId: 'conn_1' },
        excludeConnectionId: 'conn_1',
        channelFamily: 'rooms',
      },
    ]);
  });

  it('confirms a member leave with __unsubscribeOk__ echoing the unsubscribeId', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1', { userId: 'a' });
    addChannelMembership(channelMembers, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });

    const { runtime, connections, protocol } = createRuntime(channelMembers);
    connections.set(connection.id, connection);

    await unsubscribeConnection(
      {
        ...runtime,
        leaveChannel: async (nextConnection: RuntimeConnection, opts: LeaveChannelOptions) =>
          leaveChannel(runtime, nextConnection, opts),
      },
      connection,
      { channelName: 'room:general', channelFamily: 'rooms', unsubscribeId: 'unsub-1' },
    );

    expect(protocol).toContainEqual({
      connectionId: 'conn_1',
      event: '__unsubscribeOk__',
      payload: {},
      wskit: { channel: 'room:general', channelFamily: 'rooms', unsubscribeId: 'unsub-1' },
    });
  });

  it('idempotently re-acks a leave for a channel it is no longer in, with no hooks or broadcasts', async () => {
    // A resent leave after the first ack was lost: the connection is no longer a
    // member, so the engine just re-confirms — no membership change, no broadcast.
    const connection = createConnection('conn_1', { userId: 'a' });
    const { runtime, connections, protocol, broadcasts } = createRuntime();
    connections.set(connection.id, connection);

    await unsubscribeConnection(
      {
        ...runtime,
        leaveChannel: async (nextConnection: RuntimeConnection, opts: LeaveChannelOptions) =>
          leaveChannel(runtime, nextConnection, opts),
      },
      connection,
      { channelName: 'room:general', channelFamily: 'rooms', unsubscribeId: 'unsub-1' },
    );

    expect(broadcasts).toEqual([]);
    expect(protocol).toEqual([
      {
        connectionId: 'conn_1',
        event: '__unsubscribeOk__',
        payload: {},
        wskit: { channel: 'room:general', channelFamily: 'rooms', unsubscribeId: 'unsub-1' },
      },
    ]);
  });

  it('confirms a leave whose onUnsubscribe hook throws, then rethrows the hook error', async () => {
    // leaveChannel removes membership before running hooks, so a throwing hook still
    // means the leave completed — the client must still get __unsubscribeOk__ (or its
    // unsubscribe() would hang), and the hook error is still surfaced to the caller.
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1', { userId: 'a' });
    addChannelMembership(channelMembers, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });

    const { runtime, connections, protocol } = createRuntime(channelMembers);
    connections.set(connection.id, connection);
    const boom = new Error('onUnsubscribe boom');
    runtime.unsubscribeHooks = new Map([
      [
        'rooms',
        [
          async () => {
            throw boom;
          },
        ],
      ],
    ]);

    await expect(
      unsubscribeConnection(
        {
          ...runtime,
          leaveChannel: async (nextConnection: RuntimeConnection, opts: LeaveChannelOptions) =>
            leaveChannel(runtime, nextConnection, opts),
        },
        connection,
        { channelName: 'room:general', channelFamily: 'rooms', unsubscribeId: 'unsub-1' },
      ),
    ).rejects.toBe(boom);

    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(false);
    expect(protocol).toContainEqual({
      connectionId: 'conn_1',
      event: '__unsubscribeOk__',
      payload: {},
      wskit: { channel: 'room:general', channelFamily: 'rooms', unsubscribeId: 'unsub-1' },
    });
  });

  it('keeps the legacy channel-not-subscribed error for a no-id leave of a non-member', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    await expect(
      unsubscribeConnection(
        {
          ...runtime,
          leaveChannel: async (nextConnection: RuntimeConnection, opts: LeaveChannelOptions) =>
            leaveChannel(runtime, nextConnection, opts),
        },
        connection,
        { channelName: 'room:general', channelFamily: 'rooms' },
      ),
    ).rejects.toMatchObject({ code: 'channel-not-subscribed' });
  });

  it('sends no confirmation when the leave frame carried no unsubscribeId', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1', { userId: 'a' });
    addChannelMembership(channelMembers, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });

    const { runtime, connections, protocol } = createRuntime(channelMembers);
    connections.set(connection.id, connection);

    await unsubscribeConnection(
      {
        ...runtime,
        leaveChannel: async (nextConnection: RuntimeConnection, opts: LeaveChannelOptions) =>
          leaveChannel(runtime, nextConnection, opts),
      },
      connection,
      { channelName: 'room:general', channelFamily: 'rooms' },
    );

    expect(protocol.some((p) => p.event === '__unsubscribeOk__')).toBe(false);
  });

  it('keeps same-name memberships isolated across channel families', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1');

    addChannelMembership(channelMembers, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });
    addChannelMembership(channelMembers, connection, {
      channelName: 'room:general',
      channelFamily: 'lobbies',
    });

    const { runtime, connections, broadcasts } = createRuntime(channelMembers);
    runtime.compiled.channelFamilies.set('lobbies', {
      ...runtime.compiled.channelFamilies.get('rooms')!,
      key: 'lobbies',
      pattern: scope('lobbies', 'room:{id}'),
    });
    connections.set(connection.id, connection);

    await unsubscribeConnection(
      {
        ...runtime,
        leaveChannel: async (nextConnection: RuntimeConnection, opts: LeaveChannelOptions) =>
          leaveChannel(runtime, nextConnection, opts),
      },
      connection,
      { channelName: 'room:general', channelFamily: 'rooms' },
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
        channelFamily: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOffline__',
        payload: { connectionId: 'conn_1' },
        excludeConnectionId: 'conn_1',
        channelFamily: 'rooms',
      },
    ]);
  });

  it('subscribeConnection only syncs members from the same family (cross-family isolation)', async () => {
    // Two channel families that share the concrete channel name 'room:general'.
    // A connection joining one family should only see the other family's members
    // when subscribing — not connections from a sibling family.
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const roomsMember = createConnection('rooms-member', { userId: 'a' });
    const lobbiesMember = createConnection('lobbies-member', { userId: 'b' });
    addChannelMembership(channelMembers, roomsMember, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });
    addChannelMembership(channelMembers, lobbiesMember, {
      channelName: 'room:general',
      channelFamily: 'lobbies',
    });

    const newSubscriber = createConnection('new-sub');
    const { runtime, connections, protocol } = createRuntime(channelMembers);
    runtime.compiled.channelFamilies.set('lobbies', {
      ...runtime.compiled.channelFamilies.get('rooms')!,
      key: 'lobbies',
      pattern: scope('lobbies', 'room:{id}'),
    });
    connections.set(roomsMember.id, roomsMember);
    connections.set(lobbiesMember.id, lobbiesMember);
    connections.set(newSubscriber.id, newSubscriber);

    await subscribeConnection(runtime, newSubscriber, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });

    // __memberSync__ to the new subscriber must include only the 'rooms'
    // family member, not the 'lobbies' family member.
    const sync = protocol.find((m) => m.connectionId === 'new-sub' && m.event === '__memberSync__');
    const members = (sync?.payload.members ?? []) as { connectionId: string }[];
    expect(members.map((m) => m.connectionId)).toEqual(['rooms-member']);
  });

  it('check with an async validator throws WSKitConfigError without routing through handleValidationError', async () => {
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
        { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
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
      { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
    );

    expect(hook).toHaveBeenCalledTimes(1);
    expect(wasMemberDuringCheck).toBe(false);
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
        { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
      ),
    ).rejects.toThrow('capacity full');

    expect([...connection.channelMemberships.values()]).toHaveLength(0);
  });

  it('persistMembership throwing rejects the subscribe and adds no live membership', async () => {
    // The durable membership write runs before the live commit, so a storage
    // failure must leave the connection out of the channel entirely — not live
    // in a channel with nothing saved.
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    await expect(
      subscribeConnection(
        {
          ...runtime,
          isChannelPersistent: () => true,
          persistMembership: () => {
            throw new Error('storage down');
          },
        },
        connection,
        { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
      ),
    ).rejects.toThrow('storage down');

    expect([...connection.channelMemberships.values()]).toHaveLength(0);
  });

  it('native-Promise commit throws a synchronous-commit WSKitConfigError before membership is written', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    const rejection = subscribeConnection(
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
      { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
    );

    await expect(rejection).rejects.toBeInstanceOf(WSKitConfigError);
    await expect(rejection).rejects.toThrow(/commit\(\) must be synchronous/);
    expect([...connection.channelMemberships.values()]).toHaveLength(0);
  });

  it('cross-realm Promise commit throws WSKitConfigError before membership is written', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    // A Promise from a different realm is not `instanceof Promise` here, so the
    // guard must rely on the thenable shape, not the constructor identity.
    const realm = await import('node:vm');
    const foreignPromise = realm.runInNewContext('Promise.resolve(1)');

    await expect(
      subscribeConnection(
        {
          ...runtime,
          commitHooks: new Map([
            ['rooms', [{ handler: (() => foreignPromise) as (ctx: unknown, r: unknown) => void }]],
          ]),
        },
        connection,
        { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
      ),
    ).rejects.toBeInstanceOf(WSKitConfigError);

    expect([...connection.channelMemberships.values()]).toHaveLength(0);
  });

  it('custom thenable commit throws WSKitConfigError before membership is written', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    await expect(
      subscribeConnection(
        {
          ...runtime,
          commitHooks: new Map([
            ['rooms', [{ handler: (() => ({ then() {} })) as (ctx: unknown, r: unknown) => void }]],
          ]),
        },
        connection,
        { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
      ),
    ).rejects.toBeInstanceOf(WSKitConfigError);

    expect([...connection.channelMemberships.values()]).toHaveLength(0);
  });

  it('synchronous commit succeeds and membership is written', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    await subscribeConnection(
      {
        ...runtime,
        commitHooks: new Map([['rooms', [{ handler: () => undefined }]]]),
      },
      connection,
      { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
    );

    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
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
      { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
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

    const subA = subscribeConnection(runtimeWithHook, connA, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });
    const subB = subscribeConnection(runtimeWithHook, connB, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });

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
      { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
    );

    expect(hook).toHaveBeenCalledTimes(1);
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
          async handleRuntimeError(_conn, { event, routing }: SendRuntimeErrorOptions) {
            seenRuntimeErrors.push({ event, routing });
          },
        },
        connection,
        { channelName: 'room:general', channelFamily: 'rooms', data: undefined },
      ),
    ).resolves.toBeUndefined();

    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
    expect(protocol.find((p) => p.event === '__subscribeOk__')).toBeDefined();
    // The runtime-error path was invoked with the channel routing markers
    // so the client receives an __error__ frame addressed to this channel.
    expect(seenRuntimeErrors).toHaveLength(1);
    expect(seenRuntimeErrors[0]!.event).toBe('__subscribe__');
    expect(seenRuntimeErrors[0]!.routing).toEqual({
      channel: 'room:general',
      channelFamily: 'rooms',
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
    addChannelMembership(channelMembers, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });

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
        channelFamily: 'rooms',
      }),
    ).rejects.toThrow(/hook boom/);

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
        channelFamily: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOffline__',
        payload: { connectionId: 'conn_1' },
        excludeConnectionId: 'conn_1',
        channelFamily: 'rooms',
      },
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('__subscribeOk__ inbox flag', () => {
  function subscribeOkFrame(protocol: { event: string; wskit: Record<string, unknown> }[]) {
    return protocol.find((frame) => frame.event === '__subscribeOk__');
  }

  it('stamps inbox:true on the client-subscribe confirmation for an inbox channel', async () => {
    const { runtime, connections, protocol } = createRuntime();
    const connection = createConnection('conn_1', { userId: 'a' });
    connections.set(connection.id, connection);

    await subscribeConnection({ ...runtime, isInboxChannel: () => true }, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });

    expect(subscribeOkFrame(protocol)?.wskit).toMatchObject({ inbox: true });
  });

  it('stamps inbox:true on the server-rejoin confirmation for an inbox channel', async () => {
    const { runtime, connections, protocol } = createRuntime();
    const target = createConnection('target', { userId: 't' });
    connections.set(target.id, target);

    await subscribeConnectionAsServer({ ...runtime, isInboxChannel: () => true }, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: {},
    });

    expect(subscribeOkFrame(protocol)?.wskit).toMatchObject({ inbox: true });
  });

  it('omits the inbox flag for a non-inbox channel', async () => {
    const { runtime, connections, protocol } = createRuntime();
    const connection = createConnection('conn_1', { userId: 'a' });
    connections.set(connection.id, connection);

    await subscribeConnection({ ...runtime, isInboxChannel: () => false }, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });

    expect(subscribeOkFrame(protocol)?.wskit).not.toHaveProperty('inbox');
  });
});

describe('subscribeConnectionAsServer', () => {
  it('runs the gate, commits, and sends _subscribeOk with source server', async () => {
    const { protocol, broadcasts, connections, runtime } = createRuntime();
    const target = createConnection('target', { userId: 't' });
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: { invitedBy: 'mod-1' },
    });

    expect(target.channelMemberships.has(createChannelMembershipKey('room:general', 'rooms'))).toBe(
      true,
    );
    expect(protocol).toEqual([
      {
        connectionId: 'target',
        event: '__subscribeOk__',
        payload: {},
        wskit: {
          channel: 'room:general',
          channelFamily: 'rooms',
          source: 'server',
          channelPersistent: false,
        },
      },
      {
        connectionId: 'target',
        event: '__memberSync__',
        payload: { members: [] },
        wskit: { channel: 'room:general', channelFamily: 'rooms', source: 'server' },
      },
    ]);
    expect(broadcasts).toEqual([
      {
        channelName: 'room:general',
        event: '__memberJoin__',
        payload: { connectionId: 'target', meta: { userId: 't' } },
        excludeConnectionId: 'target',
        channelFamily: 'rooms',
      },
      {
        channelName: 'room:general',
        event: '__memberOnline__',
        payload: { connectionId: 'target', meta: { userId: 't' } },
        excludeConnectionId: 'target',
        channelFamily: 'rooms',
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

    await subscribeConnectionAsServer(rejoinRuntime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: undefined,
      rejoining: true,
    });

    expect(target.channelMemberships.has(createChannelMembershipKey('room:general', 'rooms'))).toBe(
      false,
    );
    expect(protocol).toEqual([]);
  });

  it('marks the channel persistent on __subscribeOk__ when the channel is persistent', async () => {
    const { protocol, connections, runtime } = createRuntime();
    const target = createConnection('target', { userId: 't' });
    connections.set(target.id, target);

    const persistentRuntime = { ...runtime, isChannelPersistent: () => true };

    await subscribeConnectionAsServer(persistentRuntime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: undefined,
    });

    const ok = protocol.find((p) => p.event === '__subscribeOk__');
    expect(ok?.wskit).toEqual({
      channel: 'room:general',
      channelFamily: 'rooms',
      source: 'server',
      channelPersistent: true,
    });
  });

  it('runs revalidate (not check) on rejoin', async () => {
    const { connections, runtime } = createRuntime();
    const target = createConnection('target', { userId: 't' });
    connections.set(target.id, target);

    const checkHook = vi.fn();
    const revalidateHook = vi.fn();
    const rejoinRuntime = {
      ...runtime,
      isChannelPersistent: () => true,
      hasDurableMembership: () => true,
      checkHooks: new Map([['rooms', [{ handler: checkHook, validator: undefined }]]]),
      revalidateHooks: new Map([['rooms', [revalidateHook]]]),
    };

    await subscribeConnectionAsServer(rejoinRuntime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: undefined,
      rejoining: true,
    });

    expect(revalidateHook).toHaveBeenCalledTimes(1);
    expect(checkHook).not.toHaveBeenCalled();
    expect(target.channelMemberships.has(createChannelMembershipKey('room:general', 'rooms'))).toBe(
      true,
    );
  });

  it('does not run commit or fire onSubscribe on rejoin', async () => {
    const { connections, runtime } = createRuntime();
    const target = createConnection('target', { userId: 't' });
    connections.set(target.id, target);

    const commitHook = vi.fn();
    const onSubscribeHook = vi.fn();
    const rejoinRuntime = {
      ...runtime,
      isChannelPersistent: () => true,
      hasDurableMembership: () => true,
      commitHooks: new Map([['rooms', [{ handler: commitHook }]]]),
      subscribeHooks: new Map([['rooms', [onSubscribeHook]]]),
    };

    await subscribeConnectionAsServer(rejoinRuntime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: undefined,
      rejoining: true,
    });

    expect(commitHook).not.toHaveBeenCalled();
    expect(onSubscribeHook).not.toHaveBeenCalled();
  });

  it('a throwing revalidate rejects rejoin and does not commit membership', async () => {
    const { connections, runtime } = createRuntime();
    const target = createConnection('target', { userId: 't' });
    connections.set(target.id, target);

    const rejoinRuntime = {
      ...runtime,
      isChannelPersistent: () => true,
      hasDurableMembership: () => true,
      revalidateHooks: new Map([
        [
          'rooms',
          [
            () => {
              throw new Error('revoked');
            },
          ],
        ],
      ]),
    };

    let thrown: unknown;
    try {
      await subscribeConnectionAsServer(rejoinRuntime, target, {
        channelName: 'room:general',
        channelFamily: 'rooms',
        payload: undefined,
        rejoining: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(RejoinRejected.matches(thrown)).toBe(true);
    expect((thrown as { detail: { message: string } }).detail.message).toBe('revoked');
    expect(target.channelMemberships.has(createChannelMembershipKey('room:general', 'rooms'))).toBe(
      false,
    );
  });

  it('a revalidate config error propagates as a config error (not a revoke)', async () => {
    const { connections, runtime } = createRuntime();
    const target = createConnection('target', { userId: 't' });
    connections.set(target.id, target);

    const rejoinRuntime = {
      ...runtime,
      isChannelPersistent: () => true,
      hasDurableMembership: () => true,
      revalidateHooks: new Map([
        [
          'rooms',
          [
            () => {
              throw new WSKitConfigError('bad gate config');
            },
          ],
        ],
      ]),
    };

    let thrown: unknown;
    try {
      await subscribeConnectionAsServer(rejoinRuntime, target, {
        channelName: 'room:general',
        channelFamily: 'rooms',
        payload: undefined,
        rejoining: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WSKitConfigError);
    expect(RejoinRejected.matches(thrown)).toBe(false);
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

    await subscribeConnectionAsServer(runtime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: { gate: 'pass' },
    });

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
      subscribeConnectionAsServer(runtime, target, {
        channelName: 'room:general',
        channelFamily: 'rooms',
        payload: undefined,
      }),
    ).rejects.toThrow(/gate refused/);

    expect(target.channelMemberships.size).toBe(0);
  });

  it('no-ops when the connection is already a member', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const { protocol, broadcasts, connections, runtime } = createRuntime(channelMembers);
    const target = createConnection('target', {});
    addChannelMembership(channelMembers, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: undefined,
    });

    expect(protocol).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('throws ChannelNotFound for an unknown channel scope', async () => {
    const { connections, runtime } = createRuntime();
    const target = createConnection('target', {});
    connections.set(target.id, target);

    await expect(
      subscribeConnectionAsServer(runtime, target, {
        channelName: 'mystery',
        channelFamily: 'no-such-family',
        payload: undefined,
      }),
    ).rejects.toThrow();
  });

  it('works for a static channel (channelFamily null)', async () => {
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

    await subscribeConnectionAsServer(runtime, target, {
      channelName: 'lobby',
      channelFamily: null,
      payload: undefined,
    });

    expect(target.channelMemberships.has(createChannelMembershipKey('lobby', null))).toBe(true);
    expect(protocol).toEqual([
      {
        connectionId: 'target',
        event: '__subscribeOk__',
        payload: {},
        wskit: { channel: 'lobby', source: 'server', channelPersistent: false },
      },
      {
        connectionId: 'target',
        event: '__memberSync__',
        payload: { members: [] },
        wskit: { channel: 'lobby', source: 'server' },
      },
    ]);
  });

  it('works on a channel with no check/commit hooks', async () => {
    const { protocol, connections, runtime } = createRuntime();
    const target = createConnection('target', {});
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: undefined,
    });

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
    addChannelMembership(channelMembers, existingA, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });
    addChannelMembership(channelMembers, existingB, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });
    connections.set(existingA.id, existingA);
    connections.set(existingB.id, existingB);

    const target = createConnection('target', {});
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: undefined,
    });

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
    runtime.sendProtocolMessage = (conn, opts: SendProtocolMessageOptions) => {
      order.push(`wire:${opts.event}`);
      originalSend(conn, opts);
    };

    const target = createConnection('target', {});
    connections.set(target.id, target);

    await subscribeConnectionAsServer(runtime, target, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      payload: undefined,
    });

    // onSubscribe must run AFTER the __subscribeOk__ frame is on the wire.
    expect(order[0]).toBe('wire:__subscribeOk__');
    expect(order[order.length - 1]).toBe('onSubscribe');
    expect(
      protocol.some((p) => p.event === '__subscribeOk__' && p.wskit?.source === 'server'),
    ).toBe(true);
  });
});

describe('channel runtime bug tests', () => {
  it('two concurrent client subscribes for same connection+channel fire subscribeOk and memberJoin exactly once each', async () => {
    const connection = createConnection('conn_1', { who: 'me' });
    const { runtime, connections, protocol, broadcasts } = createRuntime();
    connections.set(connection.id, connection);

    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));

    const onSubscribeHook = vi.fn();
    const runtimeWithHook = {
      ...runtime,
      checkHooks: new Map([
        [
          'rooms',
          [
            {
              handler: async () => {
                await gate;
              },
              validator: undefined,
            },
          ],
        ],
      ]),
      subscribeHooks: new Map([['rooms', [onSubscribeHook]]]),
    };

    const subA = subscribeConnection(runtimeWithHook, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });
    const subB = subscribeConnection(runtimeWithHook, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });

    releaseGate();
    await Promise.all([subA, subB]);

    const subscribeOkCount = protocol.filter((p) => p.event === '__subscribeOk__').length;
    const memberJoinCount = broadcasts.filter((b) => b.event === '__memberJoin__').length;
    const memberships = [...connection.channelMemberships.values()].filter(
      (m) => m.channelName === 'room:general',
    );

    expect(subscribeOkCount).toBe(1);
    expect(memberJoinCount).toBe(1);
    expect(onSubscribeHook).toHaveBeenCalledTimes(1);
    expect(memberships).toHaveLength(1);
  });

  it('disconnect leave with undefined channel on a persistent connection does not broadcast __memberLeave__', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1');
    addChannelMembership(channelMembers, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });

    const { runtime, broadcasts } = createRuntime(channelMembers);
    const persistentRuntime = {
      ...runtime,
      // Simulate the channel definition being gone (hot-reload / upgrade).
      // isChannelPersistent is not called when channel is undefined, but we still
      // pass it to indicate intent. The fallback path in leaveChannel uses '' as key.
      isChannelPersistent: (key: string) => key === '' || key === 'rooms',
    };

    await leaveChannel(persistentRuntime as never, connection, {
      channel: undefined,
      channelName: 'room:general',
      channelFamily: 'rooms',
      disconnect: true,
    });

    const memberLeaveCount = broadcasts.filter((b) => b.event === '__memberLeave__').length;
    expect(memberLeaveCount).toBe(0);
  });
});

describe('matchScopeParams', () => {
  it('returns an empty object for a static channel (string pattern)', () => {
    expect(matchScopeParams('lobby', 'lobby')).toEqual({});
  });

  it('captures a single param from a family template', () => {
    const declaration = scope('rooms', 'room:{id}');
    expect(matchScopeParams(declaration, 'room:alpha-42')).toEqual({ id: 'alpha-42' });
  });

  it('captures multiple params separated by literals', () => {
    const declaration = scope('threads', 'org:{org}/thread:{tid}');
    expect(matchScopeParams(declaration, 'org:acme/thread:42')).toEqual({ org: 'acme', tid: '42' });
  });

  it('returns an empty object when the name does not match the family', () => {
    const declaration = scope('rooms', 'room:{id}');
    expect(matchScopeParams(declaration, 'lobby:1')).toEqual({});
  });
});

// The server trusts no client. A duplicate or hostile subscribe/unsubscribe
// frame must never push the server into wrong state or duplicate side effects.
describe('server self-defense against untrusted client frames', () => {
  it('a sequential second subscribe for an existing member is a no-op', async () => {
    const connection = createConnection('conn_1', { who: 'me' });
    const { runtime, connections, protocol, broadcasts } = createRuntime();
    connections.set(connection.id, connection);

    const onSubscribeHook = vi.fn();
    const runtimeWithHook = {
      ...runtime,
      subscribeHooks: new Map([['rooms', [onSubscribeHook]]]),
    };

    await subscribeConnection(runtimeWithHook, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });

    // A SECOND subscribe for the same channel from the same connection must be
    // ignored server-side: no extra __subscribeOk__, no extra __memberJoin__,
    // no extra onSubscribe — exactly like subscribeConnectionAsServer already does.
    await subscribeConnection(runtimeWithHook, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: undefined,
    });

    const subscribeOkCount = protocol.filter((p) => p.event === '__subscribeOk__').length;
    const memberJoinCount = broadcasts.filter((b) => b.event === '__memberJoin__').length;

    expect(subscribeOkCount).toBe(1);
    expect(memberJoinCount).toBe(1);
    expect(onSubscribeHook).toHaveBeenCalledTimes(1);
  });

  it('a duplicate __subscribe__ does not re-run the check gate (bug #17)', async () => {
    const connection = createConnection('conn_1', { who: 'me' });
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    const checkHandler = vi.fn(() => undefined);
    const validatorRan = vi.fn();
    const validator = v.pipe(
      v.unknown(),
      v.check((data) => {
        validatorRan(data);
        return true;
      }),
    );
    const runtimeWithCheck = {
      ...runtime,
      checkHooks: new Map([['rooms', [{ handler: checkHandler, validator }]]]),
    };

    await subscribeConnection(runtimeWithCheck, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: { token: 't' },
    });
    await subscribeConnection(runtimeWithCheck, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: { token: 't' },
    });

    expect(checkHandler).toHaveBeenCalledTimes(1);
    expect(validatorRan).toHaveBeenCalledTimes(1);
  });
});

describe('resyncChannelMembers (client __memberSync__ request, bug #16)', () => {
  it('re-sends the member snapshot with source: server to a member', async () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const first = createConnection('conn_1', { userId: 'a' });
    const second = createConnection('conn_2', { userId: 'b' });
    addChannelMembership(channelMembers, first, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });
    addChannelMembership(channelMembers, second, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });
    const { runtime, connections, protocol } = createRuntime(channelMembers);
    connections.set(first.id, first);
    connections.set(second.id, second);

    resyncChannelMembers(runtime, second, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });

    expect(protocol).toEqual([
      {
        connectionId: 'conn_2',
        event: '__memberSync__',
        payload: { members: [{ connectionId: 'conn_1', meta: { userId: 'a' } }] },
        wskit: { channel: 'room:general', channelFamily: 'rooms', source: 'server' },
      },
    ]);
  });

  it('is a silent no-op when the requester is not a member', () => {
    const stranger = createConnection('conn_x');
    const { runtime, connections, protocol } = createRuntime();
    connections.set(stranger.id, stranger);

    resyncChannelMembers(runtime, stranger, {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });

    expect(protocol).toEqual([]);
  });

  it('is a silent no-op for an unknown channel', () => {
    const connection = createConnection('conn_1');
    const { runtime, connections, protocol } = createRuntime();
    connections.set(connection.id, connection);

    resyncChannelMembers(runtime, connection, {
      channelName: 'missing',
      channelFamily: null,
    });

    expect(protocol).toEqual([]);
  });
});

describe('subscribe schema validation without a check handler (bug #5)', () => {
  it('validates the subscribe payload even when the channel has no check handler', async () => {
    const connection = createConnection('conn_1');
    const { runtime, connections } = createRuntime();
    connections.set(connection.id, connection);

    const handleValidationError = vi.fn(async () => {});
    const runtimeWithValidator = {
      ...runtime,
      handleValidationError,
      checkHooks: new Map([
        [
          'rooms',
          [
            {
              handler: () => undefined,
              validator: v.object({ token: v.string() }),
            },
          ],
        ],
      ]),
    };

    await expect(
      subscribeConnection(runtimeWithValidator, connection, {
        channelName: 'room:general',
        channelFamily: 'rooms',
        data: { token: 123 },
      }),
    ).rejects.toBeDefined();
    expect(handleValidationError).toHaveBeenCalledOnce();

    await subscribeConnection(runtimeWithValidator, connection, {
      channelName: 'room:general',
      channelFamily: 'rooms',
      data: { token: 't' },
    });
    expect(
      [...connection.channelMemberships.values()].some((m) => m.channelName === 'room:general'),
    ).toBe(true);
  });
});
