import { adapter } from '~/_adapters/define.ts';
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { channels } from '~/channel/capability.ts';
import {
  deleteDurableMembership,
  hasDurableMembership,
  persistMembership,
} from '~/channel/membership.ts';
import {
  addChannelMembership,
  hasChannelMembership,
  kickChannelMembers,
  leaveChannel,
} from '~/channel/runtime.ts';
import { ensureMembershipSchema, listMembershipsByUser } from '~/channel/storage.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContextFactory, SQLProvider } from '~/context.ts';
import type { ServerDefinition } from '~/server-definition.ts';

function makeCore(sql: SQLProvider): EngineCore {
  return {
    storage: { sql },
  } as unknown as EngineCore;
}

describe('durable membership user gate', () => {
  it('skips the durable write for an empty (anonymous) user id', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensureMembershipSchema(sql);
    statements = 0;

    persistMembership(makeCore(sql), { userId: '', channelName: 'room', channelFamily: null });
    expect(statements).toBe(0);
  });

  it('writes the durable row for a real user id', () => {
    const sql = createTestSql();
    ensureMembershipSchema(sql);

    persistMembership(makeCore(sql), {
      userId: 'user-1',
      channelName: 'room',
      channelFamily: null,
    });
    expect(
      hasDurableMembership(makeCore(sql), {
        userId: 'user-1',
        channelName: 'room',
        channelFamily: null,
      }),
    ).toBe(true);
  });

  it('skips the durable delete for an empty user id', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensureMembershipSchema(sql);
    statements = 0;

    deleteDurableMembership(makeCore(sql), {
      userId: '',
      channelName: 'room',
      channelFamily: null,
    });
    expect(statements).toBe(0);
  });

  it('reports no durable membership for an empty user id without querying', () => {
    let statements = 0;
    const sql = createTestSql({ onExec: () => (statements += 1) });
    ensureMembershipSchema(sql);
    statements = 0;

    const result = hasDurableMembership(makeCore(sql), {
      userId: '',
      channelName: 'room',
      channelFamily: null,
    });
    expect(result).toBe(false);
    expect(statements).toBe(0);
  });
});

describe('kick(userRef, { revoke: true })', () => {
  function userRef(id: string): { __wskit: 'user-ref'; id: string; instance: string | undefined } {
    return { __wskit: 'user-ref', id, instance: undefined };
  }

  function makeConnection(id: string, userId: string): RuntimeConnection {
    return {
      id,
      userId,
      wsKey: Symbol(id),
      descriptor: { send() {}, close() {}, bufferedAmount: () => 0, identity: userId },
      meta: {},
      tags: { ephemeral: new Map(), persistent: new Map() },
      channelMemberships: new Map(),
      latency: null,
      quality: 'good',
    };
  }

  const roomChannel = {
    key: 'room',
    kind: 'channel' as const,
    pattern: 'room',
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    intercepts: [],
  };

  function makeRuntime(
    channelMembers: Map<string, Set<RuntimeConnection>>,
    connections: Map<string, RuntimeConnection>,
    deleteDurableMembership: ReturnType<typeof vi.fn>,
  ) {
    return {
      compiled: { channels: new Map([['room', roomChannel]]), channelFamilies: new Map() },
      connections,
      channelMembers,
      checkHooks: new Map(),
      revalidateHooks: new Map(),
      commitHooks: new Map(),
      subscribeHooks: new Map(),
      unsubscribeHooks: new Map(),
      sessionEndHooks: new Map(),
      logger: { error: vi.fn() },
      toConnectionInfo: () => ({}) as unknown as ReturnType<typeof vi.fn>,
      buildConnectionContext: () => ({}),
      persistAttachment() {},
      sendProtocolMessage() {},
      broadcastToChannel() {},
      async handleValidationError() {},
      isChannelPersistent: () => true,
      persistMembership() {},
      deleteDurableMembership,
      hasDurableMembership: () => true,
    };
  }

  it('drops the durable row and makes the live socket leave', async () => {
    const connection = makeConnection('conn_1', 'user-1');
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    addChannelMembership(channelMembers, connection, { channelName: 'room', channelFamily: null });
    const deleteDurableMembership = vi.fn();
    const runtime = makeRuntime(
      channelMembers,
      new Map([[connection.id, connection]]),
      deleteDurableMembership,
    );

    await kickChannelMembers(
      {
        ...runtime,
        leaveChannel: (c: RuntimeConnection, opts: unknown) =>
          leaveChannel(runtime as never, c, opts as never),
      } as never,
      {
        channelName: 'room',
        channelFamily: null,
        target: userRef('user-1'),
        reason: 'revoked',
        revoke: true,
      },
    );

    expect(deleteDurableMembership).toHaveBeenCalledTimes(1);
    expect(connection.channelMemberships.size).toBe(0);
  });

  it('leaves a non-member connection of the same user id untouched', async () => {
    const connection = makeConnection('conn_1', 'user-1');
    // connection never joined 'room', so it is absent from the channelMembers index.
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const deleteDurableMembership = vi.fn();
    const runtime = makeRuntime(
      channelMembers,
      new Map([[connection.id, connection]]),
      deleteDurableMembership,
    );

    await kickChannelMembers(
      {
        ...runtime,
        leaveChannel: (c: RuntimeConnection, opts: unknown) =>
          leaveChannel(runtime as never, c, opts as never),
      } as never,
      {
        channelName: 'room',
        channelFamily: null,
        target: userRef('user-1'),
        reason: 'revoked',
        revoke: true,
      },
    );

    expect(deleteDurableMembership).not.toHaveBeenCalled();
  });
});

