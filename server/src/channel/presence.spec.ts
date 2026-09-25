import { scope } from '~/channel/channel.ts';
import {
  kickChannelMembers,
  leaveChannel,
  removeStoredMember,
  resyncChannelMembers,
  subscribeConnection,
  subscribeConnectionAsServer,
  unsubscribeConnection,
} from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { BroadcastToChannelOptions, LeaveChannelOptions } from '~/channel/runtime.ts';
import type { MembershipInsert, StoredMembership } from '~/channel/storage.ts';

const room = { channelName: 'room:general', channelFamily: 'rooms' } as const;

function createConnection(id: string, userId: string): RuntimeConnection {
  return {
    id,
    userId,
    wsKey: Symbol(id),
    descriptor: {
      send() {},
      close() {},
      bufferedAmount: () => 0,
      userId,
    },
    meta: { name: id },
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  } as unknown as RuntimeConnection;
}

function createRuntime(durable: boolean) {
  const rows = new Map<string, StoredMembership>();
  const presence: { event: string; payload: Record<string, unknown> }[] = [];
  const protocol: {
    to: string;
    event: string;
    payload: Record<string, unknown>;
    livething: Record<string, unknown>;
  }[] = [];
  const deletedRows: string[] = [];

  const rooms = {
    key: 'rooms',
    kind: 'channel' as const,
    pattern: scope('rooms', 'room:{id}'),
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    intercepts: [],
  };

  const base = {
    compiled: { channels: new Map(), channelFamilies: new Map([['rooms', rooms]]) },
    connections: new Map<string, RuntimeConnection>(),
    channelMembers: new Map<string, Set<RuntimeConnection>>(),
    checkHooks: new Map(),
    revalidateHooks: new Map(),
    commitHooks: new Map(),
    subscribeHooks: new Map(),
    unsubscribeHooks: new Map(),
    sessionEndHooks: new Map(),
    toConnectionInfo: () => ({}) as never,
    buildConnectionContext: (connection: RuntimeConnection) => ({ id: connection.id }),
    persistAttachment() {},
    sendProtocolMessage(
      connection: RuntimeConnection,
      { event, payload, livething }: SendProtocolMessageOptions,
    ) {
      protocol.push({
        to: connection.id,
        event,
        payload: payload as Record<string, unknown>,
        livething: livething as Record<string, unknown>,
      });
    },
    broadcastToChannel({ event, payload }: BroadcastToChannelOptions) {
      presence.push({ event, payload: payload as Record<string, unknown> });
    },
    async handleValidationError() {},
    async handleRuntimeError() {},
    isChannelDurable: () => durable,
    persistMembership({ userId, meta }: MembershipInsert) {
      if (userId) rows.set(userId, { meta: meta ?? {}, kicked: false });
    },
    deleteDurableMembership(userId: string) {
      rows.delete(userId);
      deletedRows.push(userId);
    },
    getDurableMembership: (userId: string) => rows.get(userId),
    markDurableMembershipKicked(userId: string) {
      const row = rows.get(userId);
      if (row) rows.set(userId, { ...row, kicked: true });
    },
    listDurableMembers: () => [...rows].map(([userId, row]) => ({ userId, ...row })),
  };

  const runtime = {
    ...base,
    leaveChannel: (connection: RuntimeConnection, opts: LeaveChannelOptions) =>
      leaveChannel(base as never, connection, opts),
  };

  function join(connection: RuntimeConnection): Promise<void> {
    base.connections.set(connection.id, connection);
    return subscribeConnection(runtime as never, connection, { ...room, data: undefined });
  }

  function rejoin(connection: RuntimeConnection): Promise<void> {
    base.connections.set(connection.id, connection);
    return subscribeConnectionAsServer(runtime as never, connection, {
      ...room,
      payload: undefined,
      rejoining: true,
    });
  }

  function disconnect(connection: RuntimeConnection): Promise<void> {
    base.connections.delete(connection.id);
    return leaveChannel(runtime as never, connection, {
      channel: rooms as never,
      ...room,
      disconnect: true,
    });
  }

  function unsubscribe(connection: RuntimeConnection): Promise<void> {
    return unsubscribeConnection(runtime as never, connection, room);
  }

  function kick(userId: string, revoke: boolean): Promise<void> {
    return kickChannelMembers(runtime as never, {
      ...room,
      target: { __livething: 'user-ref', id: userId, instance: undefined },
      reason: 'removed',
      revoke,
    });
  }

  function takePresence(): string[] {
    const events = presence.map(({ event, payload }) => `${event} ${String(payload.memberId)}`);
    presence.length = 0;
    return events;
  }

  function syncFor(connection: RuntimeConnection): unknown[] {
    const syncs = protocol.filter((p) => p.to === connection.id && p.event === '__memberSync__');
    return (syncs.at(-1)?.payload.members ?? []) as unknown[];
  }

  function subscribeOkFor(connection: RuntimeConnection): unknown {
    return protocol.find((p) => p.to === connection.id && p.event === '__subscribeOk__');
  }

  return {
    runtime,
    rows,
    deletedRows,
    protocol,
    join,
    rejoin,
    disconnect,
    unsubscribe,
    kick,
    takePresence,
    syncFor,
    subscribeOkFor,
  };
}

