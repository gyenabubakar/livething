import { ENGINE_ACK_ID } from '~/_engine/contexts/types.ts';
import {
  broadcastToChannel,
  dispatchIncoming,
  processTextMessage,
} from '~/_engine/runtime/messages.ts';
import { resolveScope } from '~/_engine/runtime/scope.ts';
import { addChannelMembership } from '~/channel/runtime.ts';
import { Defer } from '~/errors/errors.ts';
import { localKey } from '~/local-key/local-key.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { CompiledServer } from '~/_engine/compile/types.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendRuntimeErrorOptions } from '~/errors/runtime.ts';

function createConnection(id: string): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
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

interface AddMembershipOptions {
  channelName: string;
  channelScope?: string | null;
}

function addMembership(
  channelMembers: Map<string, Set<RuntimeConnection>>,
  connection: ReturnType<typeof createConnection>,
  { channelName, channelScope = null }: AddMembershipOptions,
) {
  addChannelMembership(channelMembers, connection, { channelName, channelScope });
}

describe('message runtime', () => {
  it('broadcastToChannel only targets members of the matching channel scope', () => {
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const roomsMember = createConnection('rooms');
    const lobbiesMember = createConnection('lobbies');

    addMembership(channelMembers, roomsMember, {
      channelName: 'room:general',
      channelScope: 'rooms',
    });
    addMembership(channelMembers, lobbiesMember, {
      channelName: 'room:general',
      channelScope: 'lobbies',
    });

    const runtime = {
      connections: new Map([
        [roomsMember.id, roomsMember],
        [lobbiesMember.id, lobbiesMember],
      ]),
      channelMembers,
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
              intercepts: [],
            },
          ],
        ]),
      },
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

    broadcastToChannel(runtime as unknown as Parameters<typeof broadcastToChannel>[0], {
      channelName: 'room:general',
      event: 'message',
      payload: { text: 'hi' },
      excludeConnectionId: undefined,
      channelScope: 'rooms',
    });

    expect(roomsMember.descriptor.send).toHaveBeenCalledTimes(1);
    expect(lobbiesMember.descriptor.send).not.toHaveBeenCalled();
  });

  it('rejects incoming channel traffic when only a same-name membership exists in another scope', async () => {
    const handler = vi.fn();
    const errors: Array<{ error: unknown; event?: string; routing?: unknown }> = [];
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1');
    addMembership(channelMembers, connection, {
      channelName: 'room:general',
      channelScope: 'lobbies',
    });

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        intercepts: [],
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
              intercepts: [],
            },
          ],
        ]),
        scheduled: new Map(),
        requires: {},
        replayClaimedChannelKeys: new Set(),
      },
      connections: new Map([[connection.id, connection]]),
      channelMembers,
      toConnectionInfo() {
        throw new Error('unused');
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
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
      async handleRuntimeError(_conn: unknown, { error, event, routing }: SendRuntimeErrorOptions) {
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
      {
        event: 'message',
        payload: { text: 'hi' },
        wskit: { channel: 'room:general', channelScope: 'rooms' },
      },
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
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
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
      { event: 'msg', payload: { which: 'A' }, wskit: { ackId: 'ack-a', channelScope: null } },
    );
    const pB = dispatchIncoming(
      runtime as unknown as Parameters<typeof dispatchIncoming>[0],
      connection,
      { event: 'msg', payload: { which: 'B' }, wskit: { ackId: 'ack-b', channelScope: null } },
    );
    releaseA();
    await Promise.all([pA, pB]);

    expect(acked).toContainEqual({ which: 'A', ackId: 'ack-a' });
    expect(acked).toContainEqual({ which: 'B', ackId: 'ack-b' });
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
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
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
      async handleRuntimeError(_conn: unknown, error: unknown) {
        runtimeErrors.push(error);
      },
      async handleValidationError(_conn: unknown, { event }: { event: string }) {
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
      { event: 'manual-check', payload: {}, wskit: undefined },
    );

    expect(validationErrors).toEqual(['manual-check']);
    expect(runtimeErrors).toHaveLength(1);
  });

  it('propagates WSKitConfigError without routing through handleValidationError (async validator)', async () => {
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
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
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
      dispatchIncoming(runtime as unknown as Parameters<typeof dispatchIncoming>[0], connection, {
        event: 'do-thing',
        payload: {},
        wskit: undefined,
      }),
    ).rejects.toThrow(/async validators are not supported/);

    expect(handleValidationError).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('fires handleValidationError exactly once when a schema validator rejects a payload', async () => {
    const handleValidationError = vi.fn();
    const handleRuntimeError = vi.fn();
    const handler = vi.fn();
    const connection = createConnection('conn_1');

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
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
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
      { event: 'send-strict', payload: {}, wskit: undefined },
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
    // ctx.channel) for manually-thrown ValidationFailed
    // — but a properly scoped ctx for schema-failed payloads. Same hook,
    // two different shapes.
    const { ValidationFailed } = await import('@wskit/core');
    const handleValidationError = vi.fn();
    const handleRuntimeError = vi.fn();
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1');
    addMembership(channelMembers, connection, { channelName: 'room' });

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
      intercepts: [],
    };

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        intercepts: [],
        channels: new Map([['room', channel]]),
        channelFamilies: new Map(),
        scheduled: new Map(),
        requires: {},
        replayClaimedChannelKeys: new Set(),
      },
      connections: new Map([[connection.id, connection]]),
      channelMembers,
      toConnectionInfo() {
        return { id: connection.id };
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
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
      { event: 'manual-check', payload: {}, wskit: { channel: 'room', channelScope: null } },
    );

    expect(handleValidationError).toHaveBeenCalledTimes(1);
    const [, { scope }] = handleValidationError.mock.calls[0]!;
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
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
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
      {
        event: 'get-user',
        payload: { id: 42 },
        wskit: { correlationId: 'corr-99', channelScope: null },
      }, // wrong type — schema fails
    );

    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, { routing }] = handleRuntimeError.mock.calls[0]!;
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
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
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
      {
        event: 'get-user',
        payload: { id: 'u1' },
        wskit: { correlationId: 'corr-42', channelScope: null },
      },
    );

    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, { routing }] = handleRuntimeError.mock.calls[0]!;
    expect(routing).toEqual({ correlationId: 'corr-42' });
  });

  it('request handlers reuse the intercept ctx so inject sees values provided earlier in the dispatch', async () => {
    const providedKey = localKey<{ tag: string }>('provided');
    const connection = createConnection('conn_1');
    connection.descriptor.send = vi.fn();
    const locals = new Map<unknown, unknown>();
    const sharedCtx = {
      id: connection.id,
      provide(key: unknown, value: unknown) {
        locals.set(key, value);
      },
      inject(key: unknown) {
        return locals.get(key);
      },
    };

    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map([
          [
            'lookup',
            {
              event: 'lookup',
              validator: undefined,
              responseValidator: undefined,
              handler: (ctx: typeof sharedCtx & { respond: (value: unknown) => void }) => {
                ctx.respond({
                  tag: (ctx.inject(providedKey) as { tag: string } | undefined)?.tag ?? 'none',
                });
              },
            },
          ],
        ]),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        intercepts: [
          {
            handler: (ctx: typeof sharedCtx) => {
              ctx.provide(providedKey, { tag: 'top' });
            },
          },
        ],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
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
      outgoingHooks: [],
      wskitStampHooks: [],
      beforeSendHooks: [],
      afterSendHooks: [],
      errorHooks: [],
      buildConnectionContext() {
        return sharedCtx;
      },
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      async handleRuntimeError() {},
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      logger: { warn() {}, error() {} },
      generateId() {
        return 'id_1';
      },
    };

    await dispatchIncoming(
      runtime as unknown as Parameters<typeof dispatchIncoming>[0],
      connection,
      {
        event: 'lookup',
        payload: {},
        wskit: { correlationId: 'corr-ctx', channelScope: null },
      },
    );

    expect(connection.descriptor.send).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse((connection.descriptor.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]),
    ).toEqual({
      event: 'lookup',
      payload: { tag: 'top' },
      __wskit: { correlationId: 'corr-ctx', source: 'client' },
    });
  });

  it('does not fall back to top-level handlers for events sent inside a channel scope', async () => {
    // A channel-subscribed client sending an event with `channel: '...'`
    // must hit only handlers declared inside that channel. Falling through
    // to top-level handlers would let any channel member fire any
    // top-level event by tagging it with the channel — breaking scope
    // isolation.
    const topLevelHandler = vi.fn();
    const channelMembers = new Map<string, Set<RuntimeConnection>>();
    const connection = createConnection('conn_1');
    addMembership(channelMembers, connection, { channelName: 'room' });

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
        intercepts: [],
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
              intercepts: [],
            },
          ],
        ]),
        channelFamilies: new Map(),
        scheduled: new Map(),
        requires: {},
        replayClaimedChannelKeys: new Set(),
      },
      connections: new Map([[connection.id, connection]]),
      channelMembers,
      toConnectionInfo() {
        return { id: connection.id };
      },
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
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
      { event: 'top-only', payload: {}, wskit: { channel: 'room', channelScope: null } },
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
        intercepts: [],
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
              intercepts: [],
            },
          ],
        ]),
        scheduled: new Map(),
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
    const [, { error, event, routing }] = handleRuntimeError.mock.calls[0]!;
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
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
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
    const [, { error, event }] = handleRuntimeError.mock.calls[0]!;
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
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
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
    const [, { error, event }] = handleRuntimeError.mock.calls[0]!;
    expect(event).toBe('__unsubscribe__');
    expect((error as { code?: string }).code).toBe('validation-failed');
  });

  it('replies UnsupportedProtocol for a __replay__ frame when no replay handler owns the scope', async () => {
    // Replay off (or off for this scope) means no `__replay__` handler is
    // registered. Instead of silently dropping the frame, the server tells the
    // client the protocol feature is unsupported.
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
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
        requires: {},
        replayClaimedChannelKeys: new Set(),
      },
      connections: new Map([[connection.id, connection]]),
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      errorHooks: [],
      activityHooks: [],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      buildConnectionContext() {
        return { id: connection.id };
      },
      sendProtocolMessage() {},
      sendReplay() {},
      persistAttachment() {},
      handleRuntimeError,
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({ event: '__replay__', payload: {}, __wskit: {} }),
    );

    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, { error, event }] = handleRuntimeError.mock.calls[0]!;
    expect(event).toBe('__replay__');
    expect((error as { code?: string }).code).toBe('unsupported-protocol');
    expect((error as { detail?: { event?: string } }).detail?.event).toBe('__replay__');
  });

  it('replies UnsupportedProtocol for a __resumeStream__ frame when the adapter has no storage', async () => {
    // No storage means durable streams aren't supported at all. The reply names
    // the unsupported protocol event and keeps the streamId so the client's
    // stream layer surfaces it to the resuming consumer.
    const connection = createConnection('conn_1');
    const sent: Array<{
      event: string;
      payload: Record<string, unknown>;
      wskit: Record<string, unknown>;
    }> = [];

    const runtime = {
      compiled: {
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
      },
      connections: new Map([[connection.id, connection]]),
      activeStreams: new Map(),
      protocolHandlers: new Map(),
      incomingHooks: [],
      errorHooks: [],
      activityHooks: [],
      // no `sql` → storage absent
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      buildConnectionContext() {
        return { id: connection.id };
      },
      sendProtocolMessage(_connection: RuntimeConnection, message: (typeof sent)[number]) {
        sent.push(message);
      },
      sendReplay() {},
      persistAttachment() {},
      async handleRuntimeError() {},
      async handleValidationError() {},
      async handleSubscribe() {},
      async handleUnsubscribe() {},
      waitUntil() {},
      generateId() {
        return 'id_1';
      },
    };

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({ event: '__resumeStream__', payload: {}, __wskit: { streamId: 's-1' } }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe('__error__');
    expect(sent[0]!.payload.code).toBe('unsupported-protocol');
    expect((sent[0]!.payload.detail as { event?: string }).event).toBe('__resumeStream__');
    expect(sent[0]!.wskit.streamId).toBe('s-1');
  });
});

