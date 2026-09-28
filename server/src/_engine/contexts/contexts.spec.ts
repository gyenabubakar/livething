/* oxlint-disable @typescript-eslint/no-explicit-any */
import { buildConnectionContext } from '~/_engine/contexts/contexts.ts';
import { ensureConnectionSchema, readConnectionRow } from '~/_engine/runtime/connection-store.ts';
import { acceptConnection, handleConnectionClose } from '~/_engine/runtime/connection.ts';
import { persistAttachment } from '~/_engine/runtime/hibernation.ts';
import { createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { buildChannelFamilyExtra, buildChannelsApi } from '~/channel/context.ts';
import { CrossInstanceRef } from '~/errors/errors.ts';
import { createInitContext, createShutdownContext } from '~/lifecycle/context.ts';
import { createTaskContext } from '~/scheduled/context.ts';
import { describe, expect, it, vi } from 'vitest';
import type { EngineCore } from '~/_engine/core.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type {
  AdminContext,
  ConnectionContext,
  InitContext,
  ShutdownContext,
  TaskContext,
} from '~/context.ts';

function createConnection(id: string, userId: string = id): RuntimeConnection {
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
      userId,
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

function baseDeps(overrides: Record<string, unknown> = {}) {
  const deps = {
    compiled: {} as any,
    connections: new Map<string, RuntimeConnection>(),
    usersByKey: new Map<string, Set<RuntimeConnection>>(),
    tagMembers: new Map<string, Set<RuntimeConnection>>(),

    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platform: {},
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
    resolveChannel: vi.fn((target: any) =>
      typeof target === 'string'
        ? { channelName: target }
        : { channelName: target.name, channelFamily: target.family },
    ),
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
  deps.broadcastToUser ??= userFanOut(deps);
  return deps;
}

/** Stand-in for the real user fan-out: one pipeline send per tab, nobody for an empty id. */
function userFanOut(deps: { sendThroughPipeline: (...args: any[]) => boolean }) {
  return vi.fn(
    (
      connections: RuntimeConnection[],
      opts: { userId: string; event: string; payload: unknown },
    ) =>
      opts.userId
        ? connections.filter((c) =>
            deps.sendThroughPipeline(c, {
              routing: undefined,
              event: opts.event,
              payload: opts.payload,
            }),
          ).length
        : 0,
  );
}

function localRef(id: string) {
  return { __livething: 'connection-ref' as const, id, instance: undefined, userId: id };
}

describe('ctx.user / ctx.users — anonymous connections', () => {
  // `usersByKey` is built by the real runtime (`_engine/runtime/connection.ts`),
  // which never indexes an anonymous connection (empty `userId`) under any
  // key. These tests pass an empty `usersByKey` to match that real behaviour,
  // rather than reimplementing the indexing logic here.

  it("ctx.user.id for an anonymous connection matches its honest ConnectionInfo.userId ('')", () => {
    const anon = createConnection('conn_1', '');
    const deps = baseDeps({
      connections: new Map([[anon.id, anon]]),
      usersByKey: new Map(),
    });

    const ctx = buildConnectionContext(deps, anon);
    const info = deps.toConnectionInfo(anon);

    expect(info.userId).toBe('');
    expect((ctx as any).user.id).toBe(info.userId);
  });

  it('ctx.user for an anonymous connection addresses no live connection, not even itself', () => {
    const anon = createConnection('conn_1', '');
    const sendThroughPipeline = vi.fn(() => true);
    const deps = baseDeps({
      connections: new Map([[anon.id, anon]]),
      usersByKey: new Map(),
      sendThroughPipeline,
    });

    const ctx = buildConnectionContext(deps, anon);

    expect((ctx as any).user.broadcast('ping', {})).toBe(0);
    expect((ctx as any).user.connections()).toEqual([]);
    expect((ctx as any).user.info()).toBeNull();
    expect(sendThroughPipeline).not.toHaveBeenCalled();
  });

  it('ctx.users.get(c.userId) reaches nobody for an anonymous connection, closing the fan-out gap', () => {
    const anon = createConnection('conn_1', '');
    const sendThroughPipeline = vi.fn(() => true);
    const deps = baseDeps({
      connections: new Map([[anon.id, anon]]),
      usersByKey: new Map(),
      sendThroughPipeline,
    });

    const ctx = buildConnectionContext(deps, anon);
    // Mirrors `for (const c of ctx.connections.all()) ctx.users.get(c.userId).broadcast(...)`.
    const info = ctx.connections.all()[0]!;
    const delivered = (ctx as any).users.get(info.userId).broadcast('ping', {});

    expect(delivered).toBe(0);
    expect(sendThroughPipeline).not.toHaveBeenCalled();
  });

  it('two independent anonymous connections never reach each other through ctx.user or ctx.users', () => {
    const anonA = createConnection('conn_a', '');
    const anonB = createConnection('conn_b', '');
    const sendThroughPipeline = vi.fn(() => true);
    const deps = baseDeps({
      connections: new Map([
        [anonA.id, anonA],
        [anonB.id, anonB],
      ]),
      usersByKey: new Map(),
      sendThroughPipeline,
    });

    const ctxA = buildConnectionContext(deps, anonA);
    expect((ctxA as any).user.broadcast('ping', {})).toBe(0);
    expect((ctxA as any).users.get('').broadcast('ping', {})).toBe(0);
    expect(sendThroughPipeline).not.toHaveBeenCalled();
  });

  it('an identified connection is reachable through ctx.user and ctx.users', () => {
    const alice1 = createConnection('conn_1', 'alice');
    const sendThroughPipeline = vi.fn(() => true);
    const deps = baseDeps({
      connections: new Map([[alice1.id, alice1]]),
      usersByKey: new Map([['alice', new Set([alice1])]]),
      sendThroughPipeline,
    });

    const ctx = buildConnectionContext(deps, alice1);

    expect((ctx as any).user.id).toBe('alice');
    expect((ctx as any).user.broadcast('ping', {})).toBe(1);
    expect((ctx as any).users.get('alice').broadcast('ping', {})).toBe(1);
    expect(sendThroughPipeline).toHaveBeenCalledTimes(2);
  });
});

describe('usersByKey fan-out index — anonymous connections', () => {
  // Exercises the real `acceptConnection` / `handleConnectionClose` from
  // `_engine/runtime/connection.ts`, which build the `usersByKey` index that
  // `ctx.user` / `ctx.users` reads.

  let idCounter: number;
  function makeConnectionRuntime(
    usersByKey: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>,
  ) {
    idCounter = 0;
    return {
      compiled: {} as any,
      connections: new Map<string, EngineRuntimeTypes.RuntimeConnection>(),
      usersByKey,
      channelMembers: new Map(),
      tagMembers: new Map(),
      wsToConnectionId: new Map(),
      generateId: (prefix?: string) => `${prefix ?? 'id'}_${++idCounter}`,
      persistAttachment: vi.fn(),
      buildConnectionContext: vi.fn(() => ({})),
      runConnectionLifecycle: vi.fn(async () => {}),
      processTextMessage: vi.fn(async () => {}),
      handleConnectionClose: vi.fn(async () => {}),
      handleRuntimeError: vi.fn(async () => {}),
      cancelActiveStreamsForConnection: vi.fn(async () => {}),
      leaveChannel: vi.fn(async () => {}),
    } as any;
  }

  function descriptor(userId: string) {
    return {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount: () => 0,
      userId,
    };
  }

  it('never indexes an anonymous connection under any key', () => {
    const usersByKey = new Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>();
    const runtime = makeConnectionRuntime(usersByKey);

    acceptConnection(runtime, Symbol('ws'), descriptor(''));

    expect(usersByKey.size).toBe(0);
  });

  it('two anonymous connections never share a usersByKey entry', () => {
    const usersByKey = new Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>();
    const runtime = makeConnectionRuntime(usersByKey);

    acceptConnection(runtime, Symbol('ws-1'), descriptor(''));
    acceptConnection(runtime, Symbol('ws-2'), descriptor(''));

    expect(usersByKey.size).toBe(0);
    expect(runtime.connections.size).toBe(2);
  });

  it('an identified connection still indexes under its real user id', () => {
    const usersByKey = new Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>();
    const runtime = makeConnectionRuntime(usersByKey);

    acceptConnection(runtime, Symbol('ws'), descriptor('alice'));

    expect([...usersByKey.keys()]).toEqual(['alice']);
    expect(usersByKey.get('alice')!.size).toBe(1);
  });

  it('closing an anonymous connection is a no-op on usersByKey', async () => {
    const usersByKey = new Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>();
    const runtime = makeConnectionRuntime(usersByKey);

    acceptConnection(runtime, Symbol('ws'), descriptor(''));
    const connection = [...runtime.connections.values()][0]!;
    await connection.lifecycleReady;

    await expect(
      handleConnectionClose(runtime, { connection, code: 1000, reason: 'bye' }),
    ).resolves.not.toThrow();

    expect(usersByKey.size).toBe(0);
  });

  it('closing an identified connection removes it from usersByKey', async () => {
    const usersByKey = new Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>();
    const runtime = makeConnectionRuntime(usersByKey);

    acceptConnection(runtime, Symbol('ws'), descriptor('alice'));
    const connection = [...runtime.connections.values()][0]!;
    await connection.lifecycleReady;

    await handleConnectionClose(runtime, { connection, code: 1000, reason: 'bye' });

    expect(usersByKey.has('alice')).toBe(false);
  });
});

describe('ctx.connections.get(ref).send', () => {
  it('returns false and logs when the target id is not in the connection map', () => {
    const connection = createConnection('conn_1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
    });

    const ctx = buildConnectionContext(deps, connection);
    const result = ctx.connections.get(localRef('nonexistent-id')).send('evt', {});

    expect(result).toBe(false);
    expect(deps.sendThroughPipeline).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[livething] ctx.connections.get(ref).send target not found',
      {
        connectionId: 'nonexistent-id',
        event: 'evt',
      },
    );
  });

  it('task context connections.get(ref).send returns false for unknown ids', () => {
    const deps = baseDeps();
    const task = createTaskContext(deps);

    expect(task.connections.get(localRef('missing')).send('evt', {})).toBe(false);
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[livething] ctx.connections.get(ref).send target not found',
      {
        connectionId: 'missing',
        event: 'evt',
      },
    );
  });

  it('returns the pipeline result and routes to the addressed connection when it exists', () => {
    const self = createConnection('self');
    const peer = createConnection('peer');
    const deps = baseDeps({
      connections: new Map([
        [self.id, self],
        [peer.id, peer],
      ]),
    });

    const ctx = buildConnectionContext(deps, self);
    expect(ctx.connections.get(localRef('peer')).send('evt', { text: 'hi' })).toBe(true);
    expect(deps.sendThroughPipeline).toHaveBeenCalledWith(peer, {
      routing: undefined,
      event: 'evt',
      payload: { text: 'hi' },
    });
  });

  it('throws the cross-instance error when the ref names another instance', () => {
    const self = createConnection('self');
    const deps = baseDeps({
      connections: new Map([[self.id, self]]),
      instanceId: 'engine-a',
    });

    const ctx = buildConnectionContext(deps, self);
    const foreign = {
      __livething: 'connection-ref' as const,
      id: 'peer',
      instance: 'engine-b',
      userId: 'peer',
    };

    try {
      ctx.connections.get(foreign).send('evt', {});
      throw new Error('expected a cross-instance ref error');
    } catch (error) {
      expect(CrossInstanceRef.matches(error)).toBe(true);
      expect((error as ReturnType<typeof CrossInstanceRef>).detail).toEqual({
        operation: 'ctx.connections.get(ref).send',
        targetInstance: 'engine-b',
        engineInstance: 'engine-a',
      });
    }
  });
});