describe('presence on a persistent channel is keyed by user id', () => {
  it('keeps the same member id across a disconnect and an auto-rejoin, then leaves with it', async () => {
    const t = createRuntime(true);
    const first = createConnection('conn_1', 'alice');

    await t.join(first);
    expect(t.takePresence()).toEqual(['__memberJoin__ alice', '__memberOnline__ alice']);

    await t.disconnect(first);
    expect(t.takePresence()).toEqual(['__memberOffline__ alice']);
    expect(t.rows.has('alice')).toBe(true);

    const second = createConnection('conn_2', 'alice');
    await t.rejoin(second);
    expect(t.takePresence()).toEqual(['__memberOnline__ alice']);

    await t.unsubscribe(second);
    expect(t.takePresence()).toEqual(['__memberLeave__ alice', '__memberOffline__ alice']);
    expect(t.rows.has('alice')).toBe(false);
  });

  it('brings a stored member back online without a second join when it subscribes again', async () => {
    const t = createRuntime(true);
    const first = createConnection('conn_1', 'alice');
    await t.join(first);
    await t.disconnect(first);
    t.takePresence();

    await t.join(createConnection('conn_2', 'alice'));
    expect(t.takePresence()).toEqual(['__memberOnline__ alice']);
  });

  it('treats several tabs of one user as one member', async () => {
    const t = createRuntime(true);
    const tabA = createConnection('conn_a', 'alice');
    const tabB = createConnection('conn_b', 'alice');

    await t.join(tabA);
    await t.join(tabB);
    expect(t.takePresence()).toEqual(['__memberJoin__ alice', '__memberOnline__ alice']);

    const peer = createConnection('conn_p', 'bob');
    await t.join(peer);
    expect(t.syncFor(peer)).toEqual([
      { memberId: 'alice', meta: { name: 'conn_a' }, online: true },
    ]);
    expect(t.syncFor(tabB)).toEqual([]);
    t.takePresence();

    await t.disconnect(tabA);
    expect(t.takePresence()).toEqual([]);

    await t.disconnect(tabB);
    expect(t.takePresence()).toEqual(['__memberOffline__ alice']);

    const tabA2 = createConnection('conn_a2', 'alice');
    const tabB2 = createConnection('conn_b2', 'alice');
    await t.rejoin(tabA2);
    await t.rejoin(tabB2);
    expect(t.takePresence()).toEqual(['__memberOnline__ alice']);

    await t.unsubscribe(tabA2);
    expect(t.takePresence()).toEqual([]);
    expect(t.rows.has('alice')).toBe(true);

    await t.unsubscribe(tabB2);
    expect(t.takePresence()).toEqual(['__memberLeave__ alice', '__memberOffline__ alice']);
    expect(t.rows.has('alice')).toBe(false);
  });

  it('broadcasts one leave when a kick removes every tab of a user', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    await t.join(createConnection('conn_b', 'alice'));
    await t.join(createConnection('conn_p', 'bob'));
    t.takePresence();

    await kickChannelMembers(t.runtime as never, {
      ...room,
      target: { __livething: 'user-ref', id: 'alice', instance: undefined },
      reason: 'removed',
      revoke: true,
    });

    expect(t.takePresence()).toEqual(['__memberLeave__ alice', '__memberOffline__ alice']);
    expect(t.rows.has('alice')).toBe(false);
  });

  it('keeps the member present when a kick removes only one of its tabs', async () => {
    const t = createRuntime(true);
    const tabA = createConnection('conn_a', 'alice');
    tabA.tags.ephemeral.set('device', new Set(['phone']));
    await t.join(tabA);
    await t.join(createConnection('conn_b', 'alice'));

    t.takePresence();

    await kickChannelMembers(t.runtime as never, {
      ...room,
      target: { __livething: 'tag-ref', kind: 'ephemeral', group: 'device', key: 'phone' },
      reason: 'removed',
      revoke: true,
    });

    expect(t.takePresence()).toEqual([]);
    expect(t.deletedRows).toEqual([]);
  });

  it('re-sends one snapshot entry per user on a member sync request', async () => {
    const t = createRuntime(true);
    const peer = createConnection('conn_p', 'bob');
    await t.join(createConnection('conn_a', 'alice'));
    await t.join(createConnection('conn_b', 'alice'));
    await t.join(peer);

    resyncChannelMembers(t.runtime as never, peer, room);
    expect(t.syncFor(peer)).toEqual([
      { memberId: 'alice', meta: { name: 'conn_a' }, online: true },
    ]);
  });

  it('keys an anonymous connection by its connection id and ends its membership on disconnect', async () => {
    const t = createRuntime(true);
    const anonymous = createConnection('conn_anon', '');

    await t.join(anonymous);
    expect(t.subscribeOkFor(anonymous)).toMatchObject({
      livething: { channelMembership: 'ephemeral' },
    });
    expect(t.takePresence()).toEqual(['__memberJoin__ conn_anon', '__memberOnline__ conn_anon']);

    await t.disconnect(anonymous);
    expect(t.takePresence()).toEqual(['__memberLeave__ conn_anon', '__memberOffline__ conn_anon']);
  });
});

