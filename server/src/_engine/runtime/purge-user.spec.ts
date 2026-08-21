import { CloseCodes } from '@wskit/core';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { purgeUser } from '~/_engine/runtime/purge-user.ts';
import {
  ensureDurableStreamSchema,
  getSubscriber,
  insertStream,
  readStream,
  seedSubscriber,
} from '~/_engine/stream-durable/storage.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { channels } from '~/channel/capability.ts';
import {
  insertMembership,
  listMembershipsByUser as listMembershipRows,
} from '~/channel/storage.ts';
import { dedup } from '~/dedup/capability.ts';
import { inbox, readReceipts } from '~/inbox/capability.ts';
import {
  advanceReceivedThrough,
  listReceivers as listReceiptRowsForSeq,
} from '~/inbox/receipts-storage.ts';
import { insertInboxRows, loadUndeliveredRows } from '~/inbox/storage.ts';
import { lastSeen } from '~/last-seen/capability.ts';
import { readLastSeen, stampLastSeen } from '~/last-seen/storage.ts';
import { sequence } from '~/sequence/capability.ts';
import { resumableStream } from '~/stream-resumable/capability.ts';
import { tags } from '~/tags/capability.ts';
import { insertTag, listTagsByUser } from '~/tags/storage.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContextFactory, SQLProvider } from '~/context.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function passthroughAsyncContext(): AsyncContextFactory {
  return function createAsyncContext<TStore>() {
    let current: TStore | undefined;
    return {
      run<R>(store: TStore, callback: () => R): R {
        const prev = current;
        current = store;
        try {
          return callback();
        } finally {
          current = prev;
        }
      },
      getStore: () => current,
    };
  };
}

