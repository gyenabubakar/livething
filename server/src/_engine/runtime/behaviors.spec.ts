/* oxlint-disable @typescript-eslint/no-explicit-any */
import { Block, WskitError } from '@wskit/core';
import { handleUpgrade, wakeHibernatedConnection } from '~/_engine/runtime/connection.ts';
import { dispatchIncoming, processTextMessage } from '~/_engine/runtime/messages.ts';
import { Defer, Disconnect, RejectUpgrade } from '~/errors/errors.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id = 'conn_1'): RuntimeConnection {
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
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function baseCompiled() {
  return {
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
    preIntercepts: [],
    postIntercepts: new Map(),
    namespaces: new Map(),
    channels: new Map(),
    channelFamilies: new Map(),
    scheduled: new Map(),
    modules: [],
    requires: {},
    replayClaimedChannelKeys: new Set(),
  };
}

function baseDispatchRuntime(
  overrides: Partial<Parameters<typeof dispatchIncoming>[0]> = {},
): Parameters<typeof dispatchIncoming>[0] {
  return {
    compiled: baseCompiled() as any,
    connections: new Map(),
    moduleRuntimes: [],
    activeStreams: new Map(),
    protocolHandlers: new Map(),
    incomingHooks: [],
    outgoingHooks: [],
    beforeSendHooks: [],
    afterSendHooks: [],
    errorHooks: [],
    waitUntil() {},
    logger: { warn: vi.fn(), error: vi.fn() },
    generateId() {
      return 'id_1';
    },
    requireTimers() {
      return { setTimeout: () => undefined, clearTimeout() {} };
    },
    buildConnectionContext(connection: RuntimeConnection) {
      return { id: connection.id };
    },
    toConnectionInfo(connection: RuntimeConnection) {
      return {
        id: connection.id,
        meta: connection.meta,
        tags: [...connection.tags],
        channels: [...connection.channelMemberships.values()].map((m) => m.channelName),
        latency: connection.latency,
        quality: connection.quality,
        bufferedAmount: 0,
      };
    },
    broadcastToConnections() {},
    sendProtocolMessage() {},
    sendReplay() {},
    persistAttachment() {},
    setActiveConnectionId() {},
    async handleRuntimeError() {},
    async handleValidationError() {},
    async handleSubscribe() {},
    async handleUnsubscribe() {},
    ...overrides,
  } as any;
}

// -------------------------------------------------------------------
// handleUpgrade
// -------------------------------------------------------------------
describe('handleUpgrade', () => {
  it('returns reject shape when RejectUpgrade is thrown', async () => {
    const result = await handleUpgrade(
      {
        upgradeHooks: [
          async () => {
            throw RejectUpgrade(4002, 'nope');
          },
        ],
      },
      new Request('https://example.com/'),
    );

    expect(result).toEqual({ reject: true, code: 4002, reason: 'nope' });
  });

  it('maps non-RejectUpgrade errors to a 500 reject decision', async () => {
    const result = await handleUpgrade(
      {
        upgradeHooks: [
          async () => {
            throw new Error('boom');
          },
        ],
      },
      new Request('https://example.com/'),
    );

    expect(result).toEqual({ reject: true, code: 500, reason: 'Upgrade failed' });
  });

  it('returns empty decision when no hooks are registered', async () => {
    const result = await handleUpgrade({ upgradeHooks: [] }, new Request('https://example.com/'));
    expect(result).toEqual({});
  });
});

// -------------------------------------------------------------------
// Defer retries + DeferExhausted
// -------------------------------------------------------------------
describe('defer retry behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('re-enqueues handler on Defer and stops when the handler succeeds', async () => {
    const connection = createConnection();
    let attempts = 0;
    const handler = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw Defer(10);
    });

    const errors: unknown[] = [];
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([['work', { event: 'work', handler, validator: undefined }]]),
      } as any,
      connections: new Map([[connection.id, connection]]),
      requireTimers() {
        return {
          setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
          clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
        } as any;
      },
      async handleRuntimeError(_c, error) {
        errors.push(error);
      },
    });

    await dispatchIncoming(runtime, connection, 'work', {});
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });

  it('fires DeferExhausted through onError hooks after 3 retries, without sending to client', async () => {
    const connection = createConnection();
    const handler = vi.fn(async () => {
      throw Defer(1);
    });

    const errors: any[] = [];
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([['work', { event: 'work', handler, validator: undefined }]]),
      } as any,
      connections: new Map([[connection.id, connection]]),
      errorHooks: [
        async (_ctx: unknown, error: unknown) => {
          errors.push(error);
        },
      ],
      requireTimers() {
        return {
          setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
          clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
        } as any;
      },
    });

    await dispatchIncoming(runtime, connection, 'work', { id: 1 });
    // Attempts: 1 (first), then retries 2, 3. After attempt 3 Defer triggers exhausted.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }

    // 1 initial call + 3 retries = 4 handler invocations before DeferExhausted fires
    expect(handler).toHaveBeenCalledTimes(4);
    expect(errors).toHaveLength(1);
    const err = errors[0];
    expect(err.code).toBe('defer-exhausted');
    expect(err.detail).toMatchObject({ event: 'work', payload: { id: 1 }, retries: 3 });
  });
});