describe('the member sync lists every member of a persistent channel', () => {
  it('lists a stored member with no live connection as offline, with the meta it joined with', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.disconnect(alice);

    const bob = createConnection('conn_b', 'bob');
    await t.join(bob);

    expect(t.syncFor(bob)).toEqual([
      { memberId: 'alice', meta: { name: 'conn_a' }, online: false },
    ]);
  });

  it('keeps an offline member in the sync an observer gets after its own reconnect', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    const bob = createConnection('conn_b', 'bob');
    await t.join(alice);
    await t.join(bob);

    await t.disconnect(bob);
    await t.disconnect(alice);

    const bobAgain = createConnection('conn_b2', 'bob');
    await t.rejoin(bobAgain);

    expect(t.syncFor(bobAgain)).toEqual([
      { memberId: 'alice', meta: { name: 'conn_a' }, online: false },
    ]);
  });

  it('lists a member once as online while one of its tabs is live', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    const peer = createConnection('conn_p', 'bob');
    await t.join(peer);

    resyncChannelMembers(t.runtime as never, peer, room);
    expect(t.syncFor(peer)).toEqual([
      { memberId: 'alice', meta: { name: 'conn_a' }, online: true },
    ]);
  });

  it('drops a member that left while the observer was offline', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    const bob = createConnection('conn_b', 'bob');
    await t.join(alice);
    await t.join(bob);

    await t.disconnect(bob);
    await t.unsubscribe(alice);

    const bobAgain = createConnection('conn_b2', 'bob');
    await t.rejoin(bobAgain);
    expect(t.syncFor(bobAgain)).toEqual([]);
  });

  it('leaves out a member whose membership a kick ended', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    await t.kick('alice', false);

    const bob = createConnection('conn_b', 'bob');
    await t.join(bob);
    expect(t.rows.get('alice')?.kicked).toBe(true);
    expect(t.syncFor(bob)).toEqual([]);
  });

  it('lists anonymous connections as online members keyed by connection id', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_anon', ''));
    const bob = createConnection('conn_b', 'bob');
    await t.join(bob);

    expect(t.syncFor(bob)).toEqual([
      { memberId: 'conn_anon', meta: { name: 'conn_anon' }, online: true },
    ]);
  });
});

