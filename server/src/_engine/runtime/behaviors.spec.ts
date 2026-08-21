/* oxlint-disable @typescript-eslint/no-explicit-any */
import { Block, WSKitError } from '@wskit/core';
import { handleUpgrade, wakeHibernatedConnection } from '~/_engine/runtime/connection.ts';
import { dispatchIncoming, processTextMessage } from '~/_engine/runtime/messages.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { Defer, Disconnect, RejectUpgrade } from '~/errors/errors.ts';
import { cancelStream } from '~/stream/runtime.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendRuntimeErrorOptions } from '~/errors/runtime.ts';

function createConnection(id = 'conn_1'): RuntimeConnection {
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
      userId: id,
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
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
    resumableStreams: new Map(),
    recordedStreams: new Map(),
    intercepts: [],
    channels: new Map(),
    channelFamilies: new Map(),
    scheduled: new Map(),
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
    buildConnectionContext(connection: RuntimeConnection) {
      return { id: connection.id };
    },
    toConnectionInfo(connection: RuntimeConnection) {
      return {
        id: connection.id,
        userId: connection.userId,
        meta: connection.meta,
        tags: [],
        channels: [...connection.channelMemberships.values()].map((m) => m.channelName),
        latency: connection.latency,
        quality: connection.quality,
        bufferedAmount: 0,
        ref: () => ({
          __wskit: 'connection-ref' as const,
          id: connection.id,
          instance: undefined,
          userId: connection.userId,
        }),
      };
    },
    broadcastToConnections() {},
    sendProtocolMessage() {},
    sendReplay() {},
    persistAttachment() {},
    async handleRuntimeError() {},
    async handleValidationError() {},
    async handleSubscribe() {},
    async handleUnsubscribe() {},
    streamCancel: cancelStream,
    pluginPingHooks: [],
    pluginPongHooks: [],
    appPingHooks: [],
    appPongHooks: [],
    ...overrides,
  } as any;
}

describe('handleUpgrade', () => {
  it('returns reject shape when RejectUpgrade is thrown', async () => {
    const result = await handleUpgrade(
      {
        upgradeHooks: [
          async () => {
            throw RejectUpgrade(4002, 'nope');
          },
        ],
        upgradeHelpers: {},
        isTagGroupDeclared: () => true,
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
        upgradeHelpers: {},
        isTagGroupDeclared: () => true,
      },
      new Request('https://example.com/'),
    );

    expect(result).toEqual({ reject: true, code: 500, reason: 'Upgrade failed' });
  });

  it('returns empty decision when no hooks are registered', async () => {
    const result = await handleUpgrade(
      { upgradeHooks: [], upgradeHelpers: {}, isTagGroupDeclared: () => true },
      new Request('https://example.com/'),
    );
    expect(result).toEqual({});
  });

  it('builder upgrade hook overrides internal hooks on meta key conflict', async () => {
    const result = await handleUpgrade(
      {
        upgradeHooks: [
          async () => ({ meta: { region: 'us', tenant: 't_internal' } }),
          async () => ({ meta: { region: 'eu' } }),
        ],
        builderUpgradeHook: async () => ({
          meta: { region: 'ap', user_id: 'u_42' },
        }),
        upgradeHelpers: {},
        isTagGroupDeclared: () => true,
      },
      new Request('https://example.com/'),
    );

    // builder wins on `region` even though two internal hooks set it;
    // builder also adds `user_id`; internal-only `tenant` survives.
    expect(result.meta).toEqual({ region: 'ap', tenant: 't_internal', user_id: 'u_42' });
  });

  it('tags from internal hooks and the builder hook union together', async () => {
    function ref(key: string) {
      return { __wskit: 'tag-ref', kind: 'ephemeral', group: 'role', key } as const;
    }
    const result = await handleUpgrade(
      {
        upgradeHooks: [
          async () => ({ tags: [ref('authed'), ref('beta')] }),
          async () => ({ tags: [ref('beta'), ref('eu-west')] }),
        ],
        builderUpgradeHook: async () => ({ tags: [ref('user-tag')] }),
        upgradeHelpers: {},
        isTagGroupDeclared: () => true,
      },
      new Request('https://example.com/'),
    );

    expect(new Set((result.tags ?? []).map((r) => r.key))).toEqual(
      new Set(['authed', 'beta', 'eu-west', 'user-tag']),
    );
  });

  it('builder hook runs alone when no internal hooks are registered', async () => {
    function ref(key: string) {
      return { __wskit: 'tag-ref', kind: 'ephemeral', group: 'role', key } as const;
    }
    const result = await handleUpgrade(
      {
        upgradeHooks: [],
        builderUpgradeHook: async () => ({ meta: { user_id: 'u_42' }, tags: [ref('authed')] }),
        upgradeHelpers: {},
        isTagGroupDeclared: () => true,
      },
      new Request('https://example.com/'),
    );

    expect(result.meta).toEqual({ user_id: 'u_42' });
    expect((result.tags ?? []).map((r) => r.key)).toEqual(['authed']);
  });

  it('returns undefined meta and tags when no hook contributes either', async () => {
    const result = await handleUpgrade(
      {
        upgradeHooks: [async () => ({})],
        builderUpgradeHook: async () => ({}),
        upgradeHelpers: {},
        isTagGroupDeclared: () => true,
      },
      new Request('https://example.com/'),
    );

    expect(result.meta).toBeUndefined();
    expect(result.tags).toBeUndefined();
  });

  it('rejects an ephemeral tag whose group is not declared', async () => {
    const result = await handleUpgrade(
      {
        upgradeHooks: [],
        builderUpgradeHook: async () => ({
          tags: [{ __wskit: 'tag-ref', kind: 'ephemeral', group: 'typo', key: 'x' }],
        }),
        upgradeHelpers: {},
        isTagGroupDeclared: (_kind, group) => group === 'role',
      },
      new Request('https://example.com/'),
    );

    expect(result).toEqual({ reject: true, code: 500, reason: 'Upgrade failed' });
  });
});