describe('ctx.cancelScheduled', () => {
  it('logs an error when a task context cancellation matches no runs', () => {
    const deps = baseDeps({
      cancelScheduled: vi.fn(() => ({ taskExists: true, removed: 0 })),
    });
    const task = createTaskContext(deps);

    task.cancelScheduled('cleanup', { label: 'drop' });

    expect(deps.cancelScheduled).toHaveBeenCalledWith('cleanup', { label: 'drop' });
    expect(deps.logger.error).toHaveBeenCalledWith('[livething] cancelScheduled matched no runs', {
      taskId: 'cleanup',
      filter: { label: 'drop' },
      taskExists: true,
    });
  });
});

describe('connection context alarms', () => {
  it('does not expose the adapter alarm writer to product handlers', () => {
    const connection = createConnection('c1');
    const deps = baseDeps({ connections: new Map([[connection.id, connection]]) });

    const ctx = buildConnectionContext(deps, connection);

    expect('setAlarm' in ctx).toBe(false);
    expect((ctx as Record<string, unknown>).setAlarm).toBeUndefined();

    type HasAlarmWriter<T> = 'setAlarm' extends keyof T ? true : false;
    const publicContextsExposeAlarm = [
      false satisfies HasAlarmWriter<ConnectionContext>,
      false satisfies HasAlarmWriter<InitContext>,
      false satisfies HasAlarmWriter<ShutdownContext>,
      false satisfies HasAlarmWriter<TaskContext>,
      false satisfies HasAlarmWriter<AdminContext>,
    ] as const;

    expect(publicContextsExposeAlarm).toEqual([false, false, false, false, false]);
  });
});

