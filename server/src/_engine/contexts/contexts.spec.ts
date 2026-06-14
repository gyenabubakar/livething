/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  buildConnectionContext,
  createInitContext,
  createShutdownContext,
  createTaskContext,
  persistAttachment,
} from '~/_engine/contexts/contexts.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    identity: id,
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

function baseDeps(overrides: Partial<Parameters<typeof buildConnectionContext>[0]> = {}) {
  return {
    compiled: {} as any,
    connections: new Map<string, RuntimeConnection>(),
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
    resolveChannel: vi.fn((target: any) =>
      typeof target === 'string'
        ? { channelName: target }
        : { channelName: target.name, channelScope: target.family },
    ),
    sendReplay: vi.fn(),
    sendProtocolMessage: vi.fn(),
    persistAttachment: vi.fn(),
    toConnectionInfo: (c: RuntimeConnection) => ({
      id: c.id,
      identity: c.identity,
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
        identity: c.identity,
      }),
    }),
    attachPluginApis: vi.fn(),
    contextExtenders: [],
    ...overrides,
  } as any;
}

describe('sendToConnection', () => {
  it('returns false when the target id is not in the connection map', () => {
    const connection = createConnection('conn_1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
    });

    const ctx = buildConnectionContext(deps, connection);
    const result = ctx.sendToConnection('nonexistent-id', 'evt', {});

    expect(result).toBe(false);
    expect(deps.sendThroughPipeline).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith('[wskit] sendToConnection target not found', {
      connectionId: 'nonexistent-id',
      event: 'evt',
    });
  });

  it('task context sendToConnection returns false for unknown ids', () => {
    const deps = baseDeps();
    const task = createTaskContext(deps);

    expect(task.sendToConnection('missing', 'evt', {})).toBe(false);
    expect(deps.logger.error).toHaveBeenCalledWith('[wskit] sendToConnection target not found', {
      connectionId: 'missing',
      event: 'evt',
    });
  });

  it('returns true and invokes the send pipeline when target exists', () => {
    const self = createConnection('self');
    const peer = createConnection('peer');
    const deps = baseDeps({
      connections: new Map([
        [self.id, self],
        [peer.id, peer],
      ]),
    });

    const ctx = buildConnectionContext(deps, self);
    expect(ctx.sendToConnection('peer', 'evt', { text: 'hi' })).toBe(true);
    expect(deps.sendThroughPipeline).toHaveBeenCalledWith(peer, {
      routing: undefined,
      event: 'evt',
      payload: { text: 'hi' },
    });
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
  it('logs an error when a connection context cancellation matches no runs', () => {
    const connection = createConnection('c1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      cancelScheduled: vi.fn(() => ({ taskExists: false, removed: 0 })),
    });

    const ctx = buildConnectionContext(deps, connection);
    ctx.cancelScheduled('missing-task', { id: 'x' });

    expect(deps.cancelScheduled).toHaveBeenCalledWith('missing-task', { id: 'x' });
    expect(deps.logger.error).toHaveBeenCalledWith('[wskit] cancelScheduled matched no runs', {
      taskId: 'missing-task',
      filter: { id: 'x' },
      taskExists: false,
    });
  });

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

describe('ctx.quality', () => {
  it('is null until the first ping/pong measurement, then reflects connection.quality', () => {
    const connection = createConnection('a');
    const ctx = buildConnectionContext(baseDeps(), connection);

    expect(ctx.latency).toBeNull();
    expect(ctx.quality).toBeNull();

    connection.latency = 42;
    connection.quality = 'excellent';
    expect(ctx.quality).toBe('excellent');
  });

  it('is null in hibernation even after a measurement', () => {
    const connection = createConnection('a');
    connection.latency = 42;
    connection.quality = 'excellent';
    const ctx = buildConnectionContext(baseDeps({ hibernationEnabled: true }), connection);

    expect(ctx.quality).toBeNull();
  });
});

describe('ctx.broadcast excludeSelf', () => {
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

  it('includes self when excludeSelf is false', () => {
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
    ctx.broadcast('message', { text: 'hello' }, { excludeSelf: false });

    expect(broadcastToConnections).toHaveBeenCalledWith([self, peer], {
      event: 'message',
      payload: { text: 'hello' },
      options: { excludeSelf: false },
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
      channelScope: 'rooms',
    };

    const ctx = buildConnectionContext(deps, connection, scope);
    (ctx as any).channel.send('greeting', { msg: 'hi' });

    expect(sendThroughPipeline).toHaveBeenCalledWith(connection, {
      routing: { channel: 'general', channelScope: 'rooms' },
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
      identity: 'c2',
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
        identity: 'c2',
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
      identity: 'c2',
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
        identity: 'c2',
      }),
    };
    const resolveChannel = vi.fn((target: any) =>
      typeof target === 'string'
        ? undefined
        : { channelName: target.name, channelScope: target.family, params: {} },
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

  it('kick on the handle is awaitable and forwards scope to kickChannelMembers', async () => {
    const connection = createConnection('c1');
    const kickChannelMembers = vi.fn(async () => {});
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      kickChannelMembers,
    });

    const ctx = buildConnectionContext(deps, connection);
    await (ctx as any).channels.get('room').kick('banned', 'spam');

    expect(kickChannelMembers).toHaveBeenCalledWith({
      channelName: 'room',
      target: 'banned',
      reason: 'spam',
      channelScope: undefined,
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
      channelScope: 'rooms',
    });
    connection.activeStreamIds = new Set(['stream_1']);

    persistAttachment(connection, { persist, restore: () => undefined });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(connection.wsKey, {
      id: 'c1',
      meta: { username: 'user1' },
      tags: [{ group: 'role', key: 'vip' }],
      channelMemberships: [{ channelName: 'room:general', channelScope: 'rooms' }],
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

describe('ctx.plugin', () => {
  it('runs the registered factory against a plugin-scoped ctx and caches the api', () => {
    const connection = createConnection('conn_1');
    const factory = vi.fn((scopedCtx: any) => ({
      announce() {
        scopedCtx.send('online', { id: scopedCtx.id });
      },
    }));
    const send = vi.fn(() => true);
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      sendThroughPipeline: send,
      getPluginApiFactory: (id: string) => (id === 'acme:presence' ? factory : undefined),
    });

    const ctx = buildConnectionContext(deps, connection) as any;
    const api = ctx.plugin('acme:presence') as { announce(): void };
    expect(ctx.plugin('acme:presence')).toBe(api); // cached — factory runs once
    expect(factory).toHaveBeenCalledTimes(1);

    api.announce();
    expect(send).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({ event: '__acme:presence::online' }),
    );
  });

  it('throws for an unregistered plugin id', () => {
    const connection = createConnection('conn_1');
    const ctx = buildConnectionContext(
      baseDeps({ getPluginApiFactory: () => undefined }),
      connection,
    ) as any;
    expect(() => ctx.plugin('acme:nope')).toThrow(/no plugin with id 'acme:nope' is registered/);
  });
});
