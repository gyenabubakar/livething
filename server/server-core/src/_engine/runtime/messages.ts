/* oxlint-disable @typescript-eslint/no-explicit-any */
import { Block, Skip } from '@wskit/core';
import * as EngineCompileUtils from '~/_engine/compile/utils.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as ErrorsPrimitive from '~/errors/errors.ts';
import * as HeartbeatPrimitive from '~/heartbeat/runtime.ts';
import * as InterceptPrimitive from '~/intercept/runtime.ts';
import * as RequestPrimitive from '~/request/runtime.ts';
import * as StreamPrimitive from '~/stream/runtime.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as EngineRuntimeTypes from './types.ts';

type CompiledServer = EngineCompileTypes.CompiledServer;
type ConnectionMembersRuntime = EngineRuntimeTypes.ConnectionMembersRuntime;
type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/**
 * Minimal dependency bag for outgoing message helpers.
 */
interface OutgoingRuntime {
  compiled: EngineCompileTypes.CompiledServer;
  moduleRuntimes: readonly EngineRuntimeTypes.ModuleRuntime[];
  outgoingHooks: readonly ((message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void)[];
  beforeSendHooks: readonly ((message: EngineRuntimeTypes.WireOutgoingMessage) => void)[];
  afterSendHooks: readonly ((
    message: EngineRuntimeTypes.WireOutgoingMessage,
  ) => void | Promise<void>)[];
  waitUntil(promise: Promise<unknown>): void;
  logger: {
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
  };
  generateId(prefix?: string): string;
}

/**
 * Larger dependency bag for inbound message dispatch.
 */
interface DispatchRuntime extends OutgoingRuntime, EngineRuntimeTypes.ConnectionMembersRuntime {
  activeStreams: Map<string, EngineRuntimeTypes.ActiveStream>;
  protocolHandlers: ReadonlyMap<
    EngineRuntimeTypes.IncomingProtocolEvent,
    readonly ((
      ctx: any,
      payload: Record<string, unknown> | undefined,
    ) => boolean | void | Promise<boolean | void>)[]
  >;
  incomingHooks: readonly ((message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void)[];
  errorHooks: readonly ((ctx: any, error: unknown, event?: string) => void | Promise<void>)[];
  requireTimers(): PublicApi.TimerProvider;
  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Record<PropertyKey, unknown>;
  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void;
  sendReplay(
    connection: EngineRuntimeTypes.RuntimeConnection,
    channelName: string | undefined,
    channelScope: string | undefined,
    event: string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string },
  ): void;
  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;
  setActiveConnectionId(id?: string): void;
  handleRuntimeError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    error: unknown,
    event?: string,
    routing?: Record<string, unknown>,
  ): Promise<void>;
  handleValidationError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Promise<void>;
  broadcastToConnections(
    connections: readonly EngineRuntimeTypes.RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: PublicApi.BroadcastOptions & { namespace?: string },
    excludeConnectionId?: string,
  ): void;
  handleSubscribe(
    connection: EngineRuntimeTypes.RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void>;
  handleUnsubscribe(
    connection: EngineRuntimeTypes.RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void>;
}

/**
 * Dependency bag for channel subscribe/unsubscribe helpers.
 */
interface ChannelRuntime extends EngineRuntimeTypes.ConnectionMembersRuntime {
  beforeSubscribeHooks: ReadonlyMap<
    string,
    readonly { handler: (ctx: any, data?: unknown) => void | Promise<void>; validator?: unknown }[]
  >;
  subscribeHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;
  unsubscribeHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;
  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Record<PropertyKey, unknown>;
  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;
  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void;
  broadcastToChannel(
    channelName: string,
    event: string,
    payload: unknown,
    excludeConnectionId?: string,
    channelScope?: string,
  ): void;
  handleValidationError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Promise<void>;
}

/**
 * Read routing markers from an incoming payload and resolve the active scope.
 */
export function resolveScope(
  compiled: EngineCompileTypes.CompiledServer,
  payload: unknown,
): EngineRuntimeTypes.ResolvedScope {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;

  if (typeof record._namespace === 'string') {
    return {
      namespace: compiled.namespaces.get(record._namespace),
    };
  }

  if (typeof record._channel === 'string') {
    if (typeof record._channelScope === 'string') {
      return {
        channel: compiled.channelFamilies.get(record._channelScope),
        channelName: record._channel,
        channelScope: record._channelScope,
      };
    }

    return {
      channel: compiled.channels.get(record._channel),
      channelName: record._channel,
    };
  }

  return {};
}

/** Check whether an event name belongs to any installed module's outgoing declarations. */
function isDeclaredModuleEvent(compiled: CompiledServer, event: string): boolean {
  for (const moduleInstance of compiled.modules) {
    for (const eventName of Object.keys(moduleInstance.outgoing)) {
      if (EngineCompileUtils.prefixedModuleEvent(moduleInstance.id, eventName) === event) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check whether an outgoing event was declared in the correct scope.
 *
 * Module events (`__`-prefixed) are checked against module declarations.
 * Protocol events (`_`-prefixed, single underscore) are always allowed.
 * Everything else must appear in the scope's outgoing or stream maps.
 */
function isDeclaredOutgoingEvent(
  compiled: EngineCompileTypes.CompiledServer,
  event: string,
  routing?: EngineRuntimeTypes.RoutingTarget,
): boolean {
  if (event.startsWith('__')) return isDeclaredModuleEvent(compiled, event);
  if (EngineCompileUtils.isProtocolEvent(event)) return true;

  if (routing?.namespace) {
    const namespace = compiled.namespaces.get(routing.namespace);
    return (namespace?.outgoing.has(event) ?? false) || (namespace?.streams.has(event) ?? false);
  }

  if (routing?.channel) {
    const channel = routing.channelScope
      ? compiled.channelFamilies.get(routing.channelScope)
      : compiled.channels.get(routing.channel);
    return (channel?.outgoing.has(event) ?? false) || (channel?.streams.has(event) ?? false);
  }

  return compiled.outgoing.has(event) || compiled.streams.has(event);
}

/** Throw if the payload is not a plain object — arrays and primitives are rejected. */
function assertPayloadRecord(payload: unknown): asserts payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[wskit] Outgoing payload must be a plain object.');
  }
}

/** Throw if any payload key starts with `_` — those are reserved for the engine. */
function assertNoReservedPayloadFields(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (key.startsWith('_')) {
      throw new Error(
        '[wskit] Outgoing payload fields starting with "_" are reserved for the engine.',
      );
    }
  }
}

/**
 * Throw if the payload has new `_`-prefixed keys that were not present before
 * hooks ran. Hooks are allowed to add `_`-prefixed fields (e.g. `_seq`), but
 * user code and modules must not introduce new ones.
 */
function assertNoNewReservedPayloadFields(
  payload: Record<string, unknown>,
  allowedReservedFields: ReadonlySet<string>,
): void {
  for (const key of Object.keys(payload)) {
    if (key.startsWith('_') && !allowedReservedFields.has(key)) {
      throw new Error(
        '[wskit] Outgoing payload fields starting with "_" are reserved for the engine.',
      );
    }
  }
}

/**
 * Push one outgoing event through module hooks, declaration checks, and wire
 * metadata injection before sending it to a connection.
 */
export function sendThroughPipeline(
  runtime: OutgoingRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  routing: EngineRuntimeTypes.RoutingTarget | undefined,
  event: string,
  payload: unknown,
): boolean {
  assertPayloadRecord(payload);
  assertNoReservedPayloadFields(payload);

  let message: { event: string; payload: unknown } = { event, payload };

  for (const hook of runtime.outgoingHooks) {
    const next = hook(message);
    if (next) message = next;
  }

  assertPayloadRecord(message.payload);
  const allowedReservedFields = new Set(
    Object.keys(message.payload).filter((key) => key.startsWith('_')),
  );

  for (const moduleRuntime of runtime.moduleRuntimes) {
    if (!moduleRuntime.onOutgoing) continue;
    const next = moduleRuntime.onOutgoing(message);
    if (next) message = next;
  }

  assertPayloadRecord(message.payload);
  assertNoNewReservedPayloadFields(message.payload, allowedReservedFields);

  const finalPayload: Record<string, unknown> = {
    ...message.payload,
  };

  const isRequestResponse = !!routing?.correlationId;
  if (!isRequestResponse && !isDeclaredOutgoingEvent(runtime.compiled, message.event, routing)) {
    throw new Error(
      `[wskit] Outgoing event "${message.event}" was not declared in the active scope.`,
    );
  }

  if (routing?.namespace) finalPayload._namespace = routing.namespace;
  if (routing?.channel) finalPayload._channel = routing.channel;
  if (routing?.channelScope) finalPayload._channelScope = routing.channelScope;
  if (routing?.correlationId) finalPayload._correlationId = routing.correlationId;
  if (routing?.streamId) finalPayload._streamId = routing.streamId;

  const wireMessage: EngineRuntimeTypes.WireOutgoingMessage = {
    connectionId: connection.id,
    event: message.event,
    payload: finalPayload,
    meta: connection.meta,
  };

  for (const hook of runtime.beforeSendHooks) {
    hook(wireMessage);
  }

  connection.descriptor.send(JSON.stringify({ event: message.event, payload: finalPayload }));

  for (const hook of runtime.afterSendHooks) {
    try {
      const result = hook(wireMessage);

      if (result && typeof (result as Promise<unknown>).then === 'function') {
        runtime.waitUntil(
          Promise.resolve(result).catch((error) => {
            runtime.logger.error('[wskit] after-send hook failed', { error });
          }),
        );
      }
    } catch (error) {
      runtime.logger.error('[wskit] after-send hook failed', { error });
    }
  }

  return true;
}

/**
 * Broadcast one event to a set of already-selected connections.
 */
export function broadcastToConnections(
  runtime: Pick<
    OutgoingRuntime,
    | 'afterSendHooks'
    | 'beforeSendHooks'
    | 'compiled'
    | 'generateId'
    | 'logger'
    | 'moduleRuntimes'
    | 'outgoingHooks'
    | 'waitUntil'
  >,
  connections: readonly EngineRuntimeTypes.RuntimeConnection[],
  event: string,
  payload: unknown,
  options?: PublicApi.BroadcastOptions & { namespace?: string },
  excludeConnectionId?: string,
): void {
  for (const connection of connections) {
    if (options?.excludeSelf && connection.id === excludeConnectionId) continue;
    sendThroughPipeline(
      runtime,
      connection,
      {
        namespace: options?.namespace,
        channel: options?.channel,
      },
      event,
      payload,
    );
  }
}

/**
 * Broadcast one event to every member currently in a channel.
 */
export function broadcastToChannel(
  runtime: ConnectionMembersRuntime &
    Pick<
      OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'moduleRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
    >,
  channelName: string,
  event: string,
  payload: unknown,
  excludeConnectionId?: string,
  channelScope?: string,
): void {
  const connections = [...runtime.connections.values()].filter((connection) => {
    return ChannelPrimitive.hasChannelMembership(connection, channelName, channelScope);
  });

  for (const connection of connections) {
    if (excludeConnectionId && connection.id === excludeConnectionId) continue;
    sendThroughPipeline(
      runtime,
      connection,
      { channel: channelName, channelScope },
      event,
      payload,
    );
  }
}

/**
 * Return the current public member snapshot for a channel.
 */
export function getChannelMembers(
  runtime: EngineRuntimeTypes.ConnectionMembersRuntime,
  channelName: string,
): PublicApi.ConnectionInfo<Record<string, unknown>>[] {
  return [...runtime.connections.values()]
    .filter((connection) => connection.channels.has(channelName))
    .map((connection) => runtime.toConnectionInfo(connection));
}

export const leaveChannel = ChannelPrimitive.leaveChannel;

/**
 * Remove tagged members from a channel, typically for moderation or access
 * control.
 */
export function kickChannelMembers(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'moduleRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
    > & {
      leaveChannel(
        connection: EngineRuntimeTypes.RuntimeConnection,
        scope: {
          channel?: EngineCompileTypes.CompiledChannel;
          channelName: string;
          channelScope?: string;
        },
        kickedReason?: string,
      ): Promise<void>;
    },
  channelName: string,
  tag: string,
  reason: string,
): void {
  ChannelPrimitive.kickChannelMembers(runtime, channelName, tag, reason);
}

/**
 * Handle the `_subscribe` protocol message for a channel.
 */
export async function handleSubscribe(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'moduleRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
    >,
  connection: EngineRuntimeTypes.RuntimeConnection,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  await ChannelPrimitive.subscribeConnection(
    {
      ...runtime,
      broadcastToChannel: (channelName, event, nextPayload, excludeConnectionId, channelScope) => {
        broadcastToChannel(
          runtime,
          channelName,
          event,
          nextPayload,
          excludeConnectionId,
          channelScope,
        );
      },
      toConnectionInfo: (nextConnection) => runtime.toConnectionInfo(nextConnection),
    },
    connection,
    payload,
  );
}

/**
 * Handle the `_unsubscribe` protocol message for a channel.
 */
export async function handleUnsubscribe(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime,
      | 'afterSendHooks'
      | 'beforeSendHooks'
      | 'compiled'
      | 'generateId'
      | 'logger'
      | 'moduleRuntimes'
      | 'outgoingHooks'
      | 'waitUntil'
    > & {
      leaveChannel(
        connection: EngineRuntimeTypes.RuntimeConnection,
        scope: {
          channel?: EngineCompileTypes.CompiledChannel;
          channelName: string;
          channelScope?: string;
        },
      ): Promise<void>;
    },
  connection: EngineRuntimeTypes.RuntimeConnection,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  await ChannelPrimitive.unsubscribeConnection(runtime, connection, payload);
}

/**
 * Main inbound event dispatcher.
 *
 * This runs module hooks, pre/post intercepts, validation, incoming handlers,
 * requests, and streams in the order described by the server spec.
 */
export async function dispatchIncoming(
  runtime: DispatchRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  event: string,
  rawPayload: unknown,
  attempt = 0,
): Promise<void> {
  const scope = resolveScope(runtime.compiled, rawPayload);
  if (
    scope.channelName &&
    !ChannelPrimitive.hasChannelMembership(connection, scope.channelName, scope.channelScope)
  ) {
    return;
  }

  const scopedIncoming = scope.channel?.incoming.get(event) ?? scope.namespace?.incoming.get(event);
  const scopedRequest = scope.channel?.requests.get(event) ?? scope.namespace?.requests.get(event);
  const scopedStream = scope.channel?.streams.get(event) ?? scope.namespace?.streams.get(event);
  const incoming = scopedIncoming ?? runtime.compiled.incoming.get(event);
  const request = scopedRequest ?? runtime.compiled.requests.get(event);
  const stream = scopedStream ?? runtime.compiled.streams.get(event);

  let message = { event, payload: rawPayload };

  try {
    for (const hook of runtime.incomingHooks) {
      const next = hook(message);
      if (next) message = next;
    }

    for (const moduleRuntime of runtime.moduleRuntimes) {
      if (!moduleRuntime.onIncoming) continue;
      const next = moduleRuntime.onIncoming(message);
      if (next) message = next;
    }

    message = await InterceptPrimitive.runPreIntercepts(
      runtime,
      connection,
      scope,
      runtime.compiled.preIntercepts,
      message,
    );

    if (scope.namespace) {
      message = await InterceptPrimitive.runPreIntercepts(
        runtime,
        connection,
        scope,
        scope.namespace.preIntercepts,
        message,
      );
    }

    if (scope.channel) {
      message = await InterceptPrimitive.runPreIntercepts(
        runtime,
        connection,
        scope,
        scope.channel.preIntercepts,
        message,
      );
    }

    const primitive = incoming ?? request ?? stream;
    if (!primitive) return;

    let payload: unknown;
    try {
      payload = EngineCompileUtils.validateValue(
        'stream' in primitive ? primitive.stream.validator : primitive.validator,
        message.payload,
        event,
      );
    } catch (error) {
      await runtime.handleValidationError(connection, event, error, scope);
      throw error;
    }

    const topPost = runtime.compiled.postIntercepts.get(event) ?? [];
    const scopedPost =
      scope.channel?.postIntercepts.get(event) ?? scope.namespace?.postIntercepts.get(event) ?? [];
    const postPayload = await InterceptPrimitive.runPostIntercepts(
      runtime,
      connection,
      scope,
      [...topPost, ...scopedPost],
      payload,
    );

    // Stash the ack correlation ID (if any) so `ctx.ack()` inside the
    // handler knows which client-side Promise to resolve.
    connection.activeAckId =
      message.payload &&
      typeof message.payload === 'object' &&
      '_ackId' in (message.payload as object)
        ? String((message.payload as Record<string, unknown>)._ackId)
        : undefined;

    if (incoming) {
      await InterceptPrimitive.runWithScopedContext(runtime, connection, scope, (ctx) => {
        return incoming.handler(ctx, postPayload);
      });
      return;
    }

    if (request) {
      await RequestPrimitive.handleRequest(
        {
          buildConnectionContext: runtime.buildConnectionContext,
          setActiveConnectionId: runtime.setActiveConnectionId,
          sendThroughPipeline: (nextConnection, routing, nextEvent, nextPayload) => {
            return sendThroughPipeline(runtime, nextConnection, routing, nextEvent, nextPayload);
          },
        },
        connection,
        scope,
        event,
        request,
        postPayload,
        message.payload,
      );
      return;
    }

    if (stream) {
      await StreamPrimitive.runStream(runtime, connection, scope, event, stream, postPayload);
    }
  } catch (error) {
    await handleDispatchError(runtime, connection, event, rawPayload, error, attempt);
  }
}

async function handleDispatchError(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  event: string,
  rawPayload: unknown,
  error: unknown,
  attempt: number,
): Promise<void> {
  if (error === Block) return;
  if (error === Skip) return;

  if (error && (error as { code?: string }).code === 'validation-failed') {
    await runtime.handleValidationError(connection, event, error);
    await runtime.handleRuntimeError(connection, error, event);
    return;
  }

  if (
    error &&
    typeof error === 'object' &&
    (error as { __wskit?: string }).__wskit === 'disconnect'
  ) {
    connection.descriptor.close(
      (error as { code: number }).code,
      (error as { reason: string }).reason,
    );
    return;
  }

  // Defer — re-enqueue the message after a delay. After 3 failed attempts
  // the engine gives up and fires a DeferExhausted error instead.
  if (error && typeof error === 'object' && (error as { __wskit?: string }).__wskit === 'defer') {
    if (attempt >= 3) {
      await runtime.handleRuntimeError(
        connection,
        ErrorsPrimitive.DeferExhausted({
          event,
          payload: rawPayload,
          retries: attempt + 1,
        }),
        event,
      );
      return;
    }

    const delay = Number((error as { delay: number }).delay);
    runtime.requireTimers().setTimeout(() => {
      void dispatchIncoming(runtime, connection, event, rawPayload, attempt + 1);
    }, delay);
    return;
  }

  await runtime.handleRuntimeError(connection, error, event);
}

/**
 * Parse one websocket text frame and route protocol messages or app events.
 */
export async function processTextMessage(
  runtime: DispatchRuntime & {
    activityHooks: readonly ((connectionId: string) => void | Promise<void>)[];
  },
  connection: RuntimeConnection,
  data: string,
): Promise<void> {
  for (const hook of runtime.activityHooks) {
    await hook(connection.id);
  }

  if (data === 'ping') {
    connection.descriptor.send('pong');
    return;
  }

  if (data === 'pong') {
    HeartbeatPrimitive.recordConnectionLatency(connection);
    return;
  }

  let parsed: { event: string; payload?: unknown };

  try {
    parsed = JSON.parse(data) as { event: string; payload?: unknown };
  } catch {
    runtime.logger.warn('Invalid JSON message dropped');
    return;
  }

  switch (parsed.event) {
    case 'ping':
      connection.descriptor.send(JSON.stringify({ event: 'pong' }));
      return;
    case '_subscribe':
      try {
        await runtime.handleSubscribe(
          connection,
          parsed.payload as Record<string, unknown> | undefined,
        );
      } catch (error) {
        const channel = (parsed.payload as Record<string, unknown> | undefined)?._channel;
        await runtime.handleRuntimeError(
          connection,
          error,
          '_subscribe',
          channel ? { _channel: channel } : undefined,
        );
      }
      return;
    case '_unsubscribe':
      await runtime.handleUnsubscribe(
        connection,
        parsed.payload as Record<string, unknown> | undefined,
      );
      return;
    case '_streamCancel':
      await StreamPrimitive.cancelStream(
        runtime,
        connection,
        parsed.payload as Record<string, unknown> | undefined,
      );
      return;
  }

  if (
    await StreamPrimitive.bufferStreamNudge(
      runtime,
      connection,
      parsed.event,
      parsed.payload as Record<string, unknown> | undefined,
    )
  ) {
    return;
  }

  if (EngineCompileUtils.isIncomingProtocolEvent(parsed.event)) {
    const handlers = runtime.protocolHandlers.get(parsed.event) ?? [];
    const scope = resolveScope(runtime.compiled, parsed.payload);
    const ctx = runtime.buildConnectionContext(connection, scope);

    for (const handler of handlers) {
      const handled = await handler(ctx, parsed.payload as Record<string, unknown> | undefined);

      if (handled) return;
    }

    return;
  }

  await dispatchIncoming(runtime, connection, parsed.event, parsed.payload);
}