describe('ctx.broadcast includeSelf', () => {
  it('skips self by default (no options passed)', () => {
    const self = createConnection('self');
    const peer = createConnection('peer');
    const broadcastToConnections = vi.fn();
    const deps = baseDeps({
      connections: new Map([
        [self.id, self],
        [peer.id, peer],
      ]),
      broadcastToConnections,
    });

    const ctx = buildConnectionContext(deps, self);
    ctx.broadcast('message', { text: 'hello' });

    const [conns, opts] = broadcastToConnections.mock.calls[0]!;
    expect([...(conns as Iterable<unknown>)]).toEqual([self, peer]);
    expect(opts).toEqual({
      event: 'message',
      payload: { text: 'hello' },
      options: undefined,
      excludeConnectionId: 'self',
    });
  });

  it('includes self when includeSelf is true', () => {
    const self = createConnection('self');
    const peer = createConnection('peer');
    const broadcastToConnections = vi.fn();
    const deps = baseDeps({
      connections: new Map([
        [self.id, self],
        [peer.id, peer],
      ]),
      broadcastToConnections,
    });

    const ctx = buildConnectionContext(deps, self);
    ctx.broadcast('message', { text: 'hello' }, { includeSelf: true });

    const [conns, opts] = broadcastToConnections.mock.calls[0]!;
    expect([...(conns as Iterable<unknown>)]).toEqual([self, peer]);
    expect(opts).toEqual({
      event: 'message',
      payload: { text: 'hello' },
      options: { includeSelf: true },
      excludeConnectionId: 'self',
    });
  });
});