/** Build and initialize a real engine, exposing its core's real SQLite storage. */
async function buildEngine(
  handler: ServerDefinition,
): Promise<{ engine: Engine; sql: SQLProvider }> {
  const sql = createTestSql();
  let engine!: Engine;
  const server = adapter({
    id: 'test',
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      engine = createEngine({
        env: {},
        platform: { kind: 'test' },
        storage: { sql, kv: createTestKV() },
        timers: {
          setAlarm: vi.fn(async () => {}),
          deleteAlarm: vi.fn(async () => {}),
          getAlarm: vi.fn(async () => null),
        },
        waitUntil: () => {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  });
  server(handler, {} as never);
  await engine.initialize();
  return { engine, sql };
}

function fakeConnection(id: string, userId: string): RuntimeConnection {
  return {
    id,
    userId,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount: () => 0,
      userId,
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  } as unknown as RuntimeConnection;
}

function fakeConnectionWithThrowingClose(id: string, userId: string): RuntimeConnection {
  const connection = fakeConnection(id, userId);
  connection.descriptor.close = vi.fn(() => {
    throw new Error('adapter close blew up');
  });
  return connection;
}

function withChannelsAndTags(): ServerDefinition {
  const base = define({
    env: t<Record<string, never>>(),
    capabilities: [
      channels(),
      tags((_ephemeral, persistent) => [persistent('favorite', t<string>())]),
    ],
  });
  const lobby = base.channel('lobby');
  const noop = lobby.on('noop', { run() {} });
  return base.assemble({ handlers: [noop] });
}

function withEveryOwningCapability(): ServerDefinition {
  const base = define({
    env: t<Record<string, never>>(),
    capabilities: [
      channels(),
      tags((_ephemeral, persistent) => [persistent('favorite', t<string>())]),
      sequence({ persist: true }),
      dedup(),
      lastSeen(),
      resumableStream(),
    ],
  });
  const lobby = base.channel('lobby');
  const chat = base.channel('chat', { capabilities: [inbox(), readReceipts()] });
  const lobbyNoop = lobby.on('noop', { run() {} });
  const chatNoop = chat.on('noop', { run() {} });
  return base.assemble({ handlers: [lobbyNoop, chatNoop] });
}

describe('admin().purgeUser() — every owning capability enabled together', () => {
  it('removes one user from all seven tables while leaving another user intact', async () => {
    const { engine, sql } = await buildEngine(withEveryOwningCapability());
    const now = Date.now();

    insertMembership(sql, { userId: 'alice', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'bob', channelName: 'lobby', channelFamily: null });

    insertTag(sql, { userId: 'alice', group: 'favorite', key: 'blue' });
    insertTag(sql, { userId: 'bob', group: 'favorite', key: 'green' });

    insertInboxRows(sql, {
      userIds: ['alice'],
      channelName: 'chat',
      channelFamily: null,
      frame: { seq: 1, messageId: 'm-alice', event: 'msg', payload: { text: 'hi' } },
      now,
    });
    insertInboxRows(sql, {
      userIds: ['bob'],
      channelName: 'chat',
      channelFamily: null,
      frame: { seq: 2, messageId: 'm-bob', event: 'msg', payload: { text: 'yo' } },
      now,
    });

    advanceReceivedThrough(sql, {
      channelName: 'chat',
      channelFamily: null,
      userId: 'alice',
      receivedThrough: 1,
      now,
    });
    advanceReceivedThrough(sql, {
      channelName: 'chat',
      channelFamily: null,
      userId: 'bob',
      receivedThrough: 2,
      now,
    });

    stampLastSeen(sql, { userId: 'alice', now });
    stampLastSeen(sql, { userId: 'bob', now });

    ensureDurableStreamSchema(sql);
    insertStream(sql, {
      userId: 'alice',
      streamId: 'alice-stream',
      event: 'progress',
      payload: '{}',
      kind: 'resumable',
      now,
    });
    insertStream(sql, {
      userId: 'bob',
      streamId: 'bob-stream',
      event: 'progress',
      payload: '{}',
      kind: 'resumable',
      now,
    });
    seedSubscriber(sql, {
      storageUserId: 'bob',
      streamId: 'bob-stream',
      subscriberUserId: 'alice',
    });

    const aliceConnection = fakeConnection('conn-alice', 'alice');
    engine.core.connections.set(aliceConnection.id, aliceConnection);
    const bobConnection = fakeConnection('conn-bob', 'bob');
    engine.core.connections.set(bobConnection.id, bobConnection);

    await engine.admin().purgeUser('alice');

    expect(listMembershipRows(sql, 'alice')).toHaveLength(0);
    expect(listMembershipRows(sql, 'bob')).toHaveLength(1);

    expect(listTagsByUser(sql, 'alice')).toHaveLength(0);
    expect(listTagsByUser(sql, 'bob')).toHaveLength(1);

    expect(loadUndeliveredRows(sql, 'alice')).toHaveLength(0);
    expect(loadUndeliveredRows(sql, 'bob')).toHaveLength(1);
    expect(
      sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM __wskit_inbox WHERE user_id = ?', 'bob')
        .one(),
    ).toMatchObject({ n: 1 });

    expect(
      listReceiptRowsForSeq(sql, { channelName: 'chat', channelFamily: null, seq: 1 }),
    ).not.toContain('alice');
    expect(
      listReceiptRowsForSeq(sql, { channelName: 'chat', channelFamily: null, seq: 2 }),
    ).toContain('bob');

    expect(readLastSeen(sql, 'alice')).toBeNull();
    expect(readLastSeen(sql, 'bob')).not.toBeNull();

    expect(readStream(sql, 'alice', 'alice-stream')).toBeNull();
    expect(readStream(sql, 'bob', 'bob-stream')).not.toBeNull();
    expect(
      getSubscriber(sql, {
        storageUserId: 'bob',
        streamId: 'bob-stream',
        subscriberUserId: 'alice',
      }),
    ).toBeNull();

    expect(aliceConnection.descriptor.close).toHaveBeenCalledWith(CloseCodes.NORMAL, 'user purged');
    expect(bobConnection.descriptor.close).not.toHaveBeenCalled();
  });
});

describe('admin().purgeUser()', () => {
  it('deletes a user membership rows and tag rows, and closes only its live sockets', async () => {
    const { engine, sql } = await buildEngine(withChannelsAndTags());

    insertMembership(sql, { userId: 'alice', channelName: 'lobby', channelFamily: null });
    insertTag(sql, { userId: 'alice', group: 'favorite', key: 'blue' });
    const connection = fakeConnection('conn-1', 'alice');
    engine.core.connections.set(connection.id, connection);
    const otherConnection = fakeConnection('conn-2', 'bob');
    engine.core.connections.set(otherConnection.id, otherConnection);

    await engine.admin().purgeUser('alice');

    expect(listMembershipRows(sql, 'alice')).toHaveLength(0);
    expect(listTagsByUser(sql, 'alice')).toHaveLength(0);
    expect(connection.descriptor.close).toHaveBeenCalledWith(CloseCodes.NORMAL, 'user purged');
    expect(otherConnection.descriptor.close).not.toHaveBeenCalled();
  });

  it('leaves a different user id untouched, including its live socket', async () => {
    const { engine, sql } = await buildEngine(withChannelsAndTags());

    insertMembership(sql, { userId: 'alice', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'bob', channelName: 'lobby', channelFamily: null });
    insertTag(sql, { userId: 'alice', group: 'favorite', key: 'blue' });
    insertTag(sql, { userId: 'bob', group: 'favorite', key: 'green' });
    const bobConnection = fakeConnection('conn-bob', 'bob');
    engine.core.connections.set(bobConnection.id, bobConnection);

    await engine.admin().purgeUser('alice');

    expect(listMembershipRows(sql, 'bob')).toHaveLength(1);
    expect(listTagsByUser(sql, 'bob')).toHaveLength(1);
    expect(bobConnection.descriptor.close).not.toHaveBeenCalled();
  });

  it("with neither channels() nor tags() listed, closes only the purged user's sockets and touches no storage", async () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [] });
    const handler = base.assemble({ handlers: [] });
    const { engine, sql } = await buildEngine(handler);
    const connection = fakeConnection('conn-1', 'alice');
    engine.core.connections.set(connection.id, connection);
    const otherConnection = fakeConnection('conn-2', 'bob');
    engine.core.connections.set(otherConnection.id, otherConnection);
    expect(engine.core.hooks.purgeUser).toHaveLength(0);

    await expect(engine.admin().purgeUser('alice')).resolves.toBeUndefined();

    expect(connection.descriptor.close).toHaveBeenCalledWith(CloseCodes.NORMAL, 'user purged');
    expect(otherConnection.descriptor.close).not.toHaveBeenCalled();
    // No capability ever created the durable tables, so nothing to query — the
    // call above completing without throwing is itself the "touches no storage" proof.
    expect(
      sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray(),
    ).not.toContainEqual(expect.objectContaining({ name: '__wskit_channel_memberships' }));
  });
});

