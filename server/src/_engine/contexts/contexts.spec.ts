/* oxlint-disable @typescript-eslint/no-explicit-any */
import { buildConnectionContext } from '~/_engine/contexts/contexts.ts';
import { buildChannelFamilyExtra, buildChannelsApi } from '~/channel/context.ts';
import { createInitContext, createShutdownContext } from '~/lifecycle/context.ts';
import { persistAttachment } from '~/persistence/context.ts';
import { createTaskContext } from '~/scheduled/context.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    userId: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount() {
        return 0;
      },
      identity: id,
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
  return {
    compiled: {} as any,
    connections: new Map<string, RuntimeConnection>(),
    usersByKey: new Map<string, Set<RuntimeConnection>>(),
    tagMembers: new Map<string, Set<RuntimeConnection>>(),
    env: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platform: {},
    waitUntilImpl: vi.fn(),
    requireStorage: () => baseStorage(),
    getTimers: () => undefined,
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

function localRef(id: string) {
  return { __wskit: 'connection-ref' as const, id, instance: undefined, userId: id };
}

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
      '[wskit] ctx.connection(ref).send target not found',
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
      '[wskit] ctx.connection(ref).send target not found',
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
      __wskit: 'connection-ref' as const,
      id: 'peer',
      instance: 'engine-b',
      userId: 'peer',
    };
    expect(() => ctx.connections.get(foreign).send('evt', {})).toThrow(
      '[wskit] ctx.connection(ref).send targets instance "engine-b" but this engine is "engine-a" — ' +
        'cross-instance routing requires a broker, which is not configured yet.',
    );
  });
});

describe('ctx.waitUntil', () => {
  it('delegates to the adapter-provided waitUntil implementation', () => {
    const waitUntilImpl = vi.fn();
    const connection = createConnection('c1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      waitUntilImpl,
    });

    const ctx = buildConnectionContext(deps, connection);
    const task = Promise.resolve('done');
    ctx.waitUntil(task);

    expect(waitUntilImpl).toHaveBeenCalledWith(task);
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
    expect(deps.logger.error).toHaveBeenCalledWith('[wskit] cancelScheduled matched no runs', {
      taskId: 'cleanup',
      filter: { label: 'drop' },
      taskExists: true,
    });
  });
});

describe('ctx.setAlarm', () => {
  it('calls the timer provider setAlarm with the given timestamp', () => {
    const setAlarm = vi.fn(async () => {});
    const connection = createConnection('c1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      getTimers: () => ({
        setAlarm,
      }),
    });

    const ctx = buildConnectionContext(deps, connection);
    ctx.setAlarm(1_700_000_000_000);

    expect(setAlarm).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it('is a no-op when the timer provider does not implement setAlarm', () => {
    const connection = createConnection('c1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
    });

    const ctx = buildConnectionContext(deps, connection);
    expect(() => ctx.setAlarm(1)).not.toThrow();
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

    expect(broadcastToConnections).toHaveBeenCalledWith([self, peer], {
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

    expect(broadcastToConnections).toHaveBeenCalledWith([self, peer], {
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
        resumableStreams: new Map(),
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
        __wskit: 'connection-ref' as const,
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
        __wskit: 'connection-ref' as const,
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
    (ctx as any).channels.get({ __wskitChannel: true, __key: 'lobby' }).members();

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
      .get({ __wskitChannelRef: true, family: 'rooms', name: 'room:general' })
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
  it('routes the connection snapshot through the adapter hibernation API', () => {
    const persist = vi.fn();
    const connection = createConnection('c1');
    connection.wsKey = Symbol('ws') as unknown as RuntimeConnection['wsKey'];
    connection.meta = { username: 'user1' };
    connection.tags.ephemeral.set('role', new Set(['vip']));
    connection.channelMemberships.set('rooms::room:general', {
      channelName: 'room:general',
      channelFamily: 'rooms',
    });
    connection.activeStreamIds = new Set(['stream_1']);

    persistAttachment(connection, { persist, restore: () => undefined });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(connection.wsKey, {
      id: 'c1',
      meta: { username: 'user1' },
      tags: [{ group: 'role', key: 'vip' }],
      channelMemberships: [{ channelName: 'room:general', channelFamily: 'rooms' }],
      activeStreamIds: ['stream_1'],
    });
  });

  it('no-ops when the adapter does not provide a hibernation API', () => {
    const connection = createConnection('c2');
    connection.wsKey = Symbol('ws') as unknown as RuntimeConnection['wsKey'];

    expect(() => persistAttachment(connection, undefined)).not.toThrow();
  });
});

describe('lazy storage in init/shutdown/task contexts', () => {
  function makeFailingRequireStorage() {
    return () => {
      throw new Error('[wskit] storage not provided');
    };
  }

  function makeShutdownDeps(requireStorage: () => any) {
    return {
      env: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      platform: {},
      waitUntilImpl: vi.fn(),
      requireStorage,
      getTimers: () => undefined,
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

  it('createInitContext does not call requireStorage eagerly', () => {
    expect(() => createInitContext(makeShutdownDeps(makeFailingRequireStorage()))).not.toThrow();
  });

  it('createShutdownContext does not call requireStorage eagerly', () => {
    expect(() =>
      createShutdownContext(makeShutdownDeps(makeFailingRequireStorage())),
    ).not.toThrow();
  });

  it('createTaskContext does not call requireStorage eagerly', () => {
    expect(() => createTaskContext(makeShutdownDeps(makeFailingRequireStorage()))).not.toThrow();
  });

  it('init ctx.sql.exec throws the requireStorage error only when invoked', () => {
    const ctx = createInitContext(makeShutdownDeps(makeFailingRequireStorage()));
    expect(() => ctx.sql.exec('SELECT 1')).toThrow('[wskit] storage not provided');
  });

  it('init ctx.kv.get throws the requireStorage error only when invoked', async () => {
    const ctx = createInitContext(makeShutdownDeps(makeFailingRequireStorage()));
    await expect(ctx.kv.get('k')).rejects.toThrow('[wskit] storage not provided');
  });

  it('lazy view forwards calls to the real provider when storage exists', () => {
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