describe('extendContext last-wins ordering', () => {
  it('the last registered context extender overrides earlier ones for the same key', () => {
    const connection = createConnection('c1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      contextExtenders: [() => ({ customKey: 'first' }), () => ({ customKey: 'second' })],
    });

    const ctx = buildConnectionContext(deps, connection);
    expect((ctx as any).customKey).toBe('second');
  });
});

describe('ctx.channel.send', () => {
  it('routes through sendThroughPipeline and does not call broadcastToChannel', () => {
    const connection = createConnection('c1');
    const sendThroughPipeline = vi.fn(() => true);
    const broadcastToChannel = vi.fn();
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      sendThroughPipeline,
      broadcastToChannel,
    });

    const scope = {
      channel: {
        kind: 'channel' as const,
        key: 'rooms',
        pattern: 'general',
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        cursorStreams: new Map(),
        recordedStreams: new Map(),
        intercepts: [],
      } as any,
      channelName: 'general',
      channelFamily: 'rooms',
    };

    const ctx = buildConnectionContext(deps, connection, scope);
    (ctx as any).channel.send('greeting', { msg: 'hi' });

    expect(sendThroughPipeline).toHaveBeenCalledWith(connection, {
      routing: { channel: 'general', channelFamily: 'rooms' },
      event: 'greeting',
      payload: { msg: 'hi' },
    });
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });
});