// -------------------------------------------------------------------
// Disconnect thrown from handler
// -------------------------------------------------------------------
describe('Disconnect thrown from handler', () => {
  it('closes the connection with the given code and reason', async () => {
    const connection = createConnection();
    const handler = vi.fn(async () => {
      throw Disconnect(4403, 'banned');
    });

    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([['evict', { event: 'evict', handler, validator: undefined }]]),
      } as any,
      connections: new Map([[connection.id, connection]]),
    });

    await dispatchIncoming(runtime, connection, 'evict', {});

    expect(connection.descriptor.close).toHaveBeenCalledWith(4403, 'banned');
  });
});

// -------------------------------------------------------------------
// Block silently dropped
// -------------------------------------------------------------------
describe('Block at dispatch', () => {
  it('silently swallows Block — no onError, no validation error', async () => {
    const connection = createConnection();
    const handler = vi.fn(async () => {
      throw Block;
    });

    const runtimeError = vi.fn();
    const validationError = vi.fn();
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([['any', { event: 'any', handler, validator: undefined }]]),
      } as any,
      connections: new Map([[connection.id, connection]]),
      handleRuntimeError: runtimeError,
      handleValidationError: validationError,
    });

    await dispatchIncoming(runtime, connection, 'any', {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtimeError).not.toHaveBeenCalled();
    expect(validationError).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------
// processTextMessage protocol branches
// -------------------------------------------------------------------
describe('processTextMessage protocol branches', () => {
  it('responds to raw "ping" text frames with "pong"', async () => {
    const connection = createConnection();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [] } as any;

    await processTextMessage(runtimeWithActivity, connection, 'ping');

    expect(connection.descriptor.send).toHaveBeenCalledWith('pong');
  });

  it('responds to JSON {event:"ping"} with {event:"pong"}', async () => {
    const connection = createConnection();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [] } as any;

    await processTextMessage(runtimeWithActivity, connection, JSON.stringify({ event: 'ping' }));

    expect(connection.descriptor.send).toHaveBeenCalledWith(JSON.stringify({ event: 'pong' }));
  });

  it('cancels an active stream on _streamCancel', async () => {
    const connection = createConnection();
    const generator = {
      return: vi.fn(async () => ({ value: undefined, done: true as const })),
    };
    const activeStreams = new Map([
      [
        'stream_1',
        {
          id: 'stream_1',
          connectionId: connection.id,
          closed: false,
          generator,
        } as any,
      ],
    ]);

    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      activeStreams,
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [] } as any;

    await processTextMessage(
      runtimeWithActivity,
      connection,
      JSON.stringify({ event: '_streamCancel', payload: { _streamId: 'stream_1' } }),
    );

    expect(generator.return).toHaveBeenCalledTimes(1);
    expect(activeStreams.has('stream_1')).toBe(false);
  });

  it('logs and drops invalid JSON', async () => {
    const connection = createConnection();
    const warn = vi.fn();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      logger: { warn, error: vi.fn() },
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [] } as any;

    await processTextMessage(runtimeWithActivity, connection, '{not json');

    expect(warn).toHaveBeenCalledWith('Invalid JSON message dropped');
  });

  it('drops valid-but-malformed JSON frames (null, primitives, arrays, missing event)', async () => {
    const connection = createConnection();
    const warn = vi.fn();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      logger: { warn, error: vi.fn() },
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [] } as any;

    // Each of these is valid JSON, so JSON.parse succeeds. Without a shape
    // guard, reading `parsed.event` would throw and crash the adapter's
    // message handler.
    const malformedFrames = ['null', '123', '"hello"', 'true', '[]', '{}', '{"payload":{}}'];

    for (const frame of malformedFrames) {
      await processTextMessage(runtimeWithActivity, connection, frame);
    }

    expect(warn).toHaveBeenCalledTimes(malformedFrames.length);
    for (const call of warn.mock.calls) {
      expect(call[0]).toBe('Invalid message shape dropped');
    }
  });

  it('routes _subscribe failures through handleRuntimeError with channel routing metadata', async () => {
    const connection = createConnection();
    const errors: Array<{ error: unknown; event: string | undefined; routing?: unknown }> = [];

    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      async handleSubscribe() {
        throw new Error('beforeSubscribe rejected');
      },
      async handleRuntimeError(_conn, error, event, routing) {
        errors.push({ error, event, routing });
      },
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [] } as any;

    await processTextMessage(
      runtimeWithActivity,
      connection,
      JSON.stringify({
        event: '_subscribe',
        payload: { _channel: 'room:general', _channelScope: 'rooms' },
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.event).toBe('_subscribe');
    expect(errors[0]!.routing).toEqual({
      _channel: 'room:general',
      _channelScope: 'rooms',
    });
  });

  it('routes _unsubscribe failures through handleRuntimeError with channel routing metadata', async () => {
    const connection = createConnection();
    const errors: Array<{ error: unknown; event: string | undefined; routing?: unknown }> = [];

    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      async handleUnsubscribe() {
        throw new WskitError('channel-not-subscribed', undefined);
      },
      async handleRuntimeError(_conn, error, event, routing) {
        errors.push({ error, event, routing });
      },
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [] } as any;

    await processTextMessage(
      runtimeWithActivity,
      connection,
      JSON.stringify({
        event: '_unsubscribe',
        payload: { _channel: 'room:general', _channelScope: 'rooms' },
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.event).toBe('_unsubscribe');
    expect(errors[0]!.routing).toEqual({
      _channel: 'room:general',
      _channelScope: 'rooms',
    });
    expect((errors[0]!.error as { code?: string }).code).toBe('channel-not-subscribed');
  });
});

