/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { server } from '~/_define/server.ts';
import { buildConnectionContext, toConnectionInfo } from '~/_engine/contexts/contexts.ts';
import { createTestSql, createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { buildChannelFamilyExtra, buildChannelsApi } from '~/channel/context.ts';
import { ensureLastSeenSchema, readLastSeen, stampLastSeen } from '~/last-seen/storage.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string, userId: string): RuntimeConnection {
  return {
    id,
    userId,
    socketKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function baseStorage() {
  return {
    sql: { exec: vi.fn(), transaction: vi.fn() } as any,
    kv: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), list: vi.fn() } as any,
  };
}

/** Registers `connections` under both `usersByKey.get(userId)` and `deps.connections`. */
function baseDeps(connections: RuntimeConnection[], overrides: Record<string, unknown> = {}) {
  const usersByKey = new Map<string, Set<RuntimeConnection>>();
  const connectionsMap = new Map<string, RuntimeConnection>();
  for (const c of connections) {
    connectionsMap.set(c.id, c);
    const key = c.userId || c.id;
    let set = usersByKey.get(key);
    if (!set) {
      set = new Set();
      usersByKey.set(key, set);
    }

    set.add(c);
  }

  return {
    compiled: {} as any,
    connections: connectionsMap,
    usersByKey,
    tagMembers: new Map<string, Set<RuntimeConnection>>(),

    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platform: {},
    getStorage: () => baseStorage(),
    getStorageView: () => baseStorage(),
    scheduleTask: vi.fn(),
    cancelScheduled: vi.fn(),
    broadcastToConnections: vi.fn(),
    sendThroughPipeline: vi.fn(() => true),
    broadcastToChannel: vi.fn(),
    getChannelMembers: vi.fn(() => []),
    kickChannelMembers: vi.fn(async () => {}),
    channelContext: { buildChannelsApi, buildChannelFamilyExtra },
    resolveChannel: vi.fn(),
    sendReplay: vi.fn(),
    sendProtocolMessage: vi.fn(),
    persistAttachment: vi.fn(),
    toConnectionInfo: (c: RuntimeConnection) => ({
      id: c.id,
      userId: c.userId,
      meta: c.meta,
      tags: [],
      channels: [...c.channelMemberships.values()].map((m) => m.channelName),
      latency: c.latency,
      quality: c.quality,
      bufferedAmount: 0,
      ref: () => ({
        __livething: 'connection-ref' as const,
        id: c.id,
        instance: undefined,
        userId: c.userId,
      }),
    }),
    attachPluginApis: vi.fn(),
    contextExtenders: [],
    ...overrides,
  } as any;
}

describe('UserHandle.broadcast — fan-out', () => {
  function userIdsAndTargets(deps: any): Array<[string, string[]]> {
    return deps.broadcastToUser.mock.calls.map((call: any[]) => [
      call[1].userId,
      call[0].map((c: RuntimeConnection) => c.id),
    ]);
  }

  it('hands every live tab of the user to one user broadcast and returns its delivered count', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const other = createConnection('o1', 'bob');
    const deps = baseDeps([tab1, tab2, other], { broadcastToUser: vi.fn(() => 2) });
    const ctx = buildConnectionContext(deps, tab1);

    const delivered = ctx.users.get('alice').broadcast('ping', { n: 1 });

    expect(delivered).toBe(2);
    expect(deps.broadcastToUser).toHaveBeenCalledTimes(1);
    expect(deps.broadcastToUser.mock.calls[0][1]).toEqual({
      userId: 'alice',
      event: 'ping',
      payload: { n: 1 },
    });
    expect(new Set(userIdsAndTargets(deps)[0]![1])).toEqual(new Set(['t1', 't2']));
    expect(deps.sendThroughPipeline).not.toHaveBeenCalled();
  });

  it('returns the count the user broadcast actually delivered', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const deps = baseDeps([tab1, tab2], { broadcastToUser: vi.fn(() => 1) });
    const ctx = buildConnectionContext(deps, tab1);

    expect(ctx.users.get('alice').broadcast('ping', {})).toBe(1);
  });

  it('a user with no live connections still goes through the user broadcast, with no tabs', () => {
    const caller = createConnection('caller', 'u1');
    const deps = baseDeps([caller], { broadcastToUser: vi.fn(() => 0) });
    const ctx = buildConnectionContext(deps, caller);

    expect(ctx.users.get('ghost').broadcast('ping', {})).toBe(0);
    expect(userIdsAndTargets(deps)).toEqual([['ghost', []]]);
    expect(deps.sendThroughPipeline).not.toHaveBeenCalled();
  });

  it('ctx.user (self) is the same fan-out target as ctx.users.get(own id)', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const deps = baseDeps([tab1, tab2], { broadcastToUser: vi.fn(() => 2) });
    const ctx = buildConnectionContext(deps, tab1);

    expect(ctx.user.id).toBe('alice');
    expect(ctx.user.broadcast('ping', {})).toBe(2);
    expect(ctx.users.get('alice').broadcast('ping', {})).toBe(2);
    const [self, byId] = userIdsAndTargets(deps);
    expect(self![0]).toBe('alice');

    expect(new Set(self![1])).toEqual(new Set(byId![1]));
  });
});

describe('UserHandle.setMeta — applies to all live tabs', () => {
  it("merges the patch into every tab's meta and persists each one", () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    tab1.meta = { theme: 'dark' };
    tab2.meta = { theme: 'light' };
    const deps = baseDeps([tab1, tab2]);

    const ctx = buildConnectionContext(deps, tab1);

    ctx.users.get('alice').setMeta({ nickname: 'A' });

    expect(tab1.meta).toEqual({ theme: 'dark', nickname: 'A' });
    expect(tab2.meta).toEqual({ theme: 'light', nickname: 'A' });
    expect(deps.persistAttachment).toHaveBeenCalledWith(tab1);
    expect(deps.persistAttachment).toHaveBeenCalledWith(tab2);
  });
});

