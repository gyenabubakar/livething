import { AsyncLocalStorage } from 'node:async_hooks';
import { buildConnectionContext } from '~/_engine/contexts/contexts.ts';
import { intercept } from '~/intercept/intercept.ts';
import { runIntercepts } from '~/intercept/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import { localKey } from './local-key.ts';

function createConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      sendBinary: vi.fn(),
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseDeps(overrides: Record<string, unknown> = {}): any {
  return {
    compiled: {},
    connections: new Map<string, RuntimeConnection>(),
    tagMembers: new Map(),
    env: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platform: {},
    waitUntilImpl: vi.fn(),
    requireStorage: () => ({
      sql: { exec: vi.fn(), transaction: vi.fn() },
      kv: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), list: vi.fn() },
    }),
    getTimers: () => undefined,
    scheduleTask: vi.fn(),
    cancelScheduled: vi.fn(() => ({ taskExists: true, removed: 1 })),
    broadcastToConnections: vi.fn(),
    sendThroughPipeline: vi.fn(() => true),
    broadcastToChannel: vi.fn(),
    getChannelMembers: vi.fn(() => []),
    kickChannelMembers: vi.fn(async () => {}),
    removeChannelMember: vi.fn(async () => {}),
    subscribeConnectionAsServer: vi.fn(async () => {}),
    resolveChannel: vi.fn(),
    sendReplay: vi.fn(),
    sendProtocolMessage: vi.fn(),
    persistAttachment: vi.fn(),
    toConnectionInfo: (c: RuntimeConnection) => ({
      id: c.id,
      identity: c.identity,
      meta: c.meta,
      tags: [],
      channels: [],
      latency: c.latency,
      quality: c.quality,
      bufferedAmount: 0,
      ref: () => ({
        __wskit: 'connection-ref',
        id: c.id,
        instance: undefined,
        identity: c.identity,
      }),
    }),
    attachPluginApis: vi.fn(),
    contextExtenders: [],
    usesTags: false,
    persistenceEnabled: false,
    isTagGroupDeclared: vi.fn(() => false),
    instanceId: undefined,
    hibernationEnabled: false,
    ...overrides,
  };
}

function makeRuntime() {
  return {
    asyncContext: new AsyncLocalStorage<{ connectionId?: string; [key: PropertyKey]: unknown }>(),
  };
}

describe('localKey', () => {
  it('creates a key with the given name', () => {
    const key = localKey<string>('my-key');
    expect(key.name).toBe('my-key');
  });

  it('two calls with the same name create distinct keys', () => {
    const a = localKey<string>('same');
    const b = localKey<string>('same');
    expect(a).not.toBe(b);
  });
});

describe('ctx.provide / ctx.inject', () => {
  it('inject returns what was provided', () => {
    const key = localKey<string>('greeting');
    const ctx = buildConnectionContext(baseDeps(), createConnection());

    ctx.provide(key, 'hello');
    expect(ctx.inject(key)).toBe('hello');
  });

  it('inject returns undefined for a key that was never provided', () => {
    const key = localKey<number>('count');
    const ctx = buildConnectionContext(baseDeps(), createConnection());

    expect(ctx.inject(key)).toBeUndefined();
  });

  it('different keys do not interfere', () => {
    const keyA = localKey<string>('a');
    const keyB = localKey<string>('b');
    const ctx = buildConnectionContext(baseDeps(), createConnection());

    ctx.provide(keyA, 'alpha');
    expect(ctx.inject(keyA)).toBe('alpha');
    expect(ctx.inject(keyB)).toBeUndefined();
  });

  it('same-name keys that are different references do not interfere', () => {
    const key1 = localKey<string>('user');
    const key2 = localKey<string>('user');
    const ctx = buildConnectionContext(baseDeps(), createConnection());

    ctx.provide(key1, 'alice');
    expect(ctx.inject(key1)).toBe('alice');
    expect(ctx.inject(key2)).toBeUndefined();
  });

  it('provide overwrites a previously provided value for the same key', () => {
    const key = localKey<number>('score');
    const ctx = buildConnectionContext(baseDeps(), createConnection());

    ctx.provide(key, 1);
    ctx.provide(key, 99);
    expect(ctx.inject(key)).toBe(99);
  });

  it('two separate contexts have isolated locals', () => {
    const key = localKey<string>('token');
    const ctxA = buildConnectionContext(baseDeps(), createConnection('a'));
    const ctxB = buildConnectionContext(baseDeps(), createConnection('b'));

    ctxA.provide(key, 'from-a');
    expect(ctxA.inject(key)).toBe('from-a');
    expect(ctxB.inject(key)).toBeUndefined();
  });

  it('values provided in a shared ctx are visible to later intercepts and handlers', () => {
    const key = localKey<{ role: string }>('auth');
    const ctx = buildConnectionContext(baseDeps(), createConnection());

    // Simulates: top-level intercept provides, handler injects
    ctx.provide(key, { role: 'admin' });
    const seen = ctx.inject(key);
    expect(seen).toEqual({ role: 'admin' });
  });

  it('provide in an intercept is visible to the handler via the shared dispatch ctx', async () => {
    const key = localKey<string>('role');
    const connection = createConnection();
    const ctx = buildConnectionContext(baseDeps(), connection);

    const topIntercept = intercept((c) => {
      (c as typeof ctx).provide(key, 'admin');
    });

    await runIntercepts(makeRuntime(), connection, {
      intercepts: [topIntercept],
      frame: { event: 'echo', payload: {}, kind: 'incoming', routing: {} },
      getCtx: () => ctx,
    });

    // Same ctx the handler would receive — value survives the intercept chain
    expect(ctx.inject(key)).toBe('admin');
  });

  it('second intercept in chain can inject what the first provided', async () => {
    const key = localKey<number>('step');
    const connection = createConnection();
    const ctx = buildConnectionContext(baseDeps(), connection);

    let seenInSecond: number | undefined;

    const first = intercept((c) => {
      (c as typeof ctx).provide(key, 1);
    });
    const second = intercept((c) => {
      seenInSecond = (c as typeof ctx).inject(key);
    });

    await runIntercepts(makeRuntime(), connection, {
      intercepts: [first, second],
      frame: { event: 'echo', payload: {}, kind: 'incoming', routing: {} },
      getCtx: () => ctx,
    });

    expect(seenInSecond).toBe(1);
  });

  it('works with object values', () => {
    const key = localKey<{ id: number; name: string }>('user');
    const ctx = buildConnectionContext(baseDeps(), createConnection());
    const user = { id: 1, name: 'alice' };

    ctx.provide(key, user);
    expect(ctx.inject(key)).toBe(user);
  });
});
