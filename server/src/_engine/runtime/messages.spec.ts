import { ENGINE_ACK_ID } from '~/_engine/contexts/types.ts';
import {
  broadcastToChannel,
  dispatchIncoming,
  processTextMessage,
  resolveScope,
} from '~/_engine/runtime/messages.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { CompiledServer } from '~/_engine/compile/types.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      sendBinary() {},
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: id,
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map<string, { channelName: string; channelScope: string | null }>(),
    latency: null,
    quality: 'good',
  };
}

function addMembership(
  connection: ReturnType<typeof createConnection>,
  channelName: string,
  channelScope: string | null = null,
) {
  connection.channelMemberships.set(createChannelMembershipKey(channelName, channelScope), {
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
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
              resumableStreams: new Map(),
              recordedStreams: new Map(),
              preIntercepts: [],
              postIntercepts: new Map(),
            },
          ],
        ]),
      },
      moduleRuntimes: [],
      outgoingHooks: [],
      beforeSendHooks: [],
      wskitStampHooks: [],
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
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
              resumableStreams: new Map(),
              recordedStreams: new Map(),
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
        channel: 'room:general',
        channelScope: 'rooms',
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
      { text: 'hi' },
      { channel: 'room:general', channelScope: 'rooms' },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.event).toBe('message');
    expect(errors[0]!.routing).toEqual({
      channel: 'room:general',
      channelScope: 'rooms',
    });
    expect((errors[0]!.error as { code?: string }).code).toBe('channel-not-subscribed');
  });

  it('ctx.ack() ack id rides on each dispatch ctx, not a shared connection field', async () => {
    // Regression: two messages on one connection interleave at an await. The
    // ack id must travel on each dispatch's own ctx — a shared connection
    // field gets overwritten by the second message before the first acks.
    const connection = createConnection('conn_1');
    const acked: Array<{ which: unknown; ackId: unknown }> = [];

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    async function handler(ctx: Record<PropertyKey, unknown>, payload: { which: string }) {
      if (payload.which === 'A') await gateA;
      acked.push({ which: payload.which, ackId: ctx[ENGINE_ACK_ID] });
    }

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map([['msg', { event: 'msg', handler, validator: undefined }]]),
        requests: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
      async handleRuntimeError() {},
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    const pA = dispatchIncoming(
      runtime as unknown as Parameters<typeof dispatchIncoming>[0],
      connection,
      'msg',
      { which: 'A' },
      { ackId: 'ack-a', channelScope: null },
    );
    const pB = dispatchIncoming(
      runtime as unknown as Parameters<typeof dispatchIncoming>[0],
      connection,
      'msg',
      { which: 'B' },
      { ackId: 'ack-b', channelScope: null },
    );
    releaseA();
    await Promise.all([pA, pB]);

    expect(acked).toContainEqual({ which: 'A', ackId: 'ack-a' });
    expect(acked).toContainEqual({ which: 'B', ackId: 'ack-b' });
  });

  it('resolveScope throws NamespaceNotFound when namespace targets an unregistered namespace', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() => resolveScope(compiled, { namespace: 'typo', channelScope: null })).toThrowError(
      /namespace-not-found/i,
    );
  });

  it('resolveScope throws InvalidScopeMarkers when both namespace and channel are set', () => {
    const compiled = {
      namespaces: new Map([['admin', { name: 'admin' }]]),
      channels: new Map([['private-room', { pattern: 'private-room' }]]),
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { namespace: 'admin', channel: 'private-room', channelScope: null }),
    ).toThrowError(/invalid-scope-markers/i);
  });

  it('resolveScope throws ChannelNotFound when channel targets an unregistered static channel', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(), // 'unknown-room' not registered
      channelFamilies: new Map(),
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { channel: 'unknown-room', channelScope: null }),
    ).toThrowError(/channel-not-found/i);
  });

  it('resolveScope throws ChannelNotFound when channelScope targets an unregistered family', () => {
    const compiled = {
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map(), // 'unknown-family' not registered
    } as unknown as CompiledServer;

    expect(() =>
      resolveScope(compiled, { channel: 'room:1', channelScope: 'unknown-family' }),
    ).toThrowError(/channel-not-found/i);
  });

  it('resolveScope throws ChannelNotFound when channel does not match the family regex', () => {
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
            resumableStreams: new Map(),
            recordedStreams: new Map(),
            preIntercepts: [],
            postIntercepts: new Map(),
          },
        ],
      ]),
    } as unknown as CompiledServer;

    expect(() => resolveScope(compiled, { channel: 'admin', channelScope: 'rooms' })).toThrowError(
      /channel-not-found/i,
    );
  });

  it('resolveScope returns the scope when channel matches the family regex', () => {
    const family = {
      key: 'rooms',
      kind: 'channel' as const,
      pattern: { key: 'rooms', pattern: /^room:/ },
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      preIntercepts: [],
      postIntercepts: new Map(),
    };
    const compiled = {
      namespaces: new Map(),
      channels: new Map(),
      channelFamilies: new Map([['rooms', family]]),
    } as unknown as CompiledServer;

    expect(resolveScope(compiled, { channel: 'room:lobby', channelScope: 'rooms' })).toEqual({
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
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
      undefined,
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
              validator: v.objectAsync({}),
            },
          ],
        ]),
        requests: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
        undefined,
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
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
      undefined,
    );

    // Schema validation rejected the payload. Validation hook fires once
    // (regression test for the prior double-fire bug — the inner catch
    // routed the error AND the outer dispatch error path matched
    // 'validation-failed' and routed it again).
    expect(handleValidationError).toHaveBeenCalledTimes(1);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('manual ValidationFailed thrown from a channel handler reaches handleValidationError with the resolved scope', async () => {
    // Pre-fix the outer dispatch catch called handleValidationError
    // without scope, so onValidationError hooks saw a top-level ctx (no
    // ctx.channel / ctx.namespace) for manually-thrown ValidationFailed
    // — but a properly scoped ctx for schema-failed payloads. Same hook,
    // two different shapes.
    const { ValidationFailed } = await import('@wskit/core');
    const handleValidationError = vi.fn();
    const handleRuntimeError = vi.fn();
    const connection = createConnection('conn_1');
    addMembership(connection, 'room', undefined);

    const channel = {
      key: 'room',
      kind: 'channel' as const,
      pattern: 'room',
      outgoing: new Map(),
      incoming: new Map([
        [
          'manual-check',
          {
            event: 'manual-check',
            validator: undefined,
            handler: () => {
              throw ValidationFailed({
                event: 'manual-check',
                issues: [{ message: 'manual semantic check failed' }],
              });
            },
          },
        ],
      ]),
      requests: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      preIntercepts: [],
      postIntercepts: new Map(),
    };

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        preIntercepts: [],
        postIntercepts: new Map(),
        namespaces: new Map(),
        channels: new Map([['room', channel]]),
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
      handleValidationError,
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
      'manual-check',
      {},
      { channel: 'room', channelScope: null },
    );

    expect(handleValidationError).toHaveBeenCalledTimes(1);
    const [, , , scope] = handleValidationError.mock.calls[0]!;
    expect(scope).toBeDefined();
    expect((scope as { channelName?: string }).channelName).toBe('room');
    expect((scope as { channel?: unknown }).channel).toBe(channel);
  });

  it('a schema-failed request preserves correlationId on the error frame', async () => {
    // The inner schema-validation catch (validateValue throws) is a
    // separate code path from the outer dispatch catch. The outer-catch
    // routing fix (commit 8789c0a) didn't touch this branch — schema
    // failures still went out uncorrelated. Same hang-until-timeout
    // symptom on the client request-response plugin.
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
              validator: v.object({ id: v.string() }),
              responseValidator: undefined,
              handler: () => {},
            },
          ],
        ]),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
      { id: 42 }, // wrong type — schema fails
      { correlationId: 'corr-99', channelScope: null },
    );

    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, , , routing] = handleRuntimeError.mock.calls[0]!;
    expect(routing).toEqual({ correlationId: 'corr-99' });
  });

  it('a thrown request handler error preserves correlationId on the error frame', async () => {
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
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
      { id: 'u1' },
      { correlationId: 'corr-42', channelScope: null },
    );

    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, , , routing] = handleRuntimeError.mock.calls[0]!;
    expect(routing).toEqual({ correlationId: 'corr-42' });
  });

  it('does not fall back to top-level handlers for events sent inside a channel scope', async () => {
    // A channel-subscribed client sending an event with `channel: '...'`
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
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
              resumableStreams: new Map(),
              recordedStreams: new Map(),
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
      {},
      { channel: 'room', channelScope: null },
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
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
              resumableStreams: new Map(),
              recordedStreams: new Map(),
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
          event: '__replay__',
          payload: {},
          __wskit: { channel: 'admin', channelScope: 'rooms' },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, error, event, routing] = handleRuntimeError.mock.calls[0]!;
    expect((error as { code?: string }).code).toBe('channel-not-found');
    expect(event).toBe('__replay__');
    expect(routing).toEqual({ channel: 'admin', channelScope: 'rooms' });
  });

  it('rejects a __subscribe__ frame whose __wskit.channel is not a string', async () => {
    // A non-string `channel` fails the protocol-frame schema parse, so the
    // frame settles as a ValidationFailed routed through handleRuntimeError
    // instead of reaching handleSubscribe with a bad channel.
    const connection = createConnection('conn_1');
    const handleRuntimeError = vi.fn();
    const handleSubscribe = vi.fn();

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
      handleSubscribe,
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({
        event: '__subscribe__',
        payload: {},
        __wskit: { channel: 42, channelScope: 'rooms' },
      }),
    );

    expect(handleSubscribe).not.toHaveBeenCalled();
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, error, event] = handleRuntimeError.mock.calls[0]!;
    expect(event).toBe('__subscribe__');
    expect((error as { code?: string }).code).toBe('validation-failed');
  });

  it('rejects an __unsubscribe__ frame whose __wskit.channel is not a string', async () => {
    const connection = createConnection('conn_1');
    const handleRuntimeError = vi.fn();
    const handleUnsubscribe = vi.fn();

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
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
      handleUnsubscribe,
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({
        event: '__unsubscribe__',
        payload: {},
        __wskit: { channel: { id: 1 }, channelScope: 99 },
      }),
    );

    expect(handleUnsubscribe).not.toHaveBeenCalled();
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, error, event] = handleRuntimeError.mock.calls[0]!;
    expect(event).toBe('__unsubscribe__');
    expect((error as { code?: string }).code).toBe('validation-failed');
  });
});