describe('UserHandle.close — closes every tab', () => {
  it('calls descriptor.close on every live connection for the user', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const other = createConnection('o1', 'bob');
    const deps = baseDeps([tab1, tab2, other]);
    const ctx = buildConnectionContext(deps, tab1);

    ctx.users.get('alice').close(4000, 'bye');

    expect(tab1.descriptor.close).toHaveBeenCalledWith(4000, 'bye');
    expect(tab2.descriptor.close).toHaveBeenCalledWith(4000, 'bye');
    expect(other.descriptor.close).not.toHaveBeenCalled();
  });
});

describe('UserHandle.info — no flat .meta', () => {
  it('is null for a user with no live connections', () => {
    const caller = createConnection('caller', 'u1');
    const deps = baseDeps([caller]);
    const ctx = buildConnectionContext(deps, caller);

    expect(ctx.users.get('ghost').info()).toBeNull();
  });

  it('reports connections(), channels, tags — and carries no flat .meta field', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const deps = baseDeps([tab1, tab2]);
    const ctx = buildConnectionContext(deps, tab1);

    const info = ctx.users.get('alice').info();

    expect(info).not.toBeNull();
    expect(info!.id).toBe('alice');
    expect(info!.connections()).toHaveLength(2);
    expect('meta' in (info as object)).toBe(false);
  });
});

describe('UserHandle.info — last-seen storage reads', () => {
  it('reads nothing until lastSeen() is called, then one row per call', () => {
    const reads: string[] = [];
    const sql = createTestSql({
      onExec: (query) => {
        if (query.includes('__livething_last_seen')) reads.push(query);
      },
    });
    ensureLastSeenSchema(sql);
    stampLastSeen(sql, { userId: 'alice', now: 1_000 });

    const tabs = Array.from({ length: 5 }, (_, i) => createConnection(`t${i}`, 'alice'));
    const deps = baseDeps(tabs, {
      toConnectionInfo: (c: RuntimeConnection) =>
        toConnectionInfo(c, undefined, {
          hibernationEnabled: false,
          lastSeenAt: (userId: string) => readLastSeen(sql, userId),
        }),
    });
    const ctx = buildConnectionContext(deps, tabs[0]!);

    reads.length = 0;
    const info = ctx.users.get('alice').info()!;
    const connections = info.connections();

    expect(reads).toHaveLength(0);
    expect(connections).toHaveLength(tabs.length);
    expect(info.lastSeen!()).toBe(1_000);
    expect(connections[3]!.lastSeen!()).toBe(1_000);
    expect(reads).toHaveLength(2);
  });
});

describe('UserHandle.info — tag collisions across colon-joined keys', () => {
  it('keeps two distinct tags whose group/key concatenation collides on the colon separator', () => {
    const tab = createConnection('t1', 'alice');
    tab.tags.ephemeral.set('a:b', new Set(['c']));
    tab.tags.ephemeral.set('a', new Set(['b:c']));
    const deps = baseDeps([tab], {
      toConnectionInfo: (c: RuntimeConnection) => toConnectionInfo(c, undefined),
    });
    const ctx = buildConnectionContext(deps, tab);

    const info = ctx.users.get('alice').info();

    expect(info!.tags).toHaveLength(2);
    expect(info!.tags).toEqual(
      expect.arrayContaining([
        { __livething: 'tag-ref', kind: 'ephemeral', group: 'a:b', key: 'c' },
        { __livething: 'tag-ref', kind: 'ephemeral', group: 'a', key: 'b:c' },
      ]),
    );
  });
});

describe('UserHandle.connections()', () => {
  it('returns a snapshot with one entry per live tab', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const deps = baseDeps([tab1, tab2]);
    const ctx = buildConnectionContext(deps, tab1);

    const snapshot = ctx.users.get('alice').connections();
    expect(snapshot.map((c) => c.id).sort()).toEqual(['t1', 't2']);
  });
});

describe('UserHandle.isOnline()', () => {
  function buildEngine(): Engine {
    let captured: Engine | undefined;
    const runAdapter = adapter({
      id: 'user-handle-spec',
      asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
      setup(createEngine) {
        captured = createEngine({
          storage: createTestStorage(),
          platform: {},
          timers: createTestTimers(),
          logger: { info() {}, warn() {}, error() {} },
        });
        return {};
      },
    });
    runAdapter(server({}).assemble({ handlers: [] }), undefined as never);
    if (!captured) throw new Error('engine not captured');

    return captured;
  }

  function openTab(engine: Engine, userId: string) {
    return engine.accept(Symbol(userId), {
      send() {},
      close() {},
      bufferedAmount: () => 0,
      userId,
    } as never);
  }

  it('is true while the user has an open tab and false once the last one closes', async () => {
    const engine = buildEngine();
    await engine.initialize();
    function alice() {
      return engine.admin().users.get('alice');
    }

    expect(alice().isOnline()).toBe(false);

    const tab1 = openTab(engine, 'alice');
    expect(alice().isOnline()).toBe(true);

    const tab2 = openTab(engine, 'alice');
    await tab1.handleClose(1000, '');
    expect(alice().isOnline()).toBe(true);

    await tab2.handleClose(1000, '');
    expect(alice().isOnline()).toBe(false);
  });

  it('is false for an anonymous ctx.user', () => {
    const anonymous = createConnection('anon', '');
    const ctx = buildConnectionContext(baseDeps([anonymous]), anonymous);

    expect(ctx.user.isOnline()).toBe(false);
  });
});
