import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { createTestSql } from '~/_test/sql.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineAccess } from '~/_engine/access.ts';
import type { LastSeenService } from '~/_engine/runtime/feature-slots.ts';
import { lastSeen } from './last-seen.ts';
import { ensureLastSeenSchema, readLastSeen, readLastSeenMany, stampLastSeen } from './storage.ts';
import type { LastSeenOptions } from './types.ts';

interface Captured {
  sql: ReturnType<typeof createTestSql>;
  connectHooks: Array<(ctx: unknown) => void>;
  disconnectHooks: Array<(ctx: unknown) => void>;
  messageActivityHooks: Array<(connectionId: string) => void>;
  contextExtenders: Array<() => Record<string, unknown>>;
  purgeUserHooks: Array<(core: unknown, userId: string) => void>;
  service?: LastSeenService;
  online: Set<string>;
  userIdByConnection: Map<string, string>;
}

function harness(options: LastSeenOptions = {}): Captured {
  const sql = createTestSql();
  const captured: Captured = {
    sql,
    connectHooks: [],
    disconnectHooks: [],
    messageActivityHooks: [],
    contextExtenders: [],
    purgeUserHooks: [],
    online: new Set(),
    userIdByConnection: new Map(),
  };

  const bootSchemaHooks: Array<() => void> = [];
  const engine = {
    installOnce: (_key: symbol, run: () => void) => run(),
    setLastSeenService: (service: LastSeenService) => {
      captured.service = service;
    },
    onBootSchema: (run: () => void) => bootSchemaHooks.push(run),
    onPurgeUser: (hook: (core: unknown, userId: string) => void) =>
      captured.purgeUserHooks.push(hook),
    extendContext: (factory: () => Record<string, unknown>) =>
      captured.contextExtenders.push(factory),
    onConnect: (hook: (ctx: unknown) => void) => captured.connectHooks.push(hook),
    onDisconnect: (hook: (ctx: unknown) => void) => captured.disconnectHooks.push(hook),
    onMessageActivity: (hook: (connectionId: string) => void) =>
      captured.messageActivityHooks.push(hook),
    storage: { sql },
    isUserOnline: (userId: string) => captured.online.has(userId),
    getConnectionIdentity: (connectionId: string) => captured.userIdByConnection.get(connectionId),
  } as unknown as EngineAccess;

  lastSeen(options).__setup!(engine as never);
  for (const run of bootSchemaHooks) run();

  return captured;
}

function ctxFor(userId: string) {
  return { [ENGINE_INTERNAL_CONNECTION]: { userId } };
}

describe('lastSeen storage', () => {
  it('stamps and reads a single user, never lowering an existing mark', () => {
    const sql = createTestSql();
    ensureLastSeenSchema(sql);

    stampLastSeen(sql, { userId: 'alice', now: 500 });
    expect(readLastSeen(sql, 'alice')).toBe(500);

    stampLastSeen(sql, { userId: 'alice', now: 300 });
    expect(readLastSeen(sql, 'alice')).toBe(500);

    stampLastSeen(sql, { userId: 'alice', now: 900 });
    expect(readLastSeen(sql, 'alice')).toBe(900);
  });

  it('reads many users in one call, keyed by user id', () => {
    const sql = createTestSql();
    ensureLastSeenSchema(sql);
    stampLastSeen(sql, { userId: 'alice', now: 1 });
    stampLastSeen(sql, { userId: 'bob', now: 2 });

    const map = readLastSeenMany(sql, ['alice', 'bob', 'carol']);
    expect(map.get('alice')).toBe(1);
    expect(map.get('bob')).toBe(2);
    expect(map.has('carol')).toBe(false);
  });
});