function makeScopedNode(intercepts: unknown[] = []) {
  return {
    intercepts,
    streams: new Map(),
    resumableStreams: new Map(),
    recordedStreams: new Map(),
  };
}

interface MakeNudgeRuntimeOptions {
  handleRuntimeError?: ReturnType<typeof vi.fn>;
  channels?: Map<string, unknown>;
}

function makeNudgeRuntime(
  intercepts: unknown[],
  activeStreams: Map<string, unknown>,
  opts: MakeNudgeRuntimeOptions = {},
) {
  const { handleRuntimeError = vi.fn(), channels = new Map() } = opts;
  return {
    compiled: {
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      intercepts,
      channels,
      channelFamilies: new Map(),
      scheduled: new Map(),
      requires: {},
      replayClaimedChannelKeys: new Set(),
    },
    connections: new Map(),
    activeStreams,
    protocolHandlers: new Map(),
    incomingHooks: [],
    errorHooks: [],
    activityHooks: [],
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    incomingDedupCap: 0,
    durableStreamSchemaReady: false,
    buildConnectionContext: () => ({}),
    handleRuntimeError,
    async handleValidationError() {},
    async handleSubscribe() {},
    async handleUnsubscribe() {},
    sendProtocolMessage() {},
    sendReplay() {},
    persistAttachment() {},
    requireTimers() {
      return { setTimeout: () => undefined, clearTimeout() {} };
    },
    waitUntil() {},
    generateId() {
      return 'id_1';
    },
    toConnectionInfo() {
      throw new Error('unused');
    },
  };
}

