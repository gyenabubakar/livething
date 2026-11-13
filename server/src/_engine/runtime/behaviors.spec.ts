/* oxlint-disable @typescript-eslint/no-explicit-any */
import { Block, LiveThingError } from '@livething/core';
import { authenticate, wakeHibernatedConnection } from '~/_engine/runtime/connection.ts';
import { dispatchIncoming, processTextMessage } from '~/_engine/runtime/messages.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { Disconnect, RejectAuth } from '~/errors/errors.ts';
import { cancelStream } from '~/stream/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendRuntimeErrorOptions } from '~/errors/runtime.ts';

function createConnection(id = 'conn_1'): RuntimeConnection {
  return {
    id,
    userId: id,
    socketKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function baseCompiled() {
  return {
    outgoing: new Map(),
    incoming: new Map(),
    requests: new Map(),
    streams: new Map(),
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
    errorHooks: [],
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
          __livething: 'connection-ref' as const,
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

describe('authenticate', () => {
  it('returns reject shape when RejectAuth is thrown', async () => {
    const result = await authenticate(
      {
        authHooks: [
          async () => {
            throw RejectAuth(4002, 'nope');
          },
        ],
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: () => true,
        getTagGroupSchema: () => undefined,
      },
      new Request('https://example.com/'),
    );

    expect(result).toEqual({ reject: true, code: 4002, reason: 'nope' });
  });

  it('maps non-RejectAuth errors to a 500 reject decision and logs the real error', async () => {
    const logger = { error: vi.fn() };
    const result = await authenticate(
      {
        authHooks: [
          async () => {
            throw new Error('boom');
          },
        ],
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: () => true,
        getTagGroupSchema: () => undefined,
        logger,
      },
      new Request('https://example.com/'),
    );

    expect(result).toEqual({ reject: true, code: 500, reason: 'Authentication failed' });
    expect(logger.error).toHaveBeenCalledWith(
      '[livething] authenticate hook threw; rejecting with HTTP 500',
      expect.objectContaining({ error: 'boom', stack: expect.stringContaining('boom') }),
    );
  });

  it('logs the helpful message for an undeclared ephemeral tag group', async () => {
    const logger = { error: vi.fn() };
    await authenticate(
      {
        authHooks: [],
        builderAuthHook: async () => ({
          tags: [{ __livething: 'tag-ref', kind: 'ephemeral', group: 'typo', key: 'x' }],
        }),
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: () => false,
        getTagGroupSchema: () => undefined,
        logger,
      },
      new Request('https://example.com/'),
    );

    expect(logger.error).toHaveBeenCalledWith(
      '[livething] authenticate hook threw; rejecting with HTTP 500',
      expect.objectContaining({
        error: expect.stringContaining("onAuthenticate returned an ephemeral tag for group 'typo'"),
      }),
    );
  });

  it('does not log a RejectAuth as an error', async () => {
    const logger = { error: vi.fn() };
    await authenticate(
      {
        authHooks: [
          async () => {
            throw RejectAuth(4002, 'nope');
          },
        ],
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: () => true,
        getTagGroupSchema: () => undefined,
        logger,
      },
      new Request('https://example.com/'),
    );

    expect(logger.error).not.toHaveBeenCalled();
  });

  describe('ephemeral tag keys are checked against the group schema', () => {
    function roleRef(key: string) {
      return { __livething: 'tag-ref', kind: 'ephemeral', group: 'role', key } as const;
    }

    function authenticateWith(key: string, logger = { error: vi.fn() }) {
      return authenticate(
        {
          authHooks: [],
          builderAuthHook: async () => ({ tags: [roleRef(key)] }),
          authHelpers: { ctx: {} as never },
          isTagGroupDeclared: () => true,
          getTagGroupSchema: () => v.picklist(['admin', 'member']),
          logger,
        },
        new Request('https://example.com/'),
      );
    }

    it('accepts a key the schema allows', async () => {
      const result = await authenticateWith('admin');
      expect((result.tags ?? []).map((r) => r.key)).toEqual(['admin']);
    });

    it('rejects the connection for a key the schema rejects, and logs why', async () => {
      const logger = { error: vi.fn() };
      const result = await authenticateWith('root', logger);

      expect(result).toEqual({ reject: true, code: 500, reason: 'Authentication failed' });
      expect(logger.error).toHaveBeenCalledWith(
        '[livething] authenticate hook threw; rejecting with HTTP 500',
        expect.objectContaining({
          error:
            "[livething] onAuthenticate returned the ephemeral tag key 'root' for group 'role', which the group's schema rejects.",
        }),
      );
    });

    it('drops an empty key, the same as add()', async () => {
      const result = await authenticateWith('');
      expect(result.tags).toBeUndefined();
    });
  });

  it('returns empty decision when no hooks are registered', async () => {
    const result = await authenticate(
      {
        authHooks: [],
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: () => true,
        getTagGroupSchema: () => undefined,
      },
      new Request('https://example.com/'),
    );
    expect(result).toEqual({});
  });

  it('builder authenticate hook overrides internal hooks on meta key conflict', async () => {
    const result = await authenticate(
      {
        authHooks: [
          async () => ({ meta: { region: 'us', tenant: 't_internal' } }),
          async () => ({ meta: { region: 'eu' } }),
        ],
        builderAuthHook: async () => ({
          meta: { region: 'ap', user_id: 'u_42' },
        }),
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: () => true,
        getTagGroupSchema: () => undefined,
      },
      new Request('https://example.com/'),
    );

    // builder wins on `region` even though two internal hooks set it;
    // builder also adds `user_id`; internal-only `tenant` survives.
    expect(result.meta).toEqual({ region: 'ap', tenant: 't_internal', user_id: 'u_42' });
  });

  it('tags from internal hooks and the builder hook union together', async () => {
    function ref(key: string) {
      return { __livething: 'tag-ref', kind: 'ephemeral', group: 'role', key } as const;
    }

    const result = await authenticate(
      {
        authHooks: [
          async () => ({ tags: [ref('authed'), ref('beta')] }),
          async () => ({ tags: [ref('beta'), ref('eu-west')] }),
        ],
        builderAuthHook: async () => ({ tags: [ref('user-tag')] }),
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: () => true,
        getTagGroupSchema: () => undefined,
      },
      new Request('https://example.com/'),
    );

    expect(new Set((result.tags ?? []).map((r) => r.key))).toEqual(
      new Set(['authed', 'beta', 'eu-west', 'user-tag']),
    );
  });

  it('builder hook runs alone when no internal hooks are registered', async () => {
    function ref(key: string) {
      return { __livething: 'tag-ref', kind: 'ephemeral', group: 'role', key } as const;
    }

    const result = await authenticate(
      {
        authHooks: [],
        builderAuthHook: async () => ({ meta: { user_id: 'u_42' }, tags: [ref('authed')] }),
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: () => true,
        getTagGroupSchema: () => undefined,
      },
      new Request('https://example.com/'),
    );

    expect(result.meta).toEqual({ user_id: 'u_42' });
    expect((result.tags ?? []).map((r) => r.key)).toEqual(['authed']);
  });

  it('returns undefined meta and tags when no hook contributes either', async () => {
    const result = await authenticate(
      {
        authHooks: [async () => ({})],
        builderAuthHook: async () => ({}),
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: () => true,
        getTagGroupSchema: () => undefined,
      },
      new Request('https://example.com/'),
    );

    expect(result.meta).toBeUndefined();
    expect(result.tags).toBeUndefined();
  });

  it('rejects an ephemeral tag whose group is not declared', async () => {
    const result = await authenticate(
      {
        authHooks: [],
        builderAuthHook: async () => ({
          tags: [{ __livething: 'tag-ref', kind: 'ephemeral', group: 'typo', key: 'x' }],
        }),
        authHelpers: { ctx: {} as never },
        isTagGroupDeclared: (_kind, group) => group === 'role',
        getTagGroupSchema: () => undefined,
      },
      new Request('https://example.com/'),
    );

    expect(result).toEqual({ reject: true, code: 500, reason: 'Authentication failed' });
  });
});

describe('closing connection', () => {
  it('does not run the handler for a connection that is already closing', async () => {
    const connection = createConnection();
    const handler = vi.fn(async () => {});
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([['work', { event: 'work', handler, validator: undefined }]]),
      } as any,
      connections: new Map([[connection.id, connection]]),
    });
    connection.closing = true;

    await dispatchIncoming(runtime, connection, {
      event: 'work',
      payload: {},
      livething: undefined,
    });

    expect(handler).not.toHaveBeenCalled();
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

    await dispatchIncoming(runtime, connection, {
      event: 'evict',
      payload: {},
      livething: undefined,
    });

    expect(connection.descriptor.close).toHaveBeenCalledWith(4403, 'banned');
  });
});

describe('Block at dispatch', () => {
  it('serializes ordinary incoming handlers on one connection', async () => {
    const connection = createConnection();
    const releaseFirst = deferred();
    const events: string[] = [];
    const handler = vi.fn(async (_ctx: unknown, payload: number) => {
      events.push(`start:${payload}`);
      if (payload === 1) await releaseFirst.promise;
      events.push(`end:${payload}`);
    });
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([['work', { event: 'work', handler, validator: undefined }]]),
      } as any,
    });

    const first = dispatchIncoming(runtime, connection, {
      event: 'work',
      payload: 1,
      livething: undefined,
    });
    await Promise.resolve();
    expect(events).toEqual(['start:1']);

    const second = dispatchIncoming(runtime, connection, {
      event: 'work',
      payload: 2,
      livething: undefined,
    });
    await Promise.resolve();
    expect(events).toEqual(['start:1']);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('allows an incoming handler to opt into interleaved execution', async () => {
    const connection = createConnection();
    const releaseFirst = deferred();
    const events: string[] = [];
    const handler = vi.fn(async (_ctx: unknown, payload: number) => {
      events.push(`start:${payload}`);
      if (payload === 1) await releaseFirst.promise;
      events.push(`end:${payload}`);
    });
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([
          ['work', { event: 'work', handler, validator: undefined, allowInterleaving: true }],
        ]),
      } as any,
    });

    const first = dispatchIncoming(runtime, connection, {
      event: 'work',
      payload: 1,
      livething: undefined,
    });
    await Promise.resolve();

    const second = dispatchIncoming(runtime, connection, {
      event: 'work',
      payload: 2,
      livething: undefined,
    });
    await Promise.resolve();

    expect(events).toEqual(['start:1', 'start:2', 'end:2']);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['start:1', 'start:2', 'end:2', 'end:1']);
  });

  it('interleaves requests by default and can opt into ordered execution', async () => {
    const connection = createConnection();
    const releaseFirst = deferred();
    let release = releaseFirst;
    const events: string[] = [];
    const requestDispatch = vi.fn(async (_runtime: unknown, _connection: unknown, options: any) => {
      const payload = options.payload as number;
      events.push(`start:${payload}`);
      if (payload === 1) await release.promise;
      events.push(`end:${payload}`);
    });

    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        requests: new Map([
          ['default', { event: 'default', handler: vi.fn(), allowInterleaving: undefined }],
          ['ordered', { event: 'ordered', handler: vi.fn(), allowInterleaving: false }],
        ]),
      } as any,
      requestDispatch,
    });

    const firstDefault = dispatchIncoming(runtime, connection, {
      event: 'default',
      payload: 1,
      livething: undefined,
    });
    await Promise.resolve();
    const secondDefault = dispatchIncoming(runtime, connection, {
      event: 'default',
      payload: 2,
      livething: undefined,
    });
    await Promise.resolve();

    expect(events).toEqual(['start:1', 'start:2', 'end:2']);
    releaseFirst.resolve();
    await Promise.all([firstDefault, secondDefault]);

    events.length = 0;
    release = deferred();
    const firstOrdered = dispatchIncoming(runtime, connection, {
      event: 'ordered',
      payload: 1,
      livething: undefined,
    });
    await Promise.resolve();
    const secondOrdered = dispatchIncoming(runtime, connection, {
      event: 'ordered',
      payload: 2,
      livething: undefined,
    });

    await Promise.resolve();

    expect(events).toEqual(['start:1']);
    release.resolve();
    await Promise.all([firstOrdered, secondOrdered]);
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('does not make stream starts wait for ordered app work', async () => {
    const connection = createConnection();
    const releaseIncoming = deferred();
    const events: string[] = [];
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([
          [
            'work',
            {
              event: 'work',
              handler: async () => {
                events.push('incoming:start');
                await releaseIncoming.promise;
                events.push('incoming:end');
              },
              validator: undefined,
            },
          ],
        ]),
        streams: new Map([['feed', { event: 'feed', stream: { validator: undefined } }]]),
      } as any,
      streamTrigger: async () => {
        events.push('stream:start');
      },
    });

    const incoming = dispatchIncoming(runtime, connection, {
      event: 'work',
      payload: {},
      livething: undefined,
    });
    await Promise.resolve();

    const stream = dispatchIncoming(runtime, connection, {
      event: 'feed',
      payload: {},
      livething: undefined,
    });
    await stream;

    expect(events).toEqual(['incoming:start', 'stream:start']);

    releaseIncoming.resolve();
    await incoming;
    expect(events).toEqual(['incoming:start', 'stream:start', 'incoming:end']);
  });

  it('silently swallows Block — no onError', async () => {
    const connection = createConnection();
    const handler = vi.fn(async () => {
      throw Block;
    });

    const runtimeError = vi.fn();
    const runtime = baseDispatchRuntime({
      compiled: {
        ...baseCompiled(),
        incoming: new Map([['any', { event: 'any', handler, validator: undefined }]]),
      } as any,
      connections: new Map([[connection.id, connection]]),
      handleRuntimeError: runtimeError,
    });

    await dispatchIncoming(runtime, connection, {
      event: 'any',
      payload: {},
      livething: undefined,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(runtimeError).not.toHaveBeenCalled();
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
      '[livething] ping hook threw',
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
      '[livething] pong hook threw',
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
      '[livething] connection activity hook threw',
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

    await processTextMessage(runtimeWithActivity, connection, JSON.stringify(['noop', {}, null]));
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
      JSON.stringify(['__streamCancel__', null, { stream: { id: 'stream_1' } }]),
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
      JSON.stringify(['__subscribe__', {}, { channel: { name: 'room:general', family: 'rooms' } }]),
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
        throw new LiveThingError('channel-not-subscribed', undefined);
      },
      async handleRuntimeError(_conn, { error, event, routing }: SendRuntimeErrorOptions) {
        errors.push({ error, event, routing });
      },
    });
    const runtimeWithActivity = { ...runtime, activityHooks: [], messageActivityHooks: [] } as any;

    await processTextMessage(
      runtimeWithActivity,
      connection,
      JSON.stringify([
        '__unsubscribe__',
        null,
        { channel: { name: 'room:general', family: 'rooms' } },
      ]),
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
      socketToConnectionId: new Map(),
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
    const socketKey = { send() {}, close() {} };

    wakeHibernatedConnection(runtime as any, socketKey);

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
    const socketKey = { send() {}, close() {} };

    wakeHibernatedConnection(runtime as any, socketKey);

    // No id in attachment means the wake path generates a fresh id rather
    // than using the missing-row id. The connection still lands in the map
    // under the generated id with no memberships.
    const connection = runtime.connections.get('hib_2');
    expect(connection).toBeDefined();
    expect(connection!.channelMemberships.size).toBe(0);
  });
});
