/* oxlint-disable @typescript-eslint/no-explicit-any */
import { buildConnectionContext } from '~/_engine/contexts/contexts.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { buildChannelFamilyExtra, buildChannelsApi } from '~/channel/context.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string, userId: string): RuntimeConnection {
  return {
    id,
    userId,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount() {
        return 0;
      },
      identity: userId,
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
    env: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platform: {},
    waitUntilImpl: vi.fn(),
    getStorage: () => baseStorage(),
    getStorageView: () => baseStorage(),
    getTimers: () => createTestTimers(),
    scheduleTask: vi.fn(),
    cancelScheduled: vi.fn(() => ({ taskExists: true, removed: 1 })),
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
        __wskit: 'connection-ref' as const,
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

describe('UserHandle.send — fan-out', () => {
  it('reaches every live tab and returns the delivered-socket count', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const other = createConnection('o1', 'bob');
    const deps = baseDeps([tab1, tab2, other]);
    const ctx = buildConnectionContext(deps, tab1);

    const delivered = ctx.users.get('alice').send('ping', { n: 1 });

    expect(delivered).toBe(2);
    const targets = deps.sendThroughPipeline.mock.calls.map((call: any[]) => call[0].id);
    expect(new Set(targets)).toEqual(new Set(['t1', 't2']));
  });

  it('counts only the tabs the pipeline actually delivered to', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const deps = baseDeps([tab1, tab2], {
      sendThroughPipeline: vi.fn((conn: RuntimeConnection) => conn.id === 't1'),
    });
    const ctx = buildConnectionContext(deps, tab1);

    expect(ctx.users.get('alice').send('ping', {})).toBe(1);
  });

  it('a user with no live connections delivers to 0 and touches nothing', () => {
    const caller = createConnection('caller', 'u1');
    const deps = baseDeps([caller]);
    const ctx = buildConnectionContext(deps, caller);

    expect(ctx.users.get('ghost').send('ping', {})).toBe(0);
    expect(deps.sendThroughPipeline).not.toHaveBeenCalled();
  });

  it('ctx.user (self) is the same fan-out target as ctx.users.get(own id)', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const deps = baseDeps([tab1, tab2]);
    const ctx = buildConnectionContext(deps, tab1);

    expect(ctx.user.id).toBe('alice');
    expect(ctx.user.send('ping', {})).toBe(2);
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

  it('reports online, connections(), channels, tags — and carries no flat .meta field', () => {
    const tab1 = createConnection('t1', 'alice');
    const tab2 = createConnection('t2', 'alice');
    const deps = baseDeps([tab1, tab2]);
    const ctx = buildConnectionContext(deps, tab1);

    const info = ctx.users.get('alice').info();

    expect(info).not.toBeNull();
    expect(info!.id).toBe('alice');
    expect(info!.online).toBe(true);
    expect(info!.connections()).toHaveLength(2);
    expect('meta' in (info as object)).toBe(false);
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