describe('durable membership is the channel default', () => {
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

  function makeHandler(channelConfig: { persistent?: boolean } = {}): ServerDefinition {
    const base = define({ env: t<Record<string, never>>(), capabilities: [channels()] });
    const room = base.channel('room', channelConfig);
    const noop = room.on('noop', { run() {} });
    return base.assemble({ handlers: [noop] });
  }

  /** Connect one user, wait for connect + auto-rejoin to settle, and return the live connection. */
  async function connectUser(engine: Engine, identity: string) {
    const before = new Set(engine.core.connections.keys());
    const handle = engine.accept(Symbol(identity || 'anon'), {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount: () => 0,
      identity,
    });
    const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
    await connection.lifecycleReady;
    return { handle, connection };
  }

  async function subscribeToRoom(handle: ReturnType<Engine['accept']>): Promise<void> {
    await handle.handleMessage(
      JSON.stringify({
        event: '__subscribe__',
        payload: {},
        __wskit: { channel: 'room', channelFamily: null },
      }),
    );
  }

  it('writes a membership row on subscribe when no `persistent` setting is given', async () => {
    const { engine, sql } = await buildEngine(makeHandler());
    const { handle } = await connectUser(engine, 'alice');

    await subscribeToRoom(handle);

    const rows = listMembershipsByUser(sql, 'alice');
    expect(rows).toEqual([expect.objectContaining({ channelName: 'room', channelFamily: null })]);
  });

  it('auto-rejoins the user into that channel after a reconnect', async () => {
    const handler = makeHandler();
    const { engine, sql } = await buildEngine(handler);
    const { handle: firstHandle } = await connectUser(engine, 'alice');
    await subscribeToRoom(firstHandle);
    expect(listMembershipsByUser(sql, 'alice')).toHaveLength(1);

    // A fresh connection for the same user, with no client-side subscribe —
    // any membership must come from the engine's own auto-rejoin.
    const { connection: second } = await connectUser(engine, 'alice');

    expect(hasChannelMembership(second, 'room', null)).toBe(true);
  });

  it('writes no row and does not rejoin when the channel opts out with `persistent: false`', async () => {
    const handler = makeHandler({ persistent: false });
    const { engine, sql } = await buildEngine(handler);
    const { handle: firstHandle } = await connectUser(engine, 'alice');
    await subscribeToRoom(firstHandle);

    expect(listMembershipsByUser(sql, 'alice')).toHaveLength(0);

    const { connection: second } = await connectUser(engine, 'alice');
    expect(hasChannelMembership(second, 'room', null)).toBe(false);
  });

  it('writes no row for an anonymous connection even on a default (persistent) channel', async () => {
    const { engine, sql } = await buildEngine(makeHandler());
    const { handle } = await connectUser(engine, '');

    await subscribeToRoom(handle);

    expect(listMembershipsByUser(sql, '')).toHaveLength(0);
  });
});