describe('lastSeen connection tracking', () => {
  it('stamps on connect and on disconnect', () => {
    const h = harness();
    expect(h.connectHooks).toHaveLength(1);
    expect(h.disconnectHooks).toHaveLength(1);

    vi.spyOn(Date, 'now').mockReturnValue(1000);
    h.connectHooks[0]!(ctxFor('alice'));
    expect(readLastSeen(h.sql, 'alice')).toBe(1000);

    Date.now = vi.fn().mockReturnValue(2000);
    h.disconnectHooks[0]!(ctxFor('alice'));
    expect(readLastSeen(h.sql, 'alice')).toBe(2000);
    vi.restoreAllMocks();
  });

  it('does not register an activity hook in connection mode', () => {
    const h = harness();
    expect(h.messageActivityHooks).toHaveLength(0);
  });

  it("registers a purgeUser hook that deletes one user's row, leaving another user's row intact", () => {
    const h = harness();
    expect(h.purgeUserHooks).toHaveLength(1);

    stampLastSeen(h.sql, { userId: 'alice', now: 1 });
    stampLastSeen(h.sql, { userId: 'bob', now: 2 });

    h.purgeUserHooks[0]!({ storage: { sql: h.sql } }, 'alice');

    expect(readLastSeen(h.sql, 'alice')).toBeNull();
    expect(readLastSeen(h.sql, 'bob')).toBe(2);
  });
});

describe('lastSeen activity mode', () => {
  it('stamps on activity, throttled per user', () => {
    const h = harness({ track: 'activity', throttleMs: 1000 });
    h.userIdByConnection.set('c1', 'alice');
    expect(h.messageActivityHooks).toHaveLength(1);
    const activity = h.messageActivityHooks[0]!;

    vi.spyOn(Date, 'now').mockReturnValue(0);
    activity('c1');
    expect(readLastSeen(h.sql, 'alice')).toBe(0);

    Date.now = vi.fn().mockReturnValue(500);
    activity('c1');
    expect(readLastSeen(h.sql, 'alice')).toBe(0);

    Date.now = vi.fn().mockReturnValue(1000);
    activity('c1');
    expect(readLastSeen(h.sql, 'alice')).toBe(1000);
    vi.restoreAllMocks();
  });

  it('throttles each user independently', () => {
    const h = harness({ track: 'activity', throttleMs: 1000 });
    h.userIdByConnection.set('c1', 'alice');
    h.userIdByConnection.set('c2', 'bob');
    const activity = h.messageActivityHooks[0]!;

    vi.spyOn(Date, 'now').mockReturnValue(100);
    activity('c1');
    activity('c2');
    expect(readLastSeen(h.sql, 'alice')).toBe(100);
    expect(readLastSeen(h.sql, 'bob')).toBe(100);

    vi.restoreAllMocks();
  });
});

describe('ctx.lastSeen surface', () => {
  it('exposes at / atMany / online', () => {
    const h = harness();
    h.online.add('alice');
    stampLastSeen(h.sql, { userId: 'alice', now: 7 });
    stampLastSeen(h.sql, { userId: 'bob', now: 8 });

    const surface = h.contextExtenders[0]!() as {
      lastSeen: {
        at(userId: string): number | null;
        atMany(userIds: string[]): Map<string, number>;
        online(userId: string): boolean;
      };
    };

    expect(surface.lastSeen.at('alice')).toBe(7);
    expect(surface.lastSeen.at('carol')).toBeNull();
    expect([...surface.lastSeen.atMany(['alice', 'bob'])]).toEqual([
      ['alice', 7],
      ['bob', 8],
    ]);
    expect(surface.lastSeen.online('alice')).toBe(true);
    expect(surface.lastSeen.online('bob')).toBe(false);
  });

  it('feeds the lastSeenService slot with durable at() and in-memory online()', () => {
    const h = harness();
    h.online.add('alice');
    stampLastSeen(h.sql, { userId: 'alice', now: 55 });

    expect(h.service).toBeDefined();
    expect(h.service!.at('alice')).toBe(55);
    expect(h.service!.online('alice')).toBe(true);
    expect(h.service!.online('bob')).toBe(false);
  });
});
