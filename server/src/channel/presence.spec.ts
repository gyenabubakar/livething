import { scope } from '~/channel/channel.ts';
import {
  kickChannelMembers,
  leaveChannel,
  removeStoredMember,
  subscribeConnection,
  subscribeConnectionAsServer,
  unsubscribeConnection,
} from '~/channel/runtime.ts';
import { describe, expect, it } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { PresenceChange } from '~/channel/presence-batch.ts';
import type { LeaveChannelOptions } from '~/channel/runtime.ts';
import type { MembershipInsert, StoredMembership } from '~/channel/storage.ts';

const room = { channelName: 'room:general', channelFamily: 'rooms' } as const;

function createConnection(id: string, userId: string): RuntimeConnection {
  return {
    id,
    userId,
    socketKey: Symbol(id),
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

function createRuntime(durable: boolean, presenceOn = true) {
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
    broadcastToChannel() {},
    hasPresence: () => presenceOn,
    recordPresence(_scope: unknown, changes: PresenceChange[]) {
      for (const change of changes) {
        presence.push({
          event: change.kind,
          payload: change as unknown as Record<string, unknown>,
        });
      }
    },
    async handleRuntimeError() {},
    isChannelDurable: () => durable,
    persistMembership({ userId, meta }: MembershipInsert) {
      if (userId) rows.set(userId, { meta: meta ?? {} });
    },
    deleteDurableMembership(userId: string) {
      rows.delete(userId);
      deletedRows.push(userId);
    },
    getDurableMembership: (userId: string) => rows.get(userId),
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

  function kick(userId: string): Promise<void> {
    return kickChannelMembers(runtime as never, {
      ...room,
      target: { __livething: 'user-ref', id: userId, instance: undefined },
      reason: 'removed',
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
    expect(t.takePresence()).toEqual(['join alice', 'online alice']);

    await t.disconnect(first);
    expect(t.takePresence()).toEqual(['offline alice']);
    expect(t.rows.has('alice')).toBe(true);

    const second = createConnection('conn_2', 'alice');
    await t.rejoin(second);
    expect(t.takePresence()).toEqual(['online alice']);

    await t.unsubscribe(second);
    expect(t.takePresence()).toEqual(['leave alice', 'offline alice']);
    expect(t.rows.has('alice')).toBe(false);
  });

  it('brings a stored member back online without a second join when it subscribes again', async () => {
    const t = createRuntime(true);
    const first = createConnection('conn_1', 'alice');
    await t.join(first);
    await t.disconnect(first);
    t.takePresence();

    await t.join(createConnection('conn_2', 'alice'));
    expect(t.takePresence()).toEqual(['online alice']);
  });

  it('treats several tabs of one user as one member', async () => {
    const t = createRuntime(true);
    const tabA = createConnection('conn_a', 'alice');
    const tabB = createConnection('conn_b', 'alice');

    await t.join(tabA);
    await t.join(tabB);
    expect(t.takePresence()).toEqual(['join alice', 'online alice']);

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
    expect(t.takePresence()).toEqual(['offline alice']);

    const tabA2 = createConnection('conn_a2', 'alice');
    const tabB2 = createConnection('conn_b2', 'alice');
    await t.rejoin(tabA2);
    await t.rejoin(tabB2);
    expect(t.takePresence()).toEqual(['online alice']);

    await t.unsubscribe(tabA2);
    expect(t.takePresence()).toEqual([]);
    expect(t.rows.has('alice')).toBe(true);

    await t.unsubscribe(tabB2);
    expect(t.takePresence()).toEqual(['leave alice', 'offline alice']);
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
    });

    expect(t.takePresence()).toEqual(['leave alice', 'offline alice']);
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
    });

    expect(t.takePresence()).toEqual([]);
    expect(t.deletedRows).toEqual([]);
  });

  it('sends one snapshot entry per user in the member sync', async () => {
    const t = createRuntime(true);
    const peer = createConnection('conn_p', 'bob');
    await t.join(createConnection('conn_a', 'alice'));
    await t.join(createConnection('conn_b', 'alice'));
    await t.join(peer);

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
    expect(t.takePresence()).toEqual(['join conn_anon', 'online conn_anon']);

    await t.disconnect(anonymous);
    expect(t.takePresence()).toEqual(['leave conn_anon', 'offline conn_anon']);
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
    await t.kick('alice');

    const bob = createConnection('conn_b', 'bob');
    await t.join(bob);
    expect(t.rows.has('alice')).toBe(false);
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

describe('a kick ends the membership for good', () => {
  it('drops the row, sends leave then offline, and the user does not rejoin', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    await t.join(createConnection('conn_b', 'bob'));
    t.takePresence();

    await t.kick('alice');
    expect(t.takePresence()).toEqual(['leave alice', 'offline alice']);
    expect(t.rows.has('alice')).toBe(false);

    const again = createConnection('conn_a2', 'alice');
    await t.rejoin(again);
    expect(t.takePresence()).toEqual([]);
    expect(t.subscribeOkFor(again)).toBeUndefined();
  });

  it('drops the row even when the compiled channel cannot be resolved', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    t.runtime.compiled.channelFamilies.clear();

    await t.kick('alice');
    expect(t.rows.has('alice')).toBe(false);
  });

  it('sends join then online when the kicked user subscribes again on a live socket', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.kick('alice');
    t.takePresence();

    await t.join(alice);
    expect(t.takePresence()).toEqual(['join alice', 'online alice']);
  });

  it('drops the row once when the kick removes every tab of the user', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    await t.join(createConnection('conn_b', 'alice'));
    t.takePresence();

    await t.kick('alice');
    expect(t.takePresence()).toEqual(['leave alice', 'offline alice']);
    expect(t.deletedRows).toEqual(['alice']);
  });
});