describe('defer retry behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
      async handleRuntimeError(_c, error) {
        errors.push(error);
      },
    });

    await dispatchIncoming(runtime, connection, { event: 'work', payload: {}, wskit: undefined });
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
    });

    await dispatchIncoming(runtime, connection, {
      event: 'work',
      payload: { id: 1 },
      wskit: undefined,
    });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(handler).toHaveBeenCalledTimes(4);
    expect(errors).toHaveLength(1);
    const err = errors[0];
    expect(err.code).toBe('defer-exhausted');
    expect(err.detail).toMatchObject({ event: 'work', payload: { id: 1 }, retries: 3 });
  });

  it('does not re-run the handler when the connection closed during the defer delay', async () => {
    const connection = createConnection();
    let attempts = 0;
    const handler = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw Defer(10);
    });

    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([['work', { event: 'work', handler, validator: undefined }]]),
      } as any,
      connections: new Map([[connection.id, connection]]),
    });

    await dispatchIncoming(runtime, connection, { event: 'work', payload: {}, wskit: undefined });
    expect(handler).toHaveBeenCalledTimes(1);

    // Simulate the socket closing during the 10ms defer window: the close path
    // sets `closing` and drops the connection from the live set.
    connection.closing = true;
    runtime.connections.delete(connection.id);

    await vi.advanceTimersByTimeAsync(10);

    // The retry must be a no-op — no side effects for a gone connection.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not retry a Defer thrown from a request handler — surfaces it as an error', async () => {
    // Defer re-queues the frame; a request would re-run and re-answer a
    // correlation the client already settled. Only an on() handler may Defer, so
    // a request-handler Defer runs once and routes to the error path
    // (internal-error on the wire), never a retry.
    const connection = createConnection();
    const handler = vi.fn(async () => {
      throw Defer(10);
    });
    const errors: any[] = [];
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        requests: new Map([['ask', { event: 'ask', handler, validator: undefined }]]),
      } as any,
      connections: new Map([[connection.id, connection]]),
      requestDispatch: async (_rt: any, _c: any, opts: any) => {
        await opts.request.handler({ respond() {} }, opts.payload);
      },
      async handleRuntimeError(_c: any, opts: any) {
        errors.push(opts);
      },
    } as any);

    await dispatchIncoming(runtime, connection, {
      event: 'ask',
      payload: {},
      wskit: { correlationId: 'c1' } as any,
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].error.__wskit).toBe('defer');
  });

  it('does not retry a Defer thrown from an intercept — surfaces it as an error', async () => {
    // An intercept fires on every frame kind, so a Defer there could re-queue a
    // request or stream frame. It runs once and routes to the error path.
    const connection = createConnection();
    const handler = vi.fn(async () => {});
    let interceptCalls = 0;
    const errors: any[] = [];
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([['work', { event: 'work', handler, validator: undefined }]]),
      } as any,
      connections: new Map([[connection.id, connection]]),
      runIntercepts: async () => {
        interceptCalls += 1;
        throw Defer(10);
      },
      async handleRuntimeError(_c: any, opts: any) {
        errors.push(opts);
      },
    } as any);

    await dispatchIncoming(runtime, connection, { event: 'work', payload: {}, wskit: undefined });
    await vi.advanceTimersByTimeAsync(20);

    expect(interceptCalls).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(errors[0].error.__wskit).toBe('defer');
  });
});

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

    await dispatchIncoming(runtime, connection, { event: 'evict', payload: {}, wskit: undefined });

    expect(connection.descriptor.close).toHaveBeenCalledWith(4403, 'banned');
  });
});

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

    await dispatchIncoming(runtime, connection, { event: 'any', payload: {}, wskit: undefined });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtimeError).not.toHaveBeenCalled();
    expect(validationError).not.toHaveBeenCalled();
  });
});