function makeActiveStream(connectionId: string, nudgeEvent: string) {
  return {
    id: 'stream_1',
    connectionId,
    event: 'my-stream',
    generator: (async function* () {})(),
    nudges: [] as { event: string; payload: unknown }[],
    nudgeValidators: new Map([[nudgeEvent, undefined]]),
    closed: false,
  };
}

describe('nudge intercepts', () => {
  it('intercept sees kind=nudge and routing.streamId for a nudge frame', async () => {
    const connection = createConnection('conn_1');
    const activeStream = makeActiveStream(connection.id, 'nudge-event');
    const activeStreams = new Map([['stream_1', activeStream]]);

    const seenFrames: unknown[] = [];
    const { intercept } = await import('~/intercept/intercept.ts');
    const spy = intercept((_ctx, frame) => {
      seenFrames.push({ kind: frame.kind, streamId: frame.routing.streamId, event: frame.event });
    });

    const runtime = makeNudgeRuntime([spy], activeStreams);

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({
        event: 'nudge-event',
        payload: { value: 1 },
        __wskit: { streamId: 'stream_1', channelScope: null },
      }),
    );

    expect(seenFrames).toHaveLength(1);
    expect(seenFrames[0]).toEqual({ kind: 'nudge', streamId: 'stream_1', event: 'nudge-event' });
  });

  it('intercept can transform the nudge payload before it is buffered', async () => {
    const connection = createConnection('conn_1');
    const activeStream = makeActiveStream(connection.id, 'nudge-event');
    const activeStreams = new Map([['stream_1', activeStream]]);

    const { intercept } = await import('~/intercept/intercept.ts');
    const transformer = intercept(() => ({ transformed: true }));

    const runtime = makeNudgeRuntime([transformer], activeStreams);

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({
        event: 'nudge-event',
        payload: { original: true },
        __wskit: { streamId: 'stream_1', channelScope: null },
      }),
    );

    expect(activeStream.nudges).toHaveLength(1);
    expect(activeStream.nudges[0]!.payload).toEqual({ transformed: true });
  });

  it('Block thrown in a nudge intercept drops the nudge without buffering', async () => {
    const { Block } = await import('@wskit/core');
    const connection = createConnection('conn_1');
    const activeStream = makeActiveStream(connection.id, 'nudge-event');
    const activeStreams = new Map([['stream_1', activeStream]]);

    const { intercept } = await import('~/intercept/intercept.ts');
    const blocker = intercept(() => {
      throw Block;
    });

    const runtime = makeNudgeRuntime([blocker], activeStreams);

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({
        event: 'nudge-event',
        payload: { value: 1 },
        __wskit: { streamId: 'stream_1', channelScope: null },
      }),
    );

    expect(activeStream.nudges).toHaveLength(0);
  });

  it('no intercepts registered: nudge reaches buffer unchanged (zero-cost path)', async () => {
    const connection = createConnection('conn_1');
    const activeStream = makeActiveStream(connection.id, 'nudge-event');
    const activeStreams = new Map([['stream_1', activeStream]]);

    const runtime = makeNudgeRuntime([], activeStreams);

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({
        event: 'nudge-event',
        payload: { passthrough: true },
        __wskit: { streamId: 'stream_1', channelScope: null },
      }),
    );

    expect(activeStream.nudges).toHaveLength(1);
    expect(activeStream.nudges[0]!.payload).toEqual({ passthrough: true });
  });

  it('non-Block error in a nudge intercept rejects the nudge without terminating the stream', async () => {
    const connection = createConnection('conn_1');
    const activeStream = makeActiveStream(connection.id, 'nudge-event');
    const activeStreams = new Map([['stream_1', activeStream]]);
    const handleRuntimeError = vi.fn();

    const { intercept } = await import('~/intercept/intercept.ts');
    const thrower = intercept(() => {
      throw new Error('bad nudge');
    });

    const runtime = makeNudgeRuntime([thrower], activeStreams, { handleRuntimeError });

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({
        event: 'nudge-event',
        payload: {},
        __wskit: { streamId: 'stream_1', streamNudgeId: 'nudge_1', channelScope: null },
      }),
    );

    expect(activeStream.nudges).toHaveLength(0);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    const [, { routing }] = handleRuntimeError.mock.calls[0]!;
    // The error must carry the full non-terminal envelope: streamTerminated:false
    // keeps the stream live, streamNudgeId lets the client reject the right nudge().
    expect(routing).toEqual({
      streamId: 'stream_1',
      streamTerminated: false,
      streamNudgeId: 'nudge_1',
    });
  });

  it('Block in channel intercept drops a nudge sent with channel routing', async () => {
    const { Block } = await import('@wskit/core');
    const connection = createConnection('conn_1');
    const activeStream = makeActiveStream(connection.id, 'ch-nudge');
    const activeStreams = new Map([['stream_1', activeStream]]);

    const { intercept } = await import('~/intercept/intercept.ts');
    const chSpy = intercept(() => {
      throw Block;
    });
    const channels = new Map([['room', makeScopedNode([chSpy])]]);
    const runtime = makeNudgeRuntime([], activeStreams, { channels });

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({
        event: 'ch-nudge',
        payload: { value: 1 },
        __wskit: { streamId: 'stream_1', channel: 'room', channelScope: null },
      }),
    );

    expect(activeStream.nudges).toHaveLength(0);
  });
});