describe('ctx.channels.get(name).members()', () => {
  it('returns the ConnectionInfo array from getChannelMembers, scoped to the resolved channel', () => {
    const connection = createConnection('c1');
    const memberInfo = {
      id: 'c2',
      userId: 'c2',
      meta: {},
      tags: [],
      channels: [],
      latency: null,
      quality: 'good' as const,
      bufferedAmount: 0,
      ref: () => ({
        __livething: 'connection-ref' as const,
        id: 'c2',
        instance: undefined,
        userId: 'c2',
      }),
    };

    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      getChannelMembers: vi.fn(() => [memberInfo]),
    });

    const ctx = buildConnectionContext(deps, connection);
    const members = (ctx as any).channels.get('room').members();

    expect(members).toEqual([memberInfo]);
    expect(deps.getChannelMembers).toHaveBeenCalledWith('room', undefined);
  });

  it('throws ChannelNotFound when the channel does not resolve', () => {
    const connection = createConnection('c1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      resolveChannel: vi.fn(() => undefined),
    });

    const ctx = buildConnectionContext(deps, connection);
    expect(() => (ctx as any).channels.get('missing')).toThrow();
  });

  it('routes get(family, name) to the family scope and validates the pattern via resolveChannel', () => {
    const connection = createConnection('c1');
    const memberInfo = {
      id: 'c2',
      userId: 'c2',
      meta: {},
      tags: [],
      channels: [],
      latency: null,
      quality: 'good' as const,
      bufferedAmount: 0,
      ref: () => ({
        __livething: 'connection-ref' as const,
        id: 'c2',
        instance: undefined,
        userId: 'c2',
      }),
    };

    const resolveChannel = vi.fn((target: any) =>
      typeof target === 'string'
        ? undefined
        : { channelName: target.name, channelFamily: target.family, params: {} },
    );
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      getChannelMembers: vi.fn(() => [memberInfo]),
      resolveChannel,
    });

    const ctx = buildConnectionContext(deps, connection);
    const members = (ctx as any).channels.get('publicRooms', 'room:42').members();

    expect(members).toEqual([memberInfo]);
    expect(resolveChannel).toHaveBeenCalledWith({ family: 'publicRooms', name: 'room:42' });
    expect(deps.getChannelMembers).toHaveBeenCalledWith('room:42', 'publicRooms');
  });

  it('resolves get(channelDecl) by the declaration key (static channel)', () => {
    const connection = createConnection('c1');
    const resolveChannel = vi.fn((target: any) =>
      target === 'lobby' ? { channelName: 'lobby', channelFamily: null, params: {} } : undefined,
    );
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      getChannelMembers: vi.fn(() => []),
      resolveChannel,
    });

    const ctx = buildConnectionContext(deps, connection);
    (ctx as any).channels.get({ __livethingChannel: true, __key: 'lobby' }).members();

    expect(resolveChannel).toHaveBeenCalledWith('lobby');
    expect(deps.getChannelMembers).toHaveBeenCalledWith('lobby', null);
  });

  it("resolves get(family.at(params)) via the ref's family + concrete name", () => {
    const connection = createConnection('c1');
    const resolveChannel = vi.fn((target: any) =>
      typeof target === 'object'
        ? { channelName: target.name, channelFamily: target.family, params: { id: 'general' } }
        : undefined,
    );
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      getChannelMembers: vi.fn(() => []),
      resolveChannel,
    });

    const ctx = buildConnectionContext(deps, connection);
    (ctx as any).channels
      .get({ __livethingChannelRef: true, family: 'rooms', name: 'room:general' })
      .members();

    expect(resolveChannel).toHaveBeenCalledWith({ family: 'rooms', name: 'room:general' });
    expect(deps.getChannelMembers).toHaveBeenCalledWith('room:general', 'rooms');
  });

  it('kick on the handle is awaitable and forwards scope to kickChannelMembers', async () => {
    const connection = createConnection('c1');
    const kickChannelMembers = vi.fn(async () => {});
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      kickChannelMembers,
    });

    const ctx = buildConnectionContext(deps, connection);
    await (ctx as any).channels.get('room').kick('banned', { reason: 'spam', revoke: true });

    expect(kickChannelMembers).toHaveBeenCalledWith({
      channelName: 'room',
      target: 'banned',
      reason: 'spam',
      revoke: true,
      channelFamily: undefined,
    });
  });
});