describe('a kick that keeps the membership ends it until the user rejoins', () => {
  it('sends leave then offline on the kick, and join then online on the rejoin', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    await t.join(createConnection('conn_b', 'bob'));
    t.takePresence();

    await t.kick('alice', false);
    expect(t.takePresence()).toEqual(['__memberLeave__ alice', '__memberOffline__ alice']);
    expect(t.rows.get('alice')).toEqual({ meta: { name: 'conn_a' }, kicked: true });

    await t.rejoin(createConnection('conn_a2', 'alice'));
    expect(t.takePresence()).toEqual(['__memberJoin__ alice', '__memberOnline__ alice']);
    expect(t.rows.get('alice')).toEqual({ meta: { name: 'conn_a2' }, kicked: false });
  });

  it('marks the row kicked even when the compiled channel cannot be resolved', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    t.runtime.compiled.channelFamilies.clear();

    await t.kick('alice', false);
    expect(t.rows.get('alice')).toEqual({ meta: { name: 'conn_a' }, kicked: true });
  });

  it('sends join then online when the kicked user subscribes again on a live socket', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.kick('alice', false);
    t.takePresence();

    await t.join(alice);
    expect(t.takePresence()).toEqual(['__memberJoin__ alice', '__memberOnline__ alice']);
  });

  it('marks the row kicked once when the kick removes every tab of the user', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    await t.join(createConnection('conn_b', 'alice'));
    t.takePresence();

    await t.kick('alice', false);
    expect(t.takePresence()).toEqual(['__memberLeave__ alice', '__memberOffline__ alice']);
    expect(t.rows.get('alice')?.kicked).toBe(true);
    expect(t.deletedRows).toEqual([]);

    await t.rejoin(createConnection('conn_a2', 'alice'));
    await t.rejoin(createConnection('conn_b2', 'alice'));
    expect(t.takePresence()).toEqual(['__memberJoin__ alice', '__memberOnline__ alice']);
  });

  it('keeps the row kicked when the rejoin socket closes before it is confirmed', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    await t.kick('alice', false);
    t.takePresence();

    const closing = createConnection('conn_a2', 'alice');
    Object.assign(closing, { closing: true });
    await t.rejoin(closing);

    expect(t.takePresence()).toEqual([]);
    expect(t.rows.get('alice')?.kicked).toBe(true);
  });
});

describe('a kick reaches a stored member with no live connection', () => {
  it('drops the row and sends leave, with no offline, on a revoking kick', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.disconnect(alice);
    t.takePresence();

    await t.kick('alice', true);
    expect(t.takePresence()).toEqual(['__memberLeave__ alice']);
    expect(t.rows.has('alice')).toBe(false);
  });

  it('marks the row kicked and sends leave once on a kick that keeps the membership', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.disconnect(alice);
    t.takePresence();

    await t.kick('alice', false);
    await t.kick('alice', false);
    expect(t.takePresence()).toEqual(['__memberLeave__ alice']);
    expect(t.rows.get('alice')?.kicked).toBe(true);

    await t.kick('alice', true);
    expect(t.takePresence()).toEqual([]);
    expect(t.rows.has('alice')).toBe(false);
  });
});

describe('removing a stored member after its rejoin is rejected', () => {
  it('drops the row and sends leave when the user has no live connection in the channel', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.disconnect(alice);
    t.takePresence();

    removeStoredMember(t.runtime as never, { userId: 'alice', ...room, revoke: true });
    expect(t.takePresence()).toEqual(['__memberLeave__ alice']);
    expect(t.rows.has('alice')).toBe(false);
  });

  it('keeps the row while another tab of the user is live in the channel', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    t.takePresence();

    removeStoredMember(t.runtime as never, { userId: 'alice', ...room, revoke: true });
    expect(t.takePresence()).toEqual([]);
    expect(t.rows.has('alice')).toBe(true);
  });
});

describe('a stored member that subscribes again keeps its membership if the subscribe fails', () => {
  it('does not drop the row when the new socket closes before it is confirmed', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.disconnect(alice);
    t.takePresence();

    const closing = createConnection('conn_a2', 'alice');
    Object.assign(closing, { closing: true });
    await t.join(closing);

    expect(t.rows.has('alice')).toBe(true);
    expect(t.deletedRows).toEqual([]);
  });
});

describe('presence on an ephemeral channel is keyed by connection id', () => {
  it('treats each tab as its own member and ends it on disconnect', async () => {
    const t = createRuntime(false);
    const tabA = createConnection('conn_a', 'alice');
    const tabB = createConnection('conn_b', 'alice');

    await t.join(tabA);
    await t.join(tabB);
    expect(t.syncFor(tabB)).toEqual([
      { memberId: 'conn_a', meta: { name: 'conn_a' }, online: true },
    ]);
    expect(t.takePresence()).toEqual([
      '__memberJoin__ conn_a',
      '__memberOnline__ conn_a',
      '__memberJoin__ conn_b',
      '__memberOnline__ conn_b',
    ]);

    await t.disconnect(tabA);
    expect(t.takePresence()).toEqual(['__memberLeave__ conn_a', '__memberOffline__ conn_a']);
  });
});
