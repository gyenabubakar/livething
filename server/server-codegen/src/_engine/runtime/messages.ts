/* oxlint-disable @typescript-eslint/no-explicit-any */
import { Block, Skip, WskitError } from '@wskit/core';
import {
  isIncomingProtocolEvent,
  isProtocolEvent,
  prefixedModuleEvent,
  validateValue,
} from '~/_engine/compile/utils.ts';
import { DeferExhausted } from '~/errors.ts';
import { bufferStreamNudge, cancelStream, runStream } from '~/stream/runtime.ts';
import type { CompiledChannel, CompiledServer } from '~/_engine/compile/types.ts';
import type { BroadcastOptions, ConnectionInfo, TimerProvider } from '~/index.ts';
import type {
  ActiveStream,
  ConnectionMembersRuntime,
  IncomingProtocolEvent,
  ModuleRuntime,
  ResolvedScope,
  RoutingTarget,
  RuntimeConnection,
  WireOutgoingMessage,
} from './types.ts';

/**
 * Minimal dependency bag for outgoing message helpers.
 */
interface OutgoingRuntime {
  compiled: CompiledServer;
  moduleRuntimes: readonly ModuleRuntime[];
  outgoingHooks: readonly ((message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void)[];
  beforeSendHooks: readonly ((message: WireOutgoingMessage) => void)[];
  afterSendHooks: readonly ((message: WireOutgoingMessage) => void | Promise<void>)[];
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
interface DispatchRuntime extends OutgoingRuntime, ConnectionMembersRuntime {
  activeStreams: Map<string, ActiveStream>;
  protocolHandlers: ReadonlyMap<
    IncomingProtocolEvent,
    readonly ((
      ctx: any,
      payload: Record<string, unknown> | undefined,
    ) => boolean | void | Promise<boolean | void>)[]
  >;
  incomingHooks: readonly ((message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void)[];
  errorHooks: readonly ((
    ctx: any,
    error: unknown,
    event?: string,
  ) => boolean | void | Promise<boolean | void>)[];
  requireTimers(): TimerProvider;
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void;
  sendReplay(
    connection: RuntimeConnection,
    channelName: string | undefined,
    channelScope: string | undefined,
    event: string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string },
  ): void;
  persistAttachment(connection: RuntimeConnection): void;
  setActiveConnectionId(id?: string): void;
  handleRuntimeError(
    connection: RuntimeConnection,
    error: unknown,
    event?: string,
    routing?: Record<string, unknown>,
  ): Promise<void>;
  handleValidationError(
    connection: RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: ResolvedScope,
  ): Promise<void>;
  handleSubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void>;
  handleUnsubscribe(
    connection: RuntimeConnection,
    payload: Record<string, unknown> | undefined,
  ): Promise<void>;
}

/**
 * Dependency bag for channel subscribe/unsubscribe helpers.
 */
interface ChannelRuntime extends ConnectionMembersRuntime {
  beforeSubscribeHooks: ReadonlyMap<
    string,
    readonly { handler: (ctx: any, data?: unknown) => void | Promise<void>; validator?: unknown }[]
  >;
  subscribeHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;
  unsubscribeHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  persistAttachment(connection: RuntimeConnection): void;
  sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void;
  handleValidationError(
    connection: RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: ResolvedScope,
  ): Promise<void>;
}

/**
 * Read routing markers from an incoming payload and resolve the active scope.
 */
export function resolveScope(compiled: CompiledServer, payload: unknown): ResolvedScope {
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

function isDeclaredModuleEvent(compiled: CompiledServer, event: string): boolean {
  for (const moduleInstance of compiled.modules) {
    for (const declaration of moduleInstance.outgoing) {
      if (prefixedModuleEvent(moduleInstance.id, declaration.event) === event) {
        return true;
      }
    }
  }

  return false;
}

function isDeclaredOutgoingEvent(
  compiled: CompiledServer,
  event: string,
  routing?: RoutingTarget,
): boolean {
  if (event.startsWith('__')) return isDeclaredModuleEvent(compiled, event);
  if (isProtocolEvent(event)) return true;

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

function assertPayloadRecord(payload: unknown): asserts payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[wskit] Outgoing payload must be a plain object.');
  }
}

/**
 * Push one outgoing event through module hooks, declaration checks, and wire
 * metadata injection before sending it to a connection.
 */
export function sendThroughPipeline(
  runtime: OutgoingRuntime,
  connection: RuntimeConnection,
  routing: RoutingTarget | undefined,
  event: string,
  payload: unknown,
): boolean {
  assertPayloadRecord(payload);

  for (const key of Object.keys(payload)) {
    if (key.startsWith('_')) {
      throw new Error(
        '[wskit] Outgoing payload fields starting with "_" are reserved for the engine.',
      );
    }
  }

  let message: { event: string; payload: unknown } = { event, payload };

  for (const hook of runtime.outgoingHooks) {
    const next = hook(message);
    if (next) message = next;
  }

  for (const moduleRuntime of runtime.moduleRuntimes) {
    if (!moduleRuntime.onOutgoing) continue;
    const next = moduleRuntime.onOutgoing(message);
    if (next) message = next;
  }

  assertPayloadRecord(message.payload);

  const finalPayload: Record<string, unknown> = {
    ...message.payload,
  };

  if (!isDeclaredOutgoingEvent(runtime.compiled, message.event, routing)) {
    throw new Error(
      `[wskit] Outgoing event "${message.event}" was not declared in the active scope.`,
    );
  }

  if (routing?.namespace) finalPayload._namespace = routing.namespace;
  if (routing?.channel) finalPayload._channel = routing.channel;
  if (routing?.channelScope) finalPayload._channelScope = routing.channelScope;
  if (routing?.correlationId) finalPayload._correlationId = routing.correlationId;
  if (routing?.streamId) finalPayload._streamId = routing.streamId;

  const wireMessage: WireOutgoingMessage = {
    connectionId: connection.id,
    event: message.event,
    payload: finalPayload,
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
  connections: readonly RuntimeConnection[],
  event: string,
  payload: unknown,
  options?: BroadcastOptions & { namespace?: string },
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
  const connections = [...runtime.connections.values()].filter((connection) =>
    connection.channels.has(channelName),
  );

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
  runtime: ConnectionMembersRuntime,
  channelName: string,
): ConnectionInfo<Record<string, unknown>>[] {
  return [...runtime.connections.values()]
    .filter((connection) => connection.channels.has(channelName))
    .map((connection) => runtime.toConnectionInfo(connection));
}

/**
 * Leave a channel, fire unsubscribe hooks, and notify remaining members.
 */
export async function leaveChannel(
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
  connection: RuntimeConnection,
  scope: { channel?: CompiledChannel; channelName: string; channelScope?: string },
  kickedReason?: string,
): Promise<void> {
  if (!connection.channels.has(scope.channelName)) return;

  const ctx = runtime.buildConnectionContext(connection, scope);

  for (const hook of runtime.unsubscribeHooks.get(scope.channel?.key ?? '') ?? []) {
    await hook(ctx);
  }

  connection.channels.delete(scope.channelName);
  connection.tags.delete(`channel:${scope.channelName}`);
  runtime.persistAttachment(connection);

  if (kickedReason) {
    runtime.sendProtocolMessage(connection, '_kicked', {
      _channel: scope.channelName,
      ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
      reason: kickedReason,
    });
  }

  broadcastToChannel(
    runtime,
    scope.channelName,
    '_memberLeave',
    { connectionId: connection.id },
    connection.id,
    scope.channelScope,
  );
}

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
        connection: RuntimeConnection,
        scope: { channel?: CompiledChannel; channelName: string; channelScope?: string },
        kickedReason?: string,
      ): Promise<void>;
    },
  channelName: string,
  tag: string,
  reason: string,
): void {
  for (const connection of runtime.connections.values()) {
    if (!connection.channels.has(channelName) || !connection.tags.has(tag)) continue;
    const resolved = runtime.compiled.channels.get(channelName);
    void runtime.leaveChannel(connection, { channel: resolved, channelName }, reason);
  }
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
  connection: RuntimeConnection,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  if (!payload || typeof payload._channel !== 'string') return;

  const resolved =
    typeof payload._channelScope === 'string'
      ? runtime.compiled.channelFamilies.get(payload._channelScope)
      : runtime.compiled.channels.get(payload._channel);
  if (!resolved) return;

  const existingMembers = getChannelMembers(runtime, payload._channel);
  const scope = {
    channel: resolved,
    channelName: payload._channel,
    channelScope: typeof payload._channelScope === 'string' ? payload._channelScope : undefined,
  };
  const ctx = runtime.buildConnectionContext(connection, scope);
  const data = { ...payload };
  delete data._channel;
  delete data._channelScope;

  for (const hook of runtime.beforeSubscribeHooks.get(resolved.key) ?? []) {
    let validatedData: unknown = data;
    if (hook.validator) {
      try {
        validatedData = validateValue(hook.validator, data, '_subscribe');
      } catch (error) {
        await runtime.handleValidationError(connection, '_subscribe', error, scope);
        throw error;
      }
    }

    await hook.handler(ctx, validatedData);
  }

  connection.channels.add(payload._channel);
  connection.tags.add(`channel:${payload._channel}`);
  runtime.persistAttachment(connection);

  for (const hook of runtime.subscribeHooks.get(resolved.key) ?? []) {
    await hook(ctx);
  }

  runtime.sendProtocolMessage(connection, '_subscribeOk', {
    _channel: payload._channel,
    ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
  });

  for (const member of existingMembers) {
    runtime.sendProtocolMessage(connection, '_memberJoin', {
      _channel: payload._channel,
      ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
      connectionId: member.id,
      meta: member.meta,
    });
  }

  broadcastToChannel(
    runtime,
    payload._channel,
    '_memberJoin',
    {
      connectionId: connection.id,
      meta: connection.meta,
    },
    connection.id,
    scope.channelScope,
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
        connection: RuntimeConnection,
        scope: { channel?: CompiledChannel; channelName: string; channelScope?: string },
      ): Promise<void>;
    },
  connection: RuntimeConnection,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  if (!payload || typeof payload._channel !== 'string') return;
  const resolved =
    typeof payload._channelScope === 'string'
      ? runtime.compiled.channelFamilies.get(payload._channelScope)
      : runtime.compiled.channels.get(payload._channel);
  if (!resolved) return;

  await runtime.leaveChannel(connection, {
    channel: resolved,
    channelName: payload._channel,
    channelScope: typeof payload._channelScope === 'string' ? payload._channelScope : undefined,
  });
}