describe('ctx.log', () => {
  it('connection ctx.log forwards info/warn/error to the adapter logger', () => {
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const connection = createConnection('c1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      logger: { info, warn, error },
    });

    const ctx = buildConnectionContext(deps, connection);
    (ctx as any).log.info('hello', { id: 1 });
    (ctx as any).log.warn('careful');
    (ctx as any).log.error('boom', new Error('x'));

    expect(info).toHaveBeenCalledWith('hello', { id: 1 });
    expect(warn).toHaveBeenCalledWith('careful');
    expect(error).toHaveBeenCalledWith('boom', new Error('x'));
  });

  it('task ctx.log forwards to the adapter logger', () => {
    const info = vi.fn();
    const deps = baseDeps({ logger: { info, warn: vi.fn(), error: vi.fn() } });
    const task = createTaskContext(deps);

    (task as any).log.info('scheduled tick', { task: 'cleanup' });

    expect(info).toHaveBeenCalledWith('scheduled tick', { task: 'cleanup' });
  });
});

describe('persistAttachment', () => {
  function fakeCore(overrides: Partial<EngineCore> = {}): EngineCore {
    const sql = createTestSql();
    ensureConnectionSchema(sql);
    return {
      hibernationEnabled: true,
      storage: { sql },
      asyncContext: undefined,
      options: {},
      ...overrides,
    } as unknown as EngineCore;
  }

  it('writes the full connection row to storage and calls the adapter cheap persist hook', () => {
    const persist = vi.fn();
    const core = fakeCore({
      options: { hibernation: { persist, restore: () => undefined } } as never,
    });
    const connection = createConnection('c1');
    connection.wsKey = Symbol('ws') as unknown as RuntimeConnection['wsKey'];
    connection.meta = { username: 'user1' };

    connection.tags.ephemeral.set('role', new Set(['vip']));
    connection.channelMemberships.set('rooms::room:general', {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });
    connection.activeStreamIds = new Set(['stream_1']);

    persistAttachment(core, connection);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(connection.wsKey, { id: 'c1' });

    const row = readConnectionRow(core.storage.sql, 'c1');
    expect(row).toEqual({
      connection_id: 'c1',
      user_id: 'c1',
      meta: { username: 'user1' },
      ephemeral_tags: [{ group: 'role', key: 'vip' }],
      ephemeral_memberships: [{ channelName: 'room:general', channelFamily: 'rooms' }],
      active_stream_ids: ['stream_1'],
      translator_state: undefined,
      metadata: {},
    });
  });

  it('still writes the row when the adapter does not provide a hibernation API', () => {
    const core = fakeCore();
    const connection = createConnection('c2');
    connection.wsKey = Symbol('ws') as unknown as RuntimeConnection['wsKey'];

    expect(() => persistAttachment(core, connection)).not.toThrow();
    expect(readConnectionRow(core.storage.sql, 'c2')).not.toBeNull();
  });

  it('no-ops when hibernation is not enabled', () => {
    const core = fakeCore({ hibernationEnabled: false });
    const connection = createConnection('c3');
    connection.wsKey = Symbol('ws') as unknown as RuntimeConnection['wsKey'];

    persistAttachment(core, connection);

    expect(readConnectionRow(core.storage.sql, 'c3')).toBeNull();
  });
});