describe('processTextMessage protocol branches', () => {
  it('fans a raw "ping" text frame out to the ping hooks, in order', async () => {
    const connection = createConnection();
    const calls: string[] = [];
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
    });
    const runtimeWithActivity = {
      ...runtime,
      activityHooks: [],
      messageActivityHooks: [],
      pingHooks: [() => void calls.push('first'), () => void calls.push('second')],
      pongHooks: [() => void calls.push('pong')],
    } as any;

    await processTextMessage(runtimeWithActivity, connection, 'ping');

    expect(calls).toEqual(['first', 'second']);
  });

  it('fans a raw "pong" text frame out to the pong hooks, in order', async () => {
    const connection = createConnection();
    const calls: string[] = [];
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
    });
    const runtimeWithActivity = {
      ...runtime,
      activityHooks: [],
      messageActivityHooks: [],
      pingHooks: [() => void calls.push('ping')],
      pongHooks: [() => void calls.push('first'), () => void calls.push('second')],
    } as any;

    await processTextMessage(runtimeWithActivity, connection, 'pong');

    expect(calls).toEqual(['first', 'second']);
  });

  it('never parses a bare ping or pong as JSON', async () => {
    const connection = createConnection();
    const warn = vi.fn();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      logger: { warn, error: vi.fn() },
    });
    const runtimeWithActivity = {
      ...runtime,
      activityHooks: [],
      messageActivityHooks: [],
      pingHooks: [],
      pongHooks: [],
    } as any;

    await processTextMessage(runtimeWithActivity, connection, 'ping');
    await processTextMessage(runtimeWithActivity, connection, 'pong');

    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a throwing ping hook and lets the remaining hooks run', async () => {
    const connection = createConnection();
    const error = vi.fn();
    const after = vi.fn();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      logger: { warn: vi.fn(), error },
    });
    const runtimeWithActivity = {
      ...runtime,
      activityHooks: [],
      messageActivityHooks: [],
      pingHooks: [
        vi.fn(() => {
          throw new Error('ping hook failed');
        }),
        after,
      ],
      pongHooks: [],
    } as any;

    await processTextMessage(runtimeWithActivity, connection, 'ping');

    expect(error).toHaveBeenCalledWith(
      '[wskit] ping hook threw',
      expect.objectContaining({ connectionId: connection.id }),
    );
    expect(after).toHaveBeenCalledWith(connection.id);
  });

  it('logs a throwing pong hook and lets the remaining hooks run', async () => {
    const connection = createConnection();
    const error = vi.fn();
    const after = vi.fn();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      logger: { warn: vi.fn(), error },
    });
    const runtimeWithActivity = {
      ...runtime,
      activityHooks: [],
      messageActivityHooks: [],
      pingHooks: [],
      pongHooks: [
        vi.fn(() => {
          throw new Error('pong hook failed');
        }),
        after,
      ],
    } as any;

    await processTextMessage(runtimeWithActivity, connection, 'pong');

    expect(error).toHaveBeenCalledWith(
      '[wskit] pong hook threw',
      expect.objectContaining({ connectionId: connection.id }),
    );
    expect(after).toHaveBeenCalledWith(connection.id);
  });

  it('logs activity hook failures and still fans the ping out', async () => {
    const connection = createConnection();
    const error = vi.fn();
    const pingHook = vi.fn();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      logger: { warn: vi.fn(), error },
    });
    const runtimeWithActivity = {
      ...runtime,
      activityHooks: [
        vi.fn(async () => {
          throw new Error('activity failed');
        }),
      ],
      messageActivityHooks: [],
      pingHooks: [pingHook],
      pongHooks: [],
    } as any;

    await processTextMessage(runtimeWithActivity, connection, 'ping');

    expect(error).toHaveBeenCalledWith(
      '[wskit] connection activity hook threw',
      expect.objectContaining({ connectionId: connection.id }),
    );
    expect(pingHook).toHaveBeenCalledWith(connection.id);
  });

  it('runs message-activity hooks on a real frame but not on a transport ping', async () => {
    const connection = createConnection();
    const connectionActivity = vi.fn();
    const messageActivity = vi.fn();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
    });
    const runtimeWithActivity = {
      ...runtime,
      activityHooks: [connectionActivity],
      messageActivityHooks: [messageActivity],
      pingHooks: [],
      pongHooks: [],
      handleRuntimeError: vi.fn(),
    } as any;

    await processTextMessage(runtimeWithActivity, connection, 'ping');
    expect(connectionActivity).toHaveBeenCalledTimes(1);
    expect(messageActivity).not.toHaveBeenCalled();

    await processTextMessage(
      runtimeWithActivity,
      connection,
      JSON.stringify({ event: 'noop', payload: {} }),
    );
    expect(messageActivity).toHaveBeenCalledWith(connection.id);
  });

  it('counts a pong as connection activity but not as message activity', async () => {
    const connection = createConnection();
    const connectionActivity = vi.fn();
    const messageActivity = vi.fn();
    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
    });
    const runtimeWithActivity = {
      ...runtime,
      activityHooks: [connectionActivity],
      messageActivityHooks: [messageActivity],
      pingHooks: [],
      pongHooks: [],
    } as any;

    await processTextMessage(runtimeWithActivity, connection, 'pong');

    expect(connectionActivity).toHaveBeenCalledWith(connection.id);
    expect(messageActivity).not.toHaveBeenCalled();
  });

  it('cancels an active stream on __streamCancel__', async () => {
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
    const runtimeWithActivity = { ...runtime, activityHooks: [], messageActivityHooks: [] } as any;

    await processTextMessage(
      runtimeWithActivity,
      connection,
      JSON.stringify({
        event: '__streamCancel__',
        payload: {},
        __wskit: { streamId: 'stream_1' },
      }),
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
    const runtimeWithActivity = { ...runtime, activityHooks: [], messageActivityHooks: [] } as any;

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
    const runtimeWithActivity = { ...runtime, activityHooks: [], messageActivityHooks: [] } as any;

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

  it('routes __subscribe__ failures through handleRuntimeError with channel routing metadata', async () => {
    const connection = createConnection();
    const errors: Array<{ error: unknown; event: string | undefined; routing?: unknown }> = [];

    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      async handleSubscribe() {
        throw new Error('beforeSubscribe rejected');
      },
      async handleRuntimeError(_conn, { error, event, routing }: SendRuntimeErrorOptions) {
        errors.push({ error, event, routing });
      },
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [], messageActivityHooks: [] } as any;

    await processTextMessage(
      runtimeWithActivity,
      connection,
      JSON.stringify({
        event: '__subscribe__',
        payload: {},
        __wskit: { channel: 'room:general', channelFamily: 'rooms' },
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.event).toBe('__subscribe__');
    expect(errors[0]!.routing).toEqual({
      channel: 'room:general',
      channelFamily: 'rooms',
    });
  });

  it('routes __unsubscribe__ failures through handleRuntimeError with channel routing metadata', async () => {
    const connection = createConnection();
    const errors: Array<{ error: unknown; event: string | undefined; routing?: unknown }> = [];

    const runtime = baseDispatchRuntime({
      connections: new Map([[connection.id, connection]]),
      async handleUnsubscribe() {
        throw new WSKitError('channel-not-subscribed', undefined);
      },
      async handleRuntimeError(_conn, { error, event, routing }: SendRuntimeErrorOptions) {
        errors.push({ error, event, routing });
      },
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [], messageActivityHooks: [] } as any;

    await processTextMessage(
      runtimeWithActivity,
      connection,
      JSON.stringify({
        event: '__unsubscribe__',
        payload: {},
        __wskit: { channel: 'room:general', channelFamily: 'rooms' },
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]!.event).toBe('__unsubscribe__');
    expect(errors[0]!.routing).toEqual({
      channel: 'room:general',
      channelFamily: 'rooms',
    });
    expect((errors[0]!.error as { code?: string }).code).toBe('channel-not-subscribed');
  });
});

describe('wakeHibernatedConnection — channel memberships restore', () => {
  function makeRuntime(id: string, row: Record<string, unknown> | null) {
    return {
      compiled: baseCompiled() as any,
      connections: new Map(),
      usersByKey: new Map(),
      channelMembers: new Map(),
      tagMembers: new Map(),
      wsToConnectionId: new Map(),
      generateId: () => 'conn_new',
      persistAttachment() {},
      restoreAttachment: () => ({ id }),
      readConnectionState: () => row,
      buildConnectionContext(c: RuntimeConnection) {
        return { id: c.id };
      },
      async runConnectionLifecycle() {},
      async processTextMessage() {},
      async handleConnectionClose() {},
      async handleRuntimeError() {},
    };
  }

  it('restores memberships from the persisted connection row', () => {
    const runtime = makeRuntime('hib_1', {
      connection_id: 'hib_1',
      user_id: 'hib_1',
      meta: {},
      ephemeral_tags: [],
      ephemeral_memberships: [
        { channelName: 'room:a', channelFamily: 'rooms' },
        { channelName: 'room:b', channelFamily: null },
      ],
      active_stream_ids: [],
    });
    const wsKey = { send() {}, close() {} };

    wakeHibernatedConnection(runtime as any, wsKey);

    const connection = runtime.connections.get('hib_1');
    expect(connection).toBeDefined();
    expect(connection!.channelMemberships.size).toBe(2);
    expect(connection!.channelMemberships.has(createChannelMembershipKey('room:a', 'rooms'))).toBe(
      true,
    );
    expect(connection!.channelMemberships.has(createChannelMembershipKey('room:b', null))).toBe(
      true,
    );
  });

  it('starts with no memberships when there is no row for the socket', () => {
    const runtime = makeRuntime('hib_2', null);
    const wsKey = { send() {}, close() {} };

    wakeHibernatedConnection(runtime as any, wsKey);

    // No id in attachment means the wake path generates a fresh id rather
    // than using the missing-row id. The connection still lands in the map
    // under the generated id with no memberships.
    const connection = runtime.connections.get('hib_2');
    expect(connection).toBeDefined();
    expect(connection!.channelMemberships.size).toBe(0);
  });
});

describe('onAfterSend async rejection', () => {
  it('logs errors from an after-send hook that returns a rejecting promise', async () => {
    const { sendThroughPipeline } = await import('~/outgoing/runtime.ts');

    const connection = createConnection();
    const error = vi.fn();
    const waitUntilTasks: Promise<unknown>[] = [];

    sendThroughPipeline(
      {
        compiled: {
          ...baseCompiled(),
          outgoing: new Map([['tick', { event: 'tick' }]]),
        } as any,
        outgoingHooks: [],
        beforeSendHooks: [],
        wskitStampHooks: [],
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
      { routing: undefined, event: 'tick', payload: { n: 1 } },
    );

    expect(waitUntilTasks).toHaveLength(1);
    await waitUntilTasks[0];
    expect(error).toHaveBeenCalledWith('[wskit] after-send hook failed', expect.any(Object));
  });
});
