import {
  broadcastToChannel,
  dispatchIncoming,
  processTextMessage,
  resolveScope,
} from '~/_engine/runtime/messages.ts';
import { describe, expect, it, vi } from 'vitest';
import type { CompiledServer } from '~/_engine/compile/types.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
    },
    meta: {},
    tags: new Set<string>(),
    channelMemberships: new Map<string, { channelName: string; channelScope?: string }>(),
    latency: null,
    quality: 'good',
  };
}

function addMembership(
  connection: ReturnType<typeof createConnection>,
  channelName: string,
  channelScope?: string,
) {
  connection.channelMemberships.set(`${channelScope ?? ''}::${channelName}`, {
    channelName,
    channelScope,
  });
}

describe('message runtime', () => {
  it('broadcastToChannel only targets members of the matching channel scope', () => {
    const roomsMember = createConnection('rooms');
    const lobbiesMember = createConnection('lobbies');

    addMembership(roomsMember, 'room:general', 'rooms');
    addMembership(lobbiesMember, 'room:general', 'lobbies');

    const runtime = {
      connections: new Map([
        [roomsMember.id, roomsMember],
        [lobbiesMember.id, lobbiesMember],
      ]),
      compiled: {
        outgoing: new Map([['message', { event: 'message' }]]),
        streams: new Map(),
        channels: new Map(),
        channelFamilies: new Map([
          [
            'rooms',
            {
              key: 'rooms',
              kind: 'channel' as const,
              pattern: { key: 'rooms', pattern: /^room:/ },
              outgoing: new Map([['message', { event: 'message' }]]),
              incoming: new Map(),
              requests: new Map(),
              streams: new Map(),
              preIntercepts: [],
              postIntercepts: new Map(),
            },
          ],
        ]),
      },
      moduleRuntimes: [],
      outgoingHooks: [],
      beforeSendHooks: [],
      afterSendHooks: [],
      waitUntil() {},
      logger: {
        warn() {},
        error() {},
      },
      generateId() {
        return 'id_1';
      },
      toConnectionInfo() {
        throw new Error('unused');
      },
    };

    broadcastToChannel(
      runtime as unknown as Parameters<typeof broadcastToChannel>[0],
      'room:general',
      'message',
      { text: 'hi' },
      undefined,
      'rooms',
    );

    expect(roomsMember.descriptor.send).toHaveBeenCalledTimes(1);
    expect(lobbiesMember.descriptor.send).not.toHaveBeenCalled();
  });

  it('rejects incoming channel traffic when only a same-name membership exists in another scope', async () => {
    const handler = vi.fn();
    const errors: Array<{ error: unknown; event?: string; routing?: unknown }> = [];
    const connection = createConnection('conn_1');
    addMembership(connection, 'room:general', 'lobbies');

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        preIntercepts: [],
        postIntercepts: new Map(),
        namespaces: new Map(),
        channels: new Map(),
        channelFamilies: new Map([
          [
            'rooms',
            {
              key: 'rooms',
              kind: 'channel' as const,
              pattern: { key: 'rooms', pattern: /^room:/ },
              outgoing: new Map(),
              incoming: new Map([['message', { event: 'message', handler, validator: undefined }]]),
              requests: new Map(),
              streams: new Map(),
              preIntercepts: [],
              postIntercepts: new Map(),
            },
          ],
        ]),
        scheduled: new Map(),
        modules: [],
        requires: {},
        replayClaimedChannelKeys: new Set(),
      },
      connections: new Map([[connection.id, connection]]),
      toConnectionInfo() {
        throw new Error('unused');
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      moduleRuntimes: [],
      errorHooks: [],
      requireTimers() {
        return {
          setTimeout() {
            return undefined;
          },
          clearTimeout() {},
        };
      },
      buildConnectionContext() {
        return { id: connection.id };
      },
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      setActiveConnectionId() {},
      async handleRuntimeError(_conn: unknown, error: unknown, event?: string, routing?: unknown) {
        errors.push({ error, event, routing });
      },
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    expect(
      resolveScope(runtime.compiled as unknown as CompiledServer, {
        _channel: 'room:general',
        _channelScope: 'rooms',
      }),
    ).toEqual({
      channel: runtime.compiled.channelFamilies.get('rooms'),
      channelName: 'room:general',
      channelScope: 'rooms',
    });

    await dispatchIncoming(
      runtime as unknown as Parameters<typeof dispatchIncoming>[0],
      connection,
      'message',
      {
        _channel: 'room:general',
        _channelScope: 'rooms',
        text: 'hi',
      },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.event).toBe('message');
    expect(errors[0]!.routing).toEqual({
      _channel: 'room:general',
      _channelScope: 'rooms',
    });
    expect((errors[0]!.error as { code?: string }).code).toBe('channel-not-subscribed');
  });

  it('resolveScope throws NamespaceNotFound when _namespace targets an unregistered namespace', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() => resolveScope(compiled, { _namespace: 'typo' })).toThrowError(
      /namespace-not-found/i,
    );
  });

  it('resolveScope throws ChannelNotFound when _channel targets an unregistered static channel', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(), // 'unknown-room' not registered
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() => resolveScope(compiled, { _channel: 'unknown-room' })).toThrowError(
      /channel-not-found/i,
    );
  });

  it('resolveScope throws ChannelNotFound when _channelScope targets an unregistered family', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map(), // 'unknown-family' not registered
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { _channel: 'room:1', _channelScope: 'unknown-family' }),
    ).toThrowError(/channel-not-found/i);
  });

  it('resolveScope throws ChannelNotFound when _channel does not match the family regex', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map([
        [
          'rooms',
          {
            key: 'rooms',
            kind: 'channel' as const,
            pattern: { key: 'rooms', pattern: /^room:/ },
            outgoing: new Map(),
            incoming: new Map(),
            requests: new Map(),
            streams: new Map(),
            preIntercepts: [],
            postIntercepts: new Map(),
          },
        ],
      ]),
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { _channel: 'admin', _channelScope: 'rooms' }),
    ).toThrowError(/channel-not-found/i);
  });

  it('resolveScope returns the scope when _channel matches the family regex', () => {
    const family = {
      key: 'rooms',
      kind: 'channel' as const,
      pattern: { key: 'rooms', pattern: /^room:/ },
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      preIntercepts: [],
      postIntercepts: new Map(),
    };
    const compiled = {
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map([['rooms', family]]),
    } as unknown as CompiledServer;

    expect(resolveScope(compiled, { _channel: 'room:lobby', _channelScope: 'rooms' })).toEqual({
      channel: family,
      channelName: 'room:lobby',
      channelScope: 'rooms',
    });
  });

  it('routes ValidationFailed thrown from a handler to handleValidationError', async () => {
    const { ValidationFailed } = await import('@wskit/core');
    const validationErrors: string[] = [];
    const runtimeErrors: unknown[] = [];
    const connection = createConnection('conn_1');

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map([
          [
            'manual-check',
            {
              event: 'manual-check',
              handler: () => {
                throw ValidationFailed({
                  event: 'test-event',
                  issues: [{ message: 'bad' }],
                });
              },
              validator: undefined,
            },
          ],
        ]),
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
      },
      connections: new Map([[connection.id, connection]]),
      toConnectionInfo() {
        return { id: connection.id };
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      moduleRuntimes: [],
      errorHooks: [],
      requireTimers() {
        return { setTimeout: () => undefined, clearTimeout() {} };
      },
      buildConnectionContext() {
        return { id: connection.id };
      },
      broadcastToConnections() {},
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      setActiveConnectionId() {},
      async handleRuntimeError(_conn: unknown, error: unknown) {
        runtimeErrors.push(error);
      },
      async handleValidationError(_conn: unknown, event: string) {
        validationErrors.push(event);
      },
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await dispatchIncoming(
      runtime as unknown as Parameters<typeof dispatchIncoming>[0],
      connection,
      'manual-check',
      {},
    );

    expect(validationErrors).toEqual(['manual-check']);
    expect(runtimeErrors).toHaveLength(1);
  });

  it('propagates WskitConfigError without routing through handleValidationError (async validator)', async () => {
    const handleValidationError = vi.fn();
    const handleRuntimeError = vi.fn();
    const handler = vi.fn();
    const connection = createConnection('conn_1');

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map([
          [
            'do-thing',
            {
              event: 'do-thing',
              handler,
              validator: (value: unknown) => Promise.resolve(value),
            },
          ],
        ]),
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
      },
      connections: new Map([[connection.id, connection]]),
      toConnectionInfo() {
        return { id: connection.id };
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      moduleRuntimes: [],
      errorHooks: [],
      requireTimers() {
        return { setTimeout: () => undefined, clearTimeout() {} };
      },
      buildConnectionContext() {
        return { id: connection.id };
      },
      broadcastToConnections() {},
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      setActiveConnectionId() {},
      handleRuntimeError,
      handleValidationError,
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await expect(
      dispatchIncoming(
        runtime as unknown as Parameters<typeof dispatchIncoming>[0],
        connection,
        'do-thing',
        {},
      ),
    ).rejects.toThrow(/async validators are not supported/);

    expect(handleValidationError).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires handleValidationError exactly once when a schema validator rejects a payload', async () => {
    const handleValidationError = vi.fn();
    const handleRuntimeError = vi.fn();
    const handler = vi.fn();
    const connection = createConnection('conn_1');

    // Standard Schema-shaped validator that always returns issues.
    const rejectingSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ issues: [{ message: 'bad' }] }),
      },
    };

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map([
          ['send-strict', { event: 'send-strict', handler, validator: rejectingSchema }],
        ]),
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
      },
      connections: new Map([[connection.id, connection]]),
      toConnectionInfo() {
        return { id: connection.id };
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      moduleRuntimes: [],
      errorHooks: [],
      requireTimers() {
        return { setTimeout: () => undefined, clearTimeout() {} };
      },
      buildConnectionContext() {
        return { id: connection.id };
      },
      broadcastToConnections() {},
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      setActiveConnectionId() {},
      handleRuntimeError,
      handleValidationError,
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await dispatchIncoming(
      runtime as unknown as Parameters<typeof dispatchIncoming>[0],
      connection,
      'send-strict',
      {},
    );

    // Schema validation rejected the payload. Validation hook fires once
    // (regression test for the prior double-fire bug — the inner catch
    // routed the error AND the outer dispatch error path matched
    // 'validation-failed' and routed it again).
    expect(handleValidationError).toHaveBeenCalledTimes(1);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a thrown request handler error preserves _correlationId on the error frame', async () => {
    // Pre-fix handleDispatchError called handleRuntimeError without
    // routing, so the _error frame the client received carried no
    // correlation id and the request-response plugin could not settle
    // the pending request — it hung until timeout.
    const handleRuntimeError = vi.fn();
    const connection = createConnection('conn_1');

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map([
          [
            'get-user',
            {
              event: 'get-user',
              validator: undefined,
              responseValidator: undefined,
              handler: () => {
                throw new Error('NotFound');
              },
            },
          ],
        ]),
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
      },
      connections: new Map([[connection.id, connection]]),
      toConnectionInfo() {
        return { id: connection.id };
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      moduleRuntimes: [],
      errorHooks: [],
      requireTimers() {
        return { setTimeout: () => undefined, clearTimeout() {} };
      },
      buildConnectionContext() {
        return { id: connection.id };
      },
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      setActiveConnectionId() {},
      handleRuntimeError,
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      sendThroughPipeline: () => true,
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await dispatchIncoming(
      runtime as unknown as Parameters<typeof dispatchIncoming>[0],
      connection,
      'get-user',
      { id: 'u1', _correlationId: 'corr-42' },
    );

    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, , , routing] = handleRuntimeError.mock.calls[0]!;
    expect(routing).toEqual({ _correlationId: 'corr-42' });
  });

  it('does not fall back to top-level handlers for events sent inside a channel scope', async () => {
    // A channel-subscribed client sending an event with `_channel: '...'`
    // must hit only handlers declared inside that channel. Falling through
    // to top-level handlers would let any channel member fire any
    // top-level event by tagging it with the channel — breaking scope
    // isolation.
    const topLevelHandler = vi.fn();
    const connection = createConnection('conn_1');
    addMembership(connection, 'room', undefined);

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map([
          ['top-only', { event: 'top-only', handler: topLevelHandler, validator: undefined }],
        ]),
        requests: new Map(),
        streams: new Map(),
        preIntercepts: [],
        postIntercepts: new Map(),
        namespaces: new Map(),
        channels: new Map([
          [
            'room',
            {
              key: 'room',
              kind: 'channel' as const,
              pattern: 'room',
              outgoing: new Map(),
              incoming: new Map(), // channel does NOT register 'top-only'
              requests: new Map(),
              streams: new Map(),
              preIntercepts: [],
              postIntercepts: new Map(),
            },
          ],
        ]),
        channelFamilies: new Map(),
        scheduled: new Map(),
        modules: [],
        requires: {},
        replayClaimedChannelKeys: new Set(),
      },
      connections: new Map([[connection.id, connection]]),
      toConnectionInfo() {
        return { id: connection.id };
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      moduleRuntimes: [],
      errorHooks: [],
      requireTimers() {
        return { setTimeout: () => undefined, clearTimeout() {} };
      },
      buildConnectionContext() {
        return { id: connection.id };
      },
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      setActiveConnectionId() {},
      async handleRuntimeError() {},
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await dispatchIncoming(
      runtime as unknown as Parameters<typeof dispatchIncoming>[0],
      connection,
      'top-only',
      { _channel: 'room' },
    );

    expect(topLevelHandler).not.toHaveBeenCalled();
  });

  it('routes a thrown scope-resolution error to handleRuntimeError instead of rejecting', async () => {
    const connection = createConnection('conn_1');
    const handleRuntimeError = vi.fn();

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        preIntercepts: [],
        postIntercepts: new Map(),
        namespaces: new Map(),
        channels: new Map(),
        // Family pattern requires room:N. The replay payload below uses the
        // family key but a name that fails the regex, so resolveScope throws
        // ChannelNotFound.
        channelFamilies: new Map([
          [
            'rooms',
            {
              key: 'rooms',
              kind: 'channel' as const,
              pattern: { key: 'rooms', pattern: /^room:\d+$/ },
              outgoing: new Map(),
              incoming: new Map(),
              requests: new Map(),
              streams: new Map(),
              preIntercepts: [],
              postIntercepts: new Map(),
            },
          ],
        ]),
        scheduled: new Map(),
        modules: [],
        requires: {},
        replayClaimedChannelKeys: new Set(),
      },
      connections: new Map([[connection.id, connection]]),
      toConnectionInfo() {
        return { id: connection.id };
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      moduleRuntimes: [],
      errorHooks: [],
      activityHooks: [],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      requireTimers() {
        return { setTimeout: () => undefined, clearTimeout() {} };
      },
      buildConnectionContext() {
        return { id: connection.id };
      },
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      setActiveConnectionId() {},
      handleRuntimeError,
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await expect(
      processTextMessage(
        runtime as unknown as Parameters<typeof processTextMessage>[0],
        connection,
        JSON.stringify({
          event: '_replay',
          payload: { _channel: 'admin', _channelScope: 'rooms', since: 0 },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, error, event, routing] = handleRuntimeError.mock.calls[0]!;
    expect((error as { code?: string }).code).toBe('channel-not-found');
    expect(event).toBe('_replay');
    expect(routing).toEqual({ _channel: 'admin', _channelScope: 'rooms' });
  });
});