// -------------------------------------------------------------------
// wakeHibernatedConnection → restoreChannelMemberships branches
// -------------------------------------------------------------------
describe('restoreChannelMemberships via wakeHibernatedConnection', () => {
  function makeRuntime(snapshot: unknown) {
    return {
      compiled: baseCompiled() as any,
      timers: undefined,
      connections: new Map(),
      wsToConnectionId: new Map(),
      generateId: () => 'conn_new',
      persistAttachment() {},
      restoreAttachment: () => snapshot,
      buildConnectionContext(c: RuntimeConnection) {
        return { id: c.id };
      },
      async runConnectionLifecycle() {},
      async processTextMessage() {},
      async handleBinaryMessage() {},
      async handleConnectionClose() {},
      async handleRuntimeError() {},
    };
  }

  it('restores from the channelMemberships array when present', () => {
    const runtime = makeRuntime({
      id: 'hib_1',
      meta: {},
      tags: [],
      channelMemberships: [
        { channelName: 'room:a', channelScope: 'rooms' },
        { channelName: 'room:b' },
      ],
    });
    const wsKey = { send() {}, close() {} };

    wakeHibernatedConnection(runtime as any, wsKey);

    const connection = runtime.connections.get('hib_1');
    expect(connection).toBeDefined();
    expect(connection!.channelMemberships.size).toBe(2);
    expect(connection!.channelMemberships.has('rooms::room:a')).toBe(true);
    expect(connection!.channelMemberships.has('::room:b')).toBe(true);
  });

  it('does not restore channel memberships when the attachment omits channelMemberships', () => {
    const runtime = makeRuntime({
      id: 'hib_2',
      meta: {},
      tags: [],
      channels: ['lobby:1', 'lobby:2'],
    });
    const wsKey = { send() {}, close() {} };

    wakeHibernatedConnection(runtime as any, wsKey);

    const connection = runtime.connections.get('hib_2');
    expect(connection).toBeDefined();
    expect(connection!.channelMemberships.size).toBe(0);
  });
});

// -------------------------------------------------------------------
// onAfterSend async rejection logging
// -------------------------------------------------------------------
describe('onAfterSend async rejection', () => {
  it('logs errors from an after-send hook that returns a rejecting promise', async () => {
    const { sendThroughPipeline } = await import('~/_engine/runtime/messages.ts');

    const connection = createConnection();
    const error = vi.fn();
    const waitUntilTasks: Promise<unknown>[] = [];

    sendThroughPipeline(
      {
        compiled: {
          ...baseCompiled(),
          outgoing: new Map([['tick', { event: 'tick' }]]),
        } as any,
        moduleRuntimes: [],
        outgoingHooks: [],
        beforeSendHooks: [],
        afterSendHooks: [() => Promise.reject(new Error('persist failed'))],
        waitUntil(promise) {
          waitUntilTasks.push(promise);
        },
        logger: { warn: vi.fn(), error },
        generateId() {
          return 'id_1';
        },
      },
      connection,
      undefined,
      'tick',
      { n: 1 },
    );

    expect(waitUntilTasks).toHaveLength(1);
    await waitUntilTasks[0];
    expect(error).toHaveBeenCalledWith('[wskit] after-send hook failed', expect.any(Object));
  });
});