describe('getChannelMembers scope isolation', () => {
  it('returns only static members when called with null scope', async () => {
    const { getChannelMembers } = await import('~/_engine/runtime/messages.ts');
    const staticMember = createConnection('static');
    const familyMember = createConnection('family');
    addMembership(staticMember, 'lobby', null);
    addMembership(familyMember, 'lobby', 'rooms');

    const runtime = {
      connections: new Map([
        [staticMember.id, staticMember],
        [familyMember.id, familyMember],
      ]),
      compiled: {} as CompiledServer,
      toConnectionInfo: (c: RuntimeConnection) => ({
        id: c.id,
        identity: c.identity,
        meta: c.meta,
        tags: [],
        channels: [...c.channelMemberships.values()].map((m) => m.channelName),
        latency: null,
        quality: 'good' as const,
        bufferedAmount: 0,
        ref: () => ({
          __wskit: 'connection-ref' as const,
          id: c.id,
          instance: undefined,
          identity: c.identity,
        }),
      }),
      sendThroughPipeline: () => true,
    };

    const result = getChannelMembers(runtime, 'lobby', null);
    expect(result.map((r) => r.id)).toEqual(['static']);
  });

  it('returns only the matching family members when called with a family key', async () => {
    const { getChannelMembers } = await import('~/_engine/runtime/messages.ts');
    const staticMember = createConnection('static');
    const familyMember = createConnection('family');
    const otherFamilyMember = createConnection('other');
    addMembership(staticMember, 'lobby', null);
    addMembership(familyMember, 'lobby', 'rooms');
    addMembership(otherFamilyMember, 'lobby', 'lobbies');

    const runtime = {
      connections: new Map([
        [staticMember.id, staticMember],
        [familyMember.id, familyMember],
        [otherFamilyMember.id, otherFamilyMember],
      ]),
      compiled: {} as CompiledServer,
      toConnectionInfo: (c: RuntimeConnection) => ({
        id: c.id,
        identity: c.identity,
        meta: c.meta,
        tags: [],
        channels: [...c.channelMemberships.values()].map((m) => m.channelName),
        latency: null,
        quality: 'good' as const,
        bufferedAmount: 0,
        ref: () => ({
          __wskit: 'connection-ref' as const,
          id: c.id,
          instance: undefined,
          identity: c.identity,
        }),
      }),
      sendThroughPipeline: () => true,
    };

    const result = getChannelMembers(runtime, 'lobby', 'rooms');
    expect(result.map((r) => r.id)).toEqual(['family']);
  });
});
