import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { channels } from '~/channel/capability.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { lastSeen } from '~/last-seen/capability.ts';
import { stampLastSeen } from '~/last-seen/storage.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContextFactory } from '~/context.ts';
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

async function buildEngine(definition: ServerDefinition) {
  const reads: string[] = [];
  const sql = createTestSql({
    onExec: (query) => {
      if (/^\s*SELECT/i.test(query) && query.includes('__livething_last_seen')) reads.push(query);
    },
  });
  let engine!: Engine;
  adapter({
    id: 'test',
    asyncContextFactory: passthroughAsyncContext(),
    setup(createEngine) {
      engine = createEngine({
        platform: { kind: 'test' },
        storage: { sql, kv: createTestKV() },
        timers: { setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(definition, {} as never);
  await engine.initialize();

  return { engine, sql, reads };
}

function fakeConnection(id: string, userId: string): RuntimeConnection {
  return {
    id,
    userId,
    socketKey: Symbol(id),
    descriptor: { send: vi.fn(), close: vi.fn(), bufferedAmount: () => 0, userId },
    meta: {},
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  } as unknown as RuntimeConnection;
}

function huddleDefinition(withLastSeen: boolean): ServerDefinition {
  const base = server({ capabilities: withLastSeen ? [channels(), lastSeen()] : [channels()] });
  const general = base.channel('general');
  return base.assemble({ handlers: [general.on('typing', { run() {} })] });
}

async function seed(withLastSeen: boolean, count: number) {
  const built = await buildEngine(huddleDefinition(withLastSeen));
  const { core } = built.engine;
  const members = new Set<RuntimeConnection>();
  for (let i = 0; i < count; i++) {
    const userId = `user_${i}`;
    const connection = fakeConnection(`conn_${i}`, userId);
    core.connections.set(connection.id, connection);
    core.usersByKey.set(userId, new Set([connection]));
    members.add(connection);

    if (withLastSeen) stampLastSeen(built.sql, { userId, now: 1_000 + i });
  }

  core.channelMembers.set(createChannelMembershipKey('general', null), members);

  built.reads.length = 0;

  return built;
}

describe('ConnectionInfo.lastSeen()', () => {
  it('reads no last-seen rows while listing connections, and one row per lastSeen() call', async () => {
    const { engine, reads } = await seed(true, 5);
    const admin = engine.admin() as unknown as {
      connections: { all(): Array<{ lastSeen?: () => number | null }> };
      channels: { get(name: string): { members(): Array<{ lastSeen?: () => number | null }> } };
      users: { get(id: string): { info(): { lastSeen?: () => number | null } | null } };
    };

    const all = admin.connections.all();
    const members = admin.channels.get('general').members();
    const user = admin.users.get('user_3').info()!;
    expect(all).toHaveLength(5);
    expect(members).toHaveLength(5);

    expect(reads).toHaveLength(0);

    expect(all[2]!.lastSeen!()).toBe(1_002);
    expect(members[4]!.lastSeen!()).toBe(1_004);
    expect(user.lastSeen!()).toBe(1_003);
    expect(reads).toHaveLength(3);
  });

  it('has no lastSeen member when lastSeen() is not listed', async () => {
    const { engine } = await seed(false, 2);
    const [info] = engine.admin().connections.all();
    expect('lastSeen' in info!).toBe(false);
    expect('lastSeen' in engine.admin().users.get('user_0').info()!).toBe(false);
  });
});
