/* oxlint-disable @typescript-eslint/no-explicit-any */
import { buildConnectionContext, createTaskContext } from '~/_engine/contexts/contexts.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      sendBinary: vi.fn(),
      close: vi.fn(),
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: new Set<string>(),
    channels: new Set<string>(),
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
    env: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platform: {},
    waitUntilImpl: vi.fn(),
    requireStorage: () => baseStorage(),
    requireTimers: () => ({
      setTimeout: () => undefined,
      clearTimeout: () => {},
    }),
    scheduleTask: vi.fn(),
    cancelScheduled: vi.fn(),
    broadcastToConnections: vi.fn(),
    sendThroughPipeline: vi.fn(() => true),
    broadcastToChannel: vi.fn(),
    getChannelMembers: vi.fn(() => []),
    kickChannelMembers: vi.fn(),
    sendReplay: vi.fn(),
    sendProtocolMessage: vi.fn(),
    persistAttachment: vi.fn(),
    toConnectionInfo: (c: RuntimeConnection) => ({
      id: c.id,
      meta: c.meta,
      tags: [...c.tags],
      channels: [...c.channels],
      latency: c.latency,
      quality: c.quality,
      bufferedAmount: 0,
    }),
    attachModuleApis: vi.fn(),
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
  });

  it('task context sendToConnection returns false for unknown ids', () => {
    const deps = baseDeps();
    const task = createTaskContext(deps);

    expect(task.sendToConnection('missing', 'evt', {})).toBe(false);
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
    expect(deps.sendThroughPipeline).toHaveBeenCalledWith(peer, undefined, 'evt', { text: 'hi' });
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

describe('ctx.setAlarm', () => {
  it('calls the timer provider setAlarm with the given timestamp', () => {
    const setAlarm = vi.fn(async () => {});
    const connection = createConnection('c1');
    const deps = baseDeps({
      connections: new Map([[connection.id, connection]]),
      requireTimers: () => ({
        setTimeout: () => undefined,
        clearTimeout: () => {},
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

describe('ctx.broadcastBinary', () => {
  it('pushes bytes to every connection descriptor', () => {
    const self = createConnection('self');
    const peer = createConnection('peer');
    const deps = baseDeps({
      connections: new Map([
        [self.id, self],
        [peer.id, peer],
      ]),
    });

    const ctx = buildConnectionContext(deps, self);
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    ctx.broadcastBinary(bytes);

    expect(self.descriptor.sendBinary).toHaveBeenCalledWith(bytes);
    expect(peer.descriptor.sendBinary).toHaveBeenCalledWith(bytes);
  });

  it('excludeSelf:true skips the originator', () => {
    const self = createConnection('self');
    const peer = createConnection('peer');
    const deps = baseDeps({
      connections: new Map([
        [self.id, self],
        [peer.id, peer],
      ]),
    });

    const ctx = buildConnectionContext(deps, self);
    const bytes = new Uint8Array([9]).buffer;
    ctx.broadcastBinary(bytes, { excludeSelf: true });

    expect(self.descriptor.sendBinary).not.toHaveBeenCalled();
    expect(peer.descriptor.sendBinary).toHaveBeenCalledWith(bytes);
  });
});

describe('ctx.broadcast excludeSelf', () => {
  it('skips the originating connection when excludeSelf is true', () => {
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
    ctx.broadcast('message', { text: 'hello' }, { excludeSelf: true });

    expect(broadcastToConnections).toHaveBeenCalledWith(
      [self, peer],
      'message',
      { text: 'hello' },
      { excludeSelf: true },
      'self',
    );
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