/**
 * Send a normalized `_error` protocol message, optionally after the error hook
 * has decided whether it should be forwarded.
 */
export async function handleRuntimeError(
  runtime: Pick<DispatchRuntime, 'buildConnectionContext' | 'errorHooks' | 'sendProtocolMessage'>,
  connection: RuntimeConnection,
  error: unknown,
  event?: string,
  routing?: Record<string, unknown>,
): Promise<void> {
  for (const hook of runtime.errorHooks) {
    const ctx = runtime.buildConnectionContext(connection);
    const shouldSend = await hook(ctx, error, event);
    if (shouldSend === false) return;
  }

  const payload =
    error instanceof WskitError
      ? { code: error.code, detail: error.detail, ...routing }
      : { code: 'internal-error', ...routing };
  runtime.sendProtocolMessage(connection, '_error', payload);
}

/**
 * Main inbound event dispatcher.
 *
 * This runs module hooks, pre/post intercepts, validation, incoming handlers,
 * requests, and streams in the order described by the server spec.
 */
export async function dispatchIncoming(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  event: string,
  rawPayload: unknown,
  attempt = 0,
): Promise<void> {
  const scope = resolveScope(runtime.compiled, rawPayload);
  if (scope.channelName && !connection.channels.has(scope.channelName)) {
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

    for (const intercept of runtime.compiled.preIntercepts) {
      const ctx = runtime.buildConnectionContext(connection, scope);
      runtime.setActiveConnectionId(connection.id);
      const next = await intercept.handler(ctx, message);
      runtime.setActiveConnectionId(undefined);
      if (next) message = next;
    }

    if (scope.namespace) {
      for (const intercept of scope.namespace.preIntercepts) {
        const ctx = runtime.buildConnectionContext(connection, scope);
        runtime.setActiveConnectionId(connection.id);
        const next = await intercept.handler(ctx, message);
        runtime.setActiveConnectionId(undefined);
        if (next) message = next;
      }
    }

    if (scope.channel) {
      for (const intercept of scope.channel.preIntercepts) {
        const ctx = runtime.buildConnectionContext(connection, scope);
        runtime.setActiveConnectionId(connection.id);
        const next = await intercept.handler(ctx, message);
        runtime.setActiveConnectionId(undefined);
        if (next) message = next;
      }
    }

    const primitive = incoming ?? request ?? stream;
    if (!primitive) return;

    let payload: unknown;
    try {
      payload = validateValue(
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
    let postPayload = payload;

    for (const intercept of [...topPost, ...scopedPost]) {
      const ctx = runtime.buildConnectionContext(connection, scope);
      runtime.setActiveConnectionId(connection.id);
      const next = await intercept.handler(ctx, postPayload);
      runtime.setActiveConnectionId(undefined);
      if (next !== undefined) postPayload = next;
    }

    connection.activeAckId =
      message.payload &&
      typeof message.payload === 'object' &&
      '_ackId' in (message.payload as object)
        ? String((message.payload as Record<string, unknown>)._ackId)
        : undefined;

    if (incoming) {
      const ctx = runtime.buildConnectionContext(connection, scope);
      runtime.setActiveConnectionId(connection.id);
      await incoming.handler(ctx, postPayload);
      runtime.setActiveConnectionId(undefined);
      return;
    }

    if (request) {
      const correlationId =
        message.payload &&
        typeof message.payload === 'object' &&
        '_correlationId' in (message.payload as object)
          ? String((message.payload as Record<string, unknown>)._correlationId)
          : undefined;
      const ctx = runtime.buildConnectionContext(connection, scope);
      runtime.setActiveConnectionId(connection.id);
      const response = await request.handler(ctx, postPayload);
      runtime.setActiveConnectionId(undefined);
      sendThroughPipeline(
        runtime,
        connection,
        {
          namespace: scope.namespace?.name,
          channel: scope.channelName,
          channelScope: scope.channelScope,
          correlationId,
        },
        event,
        response,
      );
      return;
    }

    if (stream) {
      await runStream(runtime, connection, scope, event, stream, postPayload);
    }
  } catch (error) {
    if (error === Block) return;
    if (error === Skip) return;
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
    if (error && typeof error === 'object' && (error as { __wskit?: string }).__wskit === 'defer') {
      if (attempt >= 3) {
        await runtime.handleRuntimeError(
          connection,
          DeferExhausted({ event, payload: rawPayload, retries: attempt + 1 }),
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

  let parsed: { event: string; payload?: unknown };

  try {
    parsed = JSON.parse(data) as { event: string; payload?: unknown };
  } catch {
    runtime.logger.warn('Invalid JSON message dropped');
    return;
  }

  if (parsed.event === 'ping') {
    connection.descriptor.send(JSON.stringify({ event: 'pong' }));
    return;
  }

  if (parsed.event === '_subscribe') {
    await runtime.handleSubscribe(
      connection,
      parsed.payload as Record<string, unknown> | undefined,
    );
    return;
  }
  if (parsed.event === '_unsubscribe') {
    await runtime.handleUnsubscribe(
      connection,
      parsed.payload as Record<string, unknown> | undefined,
    );
    return;
  }
  if (parsed.event === '_streamCancel') {
    await cancelStream(runtime, connection, parsed.payload as Record<string, unknown> | undefined);
    return;
  }
  if (
    await bufferStreamNudge(
      runtime,
      connection,
      parsed.event,
      parsed.payload as Record<string, unknown> | undefined,
    )
  ) {
    return;
  }

  if (isIncomingProtocolEvent(parsed.event)) {
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