describe('Defer retry hook isolation', () => {
  it('incoming hooks run only once across original dispatch and Defer retry', async () => {
    vi.useFakeTimers();
    try {
      const connection = createConnection('conn_1');
      let hookCallCount = 0;
      let handlerAttempt = 0;

      const runtime = {
        compiled: {
          outgoing: new Map(),
          incoming: new Map([
            [
              'work',
              {
                event: 'work',
                handler: async () => {
                  handlerAttempt += 1;
                  if (handlerAttempt === 1) throw Defer(10);
                },
                validator: undefined,
              },
            ],
          ]),
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
        },
        connections: new Map([[connection.id, connection]]),
        toConnectionInfo() {
          return { id: connection.id };
        },
        activeStreams: new Map(),
        protocolHandlers: new Map(),
        incomingHooks: [
          (_msg: { event: string; payload: unknown }) => {
            hookCallCount += 1;
          },
        ],
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
        { event: 'work', payload: {}, wskit: undefined },
      );

      expect(handlerAttempt).toBe(1);

      await vi.advanceTimersByTimeAsync(10);

      expect(handlerAttempt).toBe(2);

      // Correct behavior: the incoming hook must have run only ONCE total.
      // Today the retry re-dispatches from the top of dispatchIncoming and
      // re-runs incomingHooks, so hookCallCount is 2 — this assertion fails.
      expect(hookCallCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a DeferExhausted onError hook receives the channel-scoped ctx when the handler defers inside a channel', async () => {
    vi.useFakeTimers();
    try {
      const channelMembers = new Map<string, Set<RuntimeConnection>>();
      const connection = createConnection('conn_1');
      addMembership(channelMembers, connection, { channelName: 'room' });

      const channel = {
        key: 'room',
        kind: 'channel' as const,
        pattern: 'room',
        outgoing: new Map(),
        incoming: new Map([
          [
            'work',
            {
              event: 'work',
              validator: undefined,
              handler: () => {
                throw Defer(10);
              },
            },
          ],
        ]),
        requests: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        intercepts: [],
      };

      let capturedCtx: { id?: string; channel?: string } | undefined;

      const runtime = {
        compiled: {
          outgoing: new Map(),
          incoming: new Map(),
          requests: new Map(),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          intercepts: [],
          channels: new Map([['room', channel]]),
          channelFamilies: new Map(),
          scheduled: new Map(),
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        connections: new Map([[connection.id, connection]]),
        channelMembers,
        toConnectionInfo() {
          return { id: connection.id };
        },
        activeStreams: new Map(),
        protocolHandlers: new Map(),
        incomingHooks: [],
        errorHooks: [
          (ctx: { id?: string; channel?: string }) => {
            capturedCtx = ctx;
          },
        ],
        requireTimers() {
          return { setTimeout: () => undefined, clearTimeout() {} };
        },
        buildConnectionContext(_connection: RuntimeConnection, scope?: { channelName?: string }) {
          return { id: connection.id, channel: scope?.channelName };
        },
        broadcastToConnections() {},
        sendProtocolMessage() {},
        sendReplay() {},
        persistAttachment() {},
        async handleRuntimeError() {},
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
        { event: 'work', payload: {}, wskit: { channel: 'room', channelScope: null } },
      );
      // Exhaust the defer retries (initial + 3 retries at 10ms each).
      await vi.advanceTimersByTimeAsync(100);

      expect(capturedCtx).toBeDefined();
      expect(capturedCtx?.channel).toBe('room');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('declined server→client request routing (Major 1)', () => {
  it('routes a correlated __error__ decline to the answer-frame hooks', async () => {
    const connection = createConnection('conn_1');
    const claimed: Array<{ id: string; event: string; code: unknown }> = [];
    const handleRuntimeError = vi.fn();
    const runtime = {
      ...makeNudgeRuntime([], new Map(), { handleRuntimeError }),
      answerFrameHooks: [
        (
          id: string,
          frame: { event: string; payload: unknown; wskit?: { correlationId?: string } },
        ) => {
          if (frame.wskit?.correlationId !== 'sreq_1') return false;
          claimed.push({
            id,
            event: frame.event,
            code: (frame.payload as { code?: unknown })?.code,
          });
          return true;
        },
      ],
    };

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({
        event: '__error__',
        payload: { code: 'request-no-response' },
        __wskit: { correlationId: 'sreq_1' },
      }),
    );

    // The decline reached settle (not dispatchProtocolFrame, which would have
    // raised a validation error).
    expect(claimed).toEqual([{ id: 'conn_1', event: '__error__', code: 'request-no-response' }]);
    expect(handleRuntimeError).not.toHaveBeenCalled();
  });

  it('drops a correlated __error__ no hook claims without a spurious protocol error', async () => {
    const connection = createConnection('conn_1');
    const handleRuntimeError = vi.fn();
    const runtime = {
      ...makeNudgeRuntime([], new Map(), { handleRuntimeError }),
      answerFrameHooks: [() => false],
    };

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({ event: '__error__', payload: {}, __wskit: { correlationId: 'gone' } }),
    );

    expect(handleRuntimeError).not.toHaveBeenCalled();
  });

  it('a bare __error__ with no correlationId still surfaces a protocol validation error', async () => {
    const connection = createConnection('conn_1');
    const handleRuntimeError = vi.fn();
    const runtime = {
      ...makeNudgeRuntime([], new Map(), { handleRuntimeError }),
      answerFrameHooks: [],
    };

    await processTextMessage(
      runtime as unknown as Parameters<typeof processTextMessage>[0],
      connection,
      JSON.stringify({ event: '__error__', payload: { code: 'x' } }),
    );

    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
  });
});