describe('admin().purgeUser() — one cleanup step throws', () => {
  it('still runs every other hook, still closes sockets, and reports the failure to the caller', async () => {
    const { engine, sql } = await buildEngine(withChannelsAndTags());

    insertMembership(sql, { userId: 'alice', channelName: 'lobby', channelFamily: null });
    insertTag(sql, { userId: 'alice', group: 'favorite', key: 'blue' });
    const connection = fakeConnection('conn-1', 'alice');
    engine.core.connections.set(connection.id, connection);

    const boom = new Error('boom: streams unreachable');
    // Splice a throwing hook in among the real channels()/tags() hooks
    // (without removing either) so this proves hooks on both sides of the
    // failure still run — regardless of exactly how many hooks are registered.
    engine.core.hooks.purgeUser.splice(1, 0, () => {
      throw boom;
    });

    await expect(engine.admin().purgeUser('alice')).rejects.toThrow(AggregateError);

    expect(listMembershipRows(sql, 'alice')).toHaveLength(0);
    expect(listTagsByUser(sql, 'alice')).toHaveLength(0);
    expect(connection.descriptor.close).toHaveBeenCalledWith(CloseCodes.NORMAL, 'user purged');
  });

  it('carries the underlying error in the thrown AggregateError', async () => {
    const { engine } = await buildEngine(withChannelsAndTags());
    const boom = new Error('boom');
    engine.core.hooks.purgeUser.push(() => {
      throw boom;
    });

    let caught: unknown;
    try {
      await engine.admin().purgeUser('alice');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toContain(boom);
  });
});

describe('admin().purgeUser() — durable-stream schema never created before purge', () => {
  it('succeeds when resumableStream() is listed but no stream has ever been started', async () => {
    const base = define({
      env: t<Record<string, never>>(),
      capabilities: [resumableStream()],
    });
    const handler = base.assemble({ handlers: [] });
    const { engine } = await buildEngine(handler);
    const connection = fakeConnection('conn-1', 'alice');
    engine.core.connections.set(connection.id, connection);

    await expect(engine.admin().purgeUser('alice')).resolves.toBeUndefined();

    expect(connection.descriptor.close).toHaveBeenCalledWith(CloseCodes.NORMAL, 'user purged');
  });
});

describe('purgeUser(core, userId, options) — broadcast stream content', () => {
  it('by default deletes a broadcast stream the purged user created', async () => {
    const { engine, sql } = await buildEngine(withEveryOwningCapability());
    const now = Date.now();
    ensureDurableStreamSchema(sql);
    insertStream(sql, {
      userId: '__bcast:ch:room__',
      streamId: 's-broadcast',
      event: 'progress',
      payload: '{}',
      kind: 'resumable',
      now,
      broadcast: true,
      creatorUserId: 'alice',
    });

    await purgeUser(engine.core, 'alice');

    expect(readStream(sql, '__bcast:ch:room__', 's-broadcast')).toBeNull();
  });

  it('keepBroadcastContent: true keeps the stream but still clears creator_user_id', async () => {
    const { engine, sql } = await buildEngine(withEveryOwningCapability());
    const now = Date.now();
    ensureDurableStreamSchema(sql);
    insertStream(sql, {
      userId: '__bcast:ch:room__',
      streamId: 's-broadcast',
      event: 'progress',
      payload: '{}',
      kind: 'resumable',
      now,
      broadcast: true,
      creatorUserId: 'alice',
    });

    await purgeUser(engine.core, 'alice', { keepBroadcastContent: true });

    const row = readStream(sql, '__bcast:ch:room__', 's-broadcast');
    expect(row).not.toBeNull();
    expect(row?.creatorUserId).toBeNull();
  });
});

describe('purgeUser — one socket close throws', () => {
  it('still closes every remaining socket for the user', async () => {
    const { engine } = await buildEngine(withChannelsAndTags());
    const first = fakeConnectionWithThrowingClose('conn-1', 'alice');
    const second = fakeConnection('conn-2', 'alice');
    engine.core.connections.set(first.id, first);
    engine.core.connections.set(second.id, second);

    await expect(purgeUser(engine.core, 'alice')).rejects.toThrow();

    expect(second.descriptor.close).toHaveBeenCalledWith(CloseCodes.NORMAL, 'user purged');
  });

  it('still surfaces an AggregateError carrying a cleanup-hook failure', async () => {
    const { engine } = await buildEngine(withChannelsAndTags());
    const boom = new Error('boom: cleanup hook failed');
    engine.core.hooks.purgeUser.push(() => {
      throw boom;
    });
    const first = fakeConnectionWithThrowingClose('conn-1', 'alice');
    engine.core.connections.set(first.id, first);

    let caught: unknown;
    try {
      await purgeUser(engine.core, 'alice');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toContain(boom);
  });
});

describe('purgeUser — empty user id', () => {
  it("purgeUser(core, '') rejects instead of closing every anonymous connection", async () => {
    const { engine } = await buildEngine(withChannelsAndTags());
    const anonA = fakeConnection('conn-anon-a', '');
    const anonB = fakeConnection('conn-anon-b', '');
    const alice = fakeConnection('conn-alice', 'alice');
    engine.core.connections.set(anonA.id, anonA);
    engine.core.connections.set(anonB.id, anonB);
    engine.core.connections.set(alice.id, alice);

    await expect(purgeUser(engine.core, '')).rejects.toThrow();

    expect(anonA.descriptor.close).not.toHaveBeenCalled();
    expect(anonB.descriptor.close).not.toHaveBeenCalled();
    expect(alice.descriptor.close).not.toHaveBeenCalled();
  });

  it("admin().purgeUser('') rejects the same way", async () => {
    const { engine } = await buildEngine(withChannelsAndTags());
    const anonA = fakeConnection('conn-anon-a', '');
    engine.core.connections.set(anonA.id, anonA);

    await expect(engine.admin().purgeUser('')).rejects.toThrow();

    expect(anonA.descriptor.close).not.toHaveBeenCalled();
  });
});
