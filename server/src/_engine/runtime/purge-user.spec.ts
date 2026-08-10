import { CloseCodes } from '@wskit/core';
import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { channels } from '~/channel/capability.ts';
import {
  insertMembership,
  listMembershipsByUser as listMembershipRows,
} from '~/channel/storage.ts';
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
      identity: userId,
    },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  } as unknown as RuntimeConnection;
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

describe('admin().purgeUser()', () => {
  it('deletes a user membership rows and tag rows, and closes its live sockets', async () => {
    const { engine, sql } = await buildEngine(withChannelsAndTags());

    insertMembership(sql, { userId: 'alice', channelName: 'lobby', channelFamily: null });
    insertTag(sql, { userId: 'alice', group: 'favorite', key: 'blue' });
    const connection = fakeConnection('conn-1', 'alice');
    engine.core.connections.set(connection.id, connection);

    await engine.admin().purgeUser('alice');

    expect(listMembershipRows(sql, 'alice')).toHaveLength(0);
    expect(listTagsByUser(sql, 'alice')).toHaveLength(0);
    expect(connection.descriptor.close).toHaveBeenCalledWith(CloseCodes.NORMAL, 'user purged');
  });

  it('leaves a different user id untouched', async () => {
    const { engine, sql } = await buildEngine(withChannelsAndTags());

    insertMembership(sql, { userId: 'alice', channelName: 'lobby', channelFamily: null });
    insertMembership(sql, { userId: 'bob', channelName: 'lobby', channelFamily: null });
    insertTag(sql, { userId: 'alice', group: 'favorite', key: 'blue' });
    insertTag(sql, { userId: 'bob', group: 'favorite', key: 'green' });

    await engine.admin().purgeUser('alice');

    expect(listMembershipRows(sql, 'bob')).toHaveLength(1);
    expect(listTagsByUser(sql, 'bob')).toHaveLength(1);
  });

  it('with neither channels() nor tags() listed, closes sockets and touches no storage', async () => {
    const base = define({ env: t<Record<string, never>>(), capabilities: [] });
    const handler = base.assemble({ handlers: [] });
    const { engine, sql } = await buildEngine(handler);
    const connection = fakeConnection('conn-1', 'alice');
    engine.core.connections.set(connection.id, connection);
    expect(engine.core.hooks.purgeUser).toHaveLength(0);

    await expect(engine.admin().purgeUser('alice')).resolves.toBeUndefined();

    expect(connection.descriptor.close).toHaveBeenCalledWith(CloseCodes.NORMAL, 'user purged');
    // No capability ever created the durable tables, so nothing to query — the
    // call above completing without throwing is itself the "touches no storage" proof.
    expect(
      sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray(),
    ).not.toContainEqual(expect.objectContaining({ name: '__wskit_channel_memberships' }));
  });
});