describe('storage view in init/shutdown/task contexts', () => {
  function makeShutdownDeps(getStorage: () => any) {
    return {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      platform: {},
      getStorage,
      getStorageView: getStorage,
      getTimers: () => createTestTimers(),
      scheduleTask: vi.fn(),
      cancelScheduled: vi.fn(() => ({ taskExists: true, removed: 1 })),
      broadcastToConnections: vi.fn(),
      sendThroughPipeline: vi.fn(() => true),
      broadcastToChannel: vi.fn(),
      getChannelMembers: vi.fn(() => []),
      kickChannelMembers: vi.fn(),
      sendReplay: vi.fn(),
      sendProtocolMessage: vi.fn(),
      persistAttachment: vi.fn(),
      toConnectionInfo: (c: any) => c,
      attachPluginApis: vi.fn(),
      connections: new Map<string, RuntimeConnection>(),
      contextExtenders: [],
    } as any;
  }

  it('init ctx.sql.exec forwards calls to the real provider', () => {
    const realSqlExec = vi.fn(() => ({ toArray: () => [], one: () => null, raw: () => [] }));
    const ctx = createInitContext(
      makeShutdownDeps(() => ({
        sql: { exec: realSqlExec, transaction: vi.fn() },
        kv: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), list: vi.fn() },
      })),
    );
    ctx.sql.exec('SELECT 1', 1, 2);
    expect(realSqlExec).toHaveBeenCalledWith('SELECT 1', 1, 2);
  });

  it('shutdown ctx.sql.exec forwards calls to the real provider', () => {
    const realSqlExec = vi.fn(() => ({ toArray: () => [], one: () => null, raw: () => [] }));
    const ctx = createShutdownContext(
      makeShutdownDeps(() => ({
        sql: { exec: realSqlExec, transaction: vi.fn() },
        kv: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), list: vi.fn() },
      })),
    );
    ctx.sql.exec('SELECT 1', 1, 2);
    expect(realSqlExec).toHaveBeenCalledWith('SELECT 1', 1, 2);
  });

  it('task ctx.sql.exec forwards calls to the real provider', () => {
    const realSqlExec = vi.fn(() => ({ toArray: () => [], one: () => null, raw: () => [] }));
    const ctx = createTaskContext(
      makeShutdownDeps(() => ({
        sql: { exec: realSqlExec, transaction: vi.fn() },
        kv: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), list: vi.fn() },
      })),
    );
    ctx.sql.exec('SELECT 1', 1, 2);
    expect(realSqlExec).toHaveBeenCalledWith('SELECT 1', 1, 2);
  });
});

describe('contextExtenders', () => {
  it('preserves getters returned by an extender as live reads', () => {
    const connection = createConnection('conn_1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      contextExtenders: [
        () => ({
          get live() {
            return connection.latency;
          },
        }),
      ],
    });

    const ctx = buildConnectionContext(deps, connection) as any;
    expect(ctx.live).toBeNull();
    connection.latency = 7;
    expect(ctx.live).toBe(7);
  });
});