describe('a kick reaches a stored member with no live connection', () => {
  it('drops the row and sends leave once, with no offline', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.disconnect(alice);
    t.takePresence();

    await t.kick('alice');
    await t.kick('alice');
    expect(t.takePresence()).toEqual(['leave alice']);
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

    removeStoredMember(t.runtime as never, { userId: 'alice', ...room });
    expect(t.takePresence()).toEqual(['leave alice']);
    expect(t.rows.has('alice')).toBe(false);
  });

  it('keeps the row while another tab of the user is live in the channel', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));
    t.takePresence();

    removeStoredMember(t.runtime as never, { userId: 'alice', ...room });
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

  it('keeps the stored meta of an offline member when the new socket closes before it is confirmed', async () => {
    const t = createRuntime(true);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.disconnect(alice);

    const closing = createConnection('conn_a2', 'alice');
    Object.assign(closing, { closing: true });
    await t.join(closing);

    expect(t.rows.get('alice')).toEqual({ meta: { name: 'conn_a' } });
  });

  it('keeps the stored meta of a live member when a second tab fails to subscribe', async () => {
    const t = createRuntime(true);
    await t.join(createConnection('conn_a', 'alice'));

    const closing = createConnection('conn_a2', 'alice');
    Object.assign(closing, { closing: true });
    await t.join(closing);

    expect(t.rows.get('alice')).toEqual({ meta: { name: 'conn_a' } });
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
      'join conn_a',
      'online conn_a',
      'join conn_b',
      'online conn_b',
    ]);

    await t.disconnect(tabA);
    expect(t.takePresence()).toEqual(['leave conn_a', 'offline conn_a']);
  });
});

describe('a channel with presence: false', () => {
  it('records no change on a disconnect or a kick of an ephemeral member', async () => {
    const t = createRuntime(false, false);
    const alice = createConnection('conn_a', 'alice');
    const bob = createConnection('conn_b', 'bob');
    await t.join(alice);
    await t.join(bob);

    await t.disconnect(alice);
    await t.kick('bob');

    expect(t.takePresence()).toEqual([]);
  });

  it('records no change when a kick ends a stored member with no live connection', async () => {
    const t = createRuntime(true, false);
    const alice = createConnection('conn_a', 'alice');
    await t.join(alice);
    await t.disconnect(alice);
    expect(t.rows.has('alice')).toBe(true);

    await t.kick('alice');

    expect(t.rows.has('alice')).toBe(false);
    expect(t.takePresence()).toEqual([]);
  });
});
