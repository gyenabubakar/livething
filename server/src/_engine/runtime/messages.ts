/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  Block,
  ChannelNotFound,
  ChannelNotSubscribed,
  NamespaceNotFound,
  rethrowIfConfigError,
  WskitError,
} from '@wskit/core';
import * as EngineCompileUtils from '~/_engine/compile/utils.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as ErrorsPrimitive from '~/errors/errors.ts';
import * as HeartbeatPrimitive from '~/heartbeat/runtime.ts';
import * as InterceptPrimitive from '~/intercept/runtime.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import * as RequestPrimitive from '~/request/runtime.ts';
import * as StreamPrimitive from '~/stream/runtime.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as EngineRuntimeTypes from './types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

// ───── Section: re-exports of outgoing helpers ─────

/**
 * Re-exports of the outgoing pipeline helpers so runtime callers can continue
 * to import from a single module. The implementations live in
 * `outgoing/runtime.ts`.
 */
export const sendThroughPipeline = OutgoingRuntime.sendThroughPipeline;
export const broadcastToConnections = OutgoingRuntime.broadcastToConnections;
export const broadcastToChannel = OutgoingRuntime.broadcastToChannel;

// ───── Section: dispatch runtime types ─────

/**
 * Larger dependency bag for inbound message dispatch.
 */
interface DispatchRuntime
  extends OutgoingRuntime.OutgoingRuntime, EngineRuntimeTypes.ConnectionMembersRuntime {
  activeStreams: Map<string, EngineRuntimeTypes.ActiveStream>;
  protocolHandlers: ReadonlyMap<
    EngineRuntimeTypes.IncomingProtocolEvent,
    readonly ((
      ctx: any,
      payload: Record<string, unknown> | undefined,
    ) => boolean | void | Promise<boolean | void>)[]
  >;
  incomingHooks: readonly ((message: { event: string; payload: unknown }) => unknown | void)[];
  /**
   * Size of the per-connection seen-id ring used by incoming dedup. Zero means
   * incoming dedup is disabled (no `dedup()` primitive registered).
   */
  incomingDedupCap: number;
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
    options?: PublicApi.BroadcastOptions & { namespace?: string; channelScope?: string },
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
    excludeSelf?: boolean,
  ): void;
  handleValidationError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Promise<void>;
}

// ───── Section: incoming dedup ─────

/**
 * Check whether an incoming payload's `_messageId` has already been seen on
 * this connection. If not, record it in the bounded ring.
 *
 * Returns `true` when the frame is a duplicate and should be dropped. Payloads
 * without a string `_messageId` are never considered duplicates — the client
 * opted out of receiver-side dedup for that frame.
 */
function isDuplicateIncoming(
  connection: EngineRuntimeTypes.RuntimeConnection,
  rawPayload: unknown,
  cap: number,
): boolean {
  if (!rawPayload || typeof rawPayload !== 'object') return false;
  const messageId = (rawPayload as { _messageId?: unknown })._messageId;
  if (typeof messageId !== 'string' || messageId.length === 0) return false;

  let ring = connection.seenIncomingIds;
  if (!ring || ring.cap !== cap) {
    ring = { buf: new Array<string>(cap), writePtr: 0, set: new Set<string>(), cap };
    connection.seenIncomingIds = ring;
  }

  if (ring.set.has(messageId)) return true;

  const evicted = ring.buf[ring.writePtr];
  if (evicted !== undefined) ring.set.delete(evicted);
  ring.buf[ring.writePtr] = messageId;
  ring.set.add(messageId);
  ring.writePtr = (ring.writePtr + 1) % ring.cap;
  return false;
}

// ───── Section: scope resolution ─────

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
    const namespace = compiled.namespaces.get(record._namespace);
    if (!namespace) throw NamespaceNotFound();
    return { namespace };
  }

  if (typeof record._channel === 'string') {
    if (typeof record._channelScope === 'string') {
      const family = compiled.channelFamilies.get(record._channelScope);
      if (!family) throw ChannelNotFound();
      if (!ChannelPrimitive.matchesScopePattern(family.pattern, record._channel)) {
        throw ChannelNotFound();
      }
      return {
        channel: family,
        channelName: record._channel,
        channelScope: record._channelScope,
      };
    }

    const channel = compiled.channels.get(record._channel);
    if (!channel) throw ChannelNotFound();
    return {
      channel,
      channelName: record._channel,
    };
  }

  return {};
}

// ───── Section: channel membership helpers ─────

/**
 * Return the current public member snapshot for a channel.
 *
 * When `channelScope` is supplied (e.g. a dynamic channel family key) the
 * lookup uses the exact membership key so two scopes that happen to share a
 * concrete channel name stay isolated. Without a scope, returns every
 * connection that has any membership matching the name — same fallback used
 * by `ctx.channels.members(name)` when the caller doesn't know the scope.
 */
export function getChannelMembers(
  runtime: EngineRuntimeTypes.ConnectionMembersRuntime,
  channelName: string,
  channelScope?: string,
): PublicApi.ConnectionInfo<Record<string, unknown>>[] {
  const membershipKey = channelScope ? `${channelScope}::${channelName}` : null;

  return [...runtime.connections.values()]
    .filter((connection) => {
      if (membershipKey) return connection.channelMemberships.has(membershipKey);
      for (const membership of connection.channelMemberships.values()) {
        if (membership.channelName === channelName) return true;
      }
      return false;
    })
    .map((connection) => runtime.toConnectionInfo(connection));
}

/** Re-export of the shared channel-leave helper so runtime callers can import from one module. */
export const leaveChannel = ChannelPrimitive.leaveChannel;

/**
 * Remove tagged members from a channel, typically for moderation or access
 * control.
 */
export function kickChannelMembers(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime.OutgoingRuntime,
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
  channelScope?: string,
): Promise<void> {
  return ChannelPrimitive.kickChannelMembers(runtime, channelName, tag, reason, channelScope);
}

/**
 * Handle the `_subscribe` protocol message for a channel.
 */
export async function handleSubscribe(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime.OutgoingRuntime,
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
      broadcastToChannel: (
        channelName,
        event,
        nextPayload,
        excludeConnectionId,
        channelScope,
        excludeSelf,
      ) => {
        OutgoingRuntime.broadcastToChannel(
          runtime,
          channelName,
          event,
          nextPayload,
          excludeConnectionId,
          channelScope,
          excludeSelf,
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
      OutgoingRuntime.OutgoingRuntime,
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

// ───── Section: inbound dispatch ─────

/**
 * Main inbound event dispatcher.
 *
 * This runs module hooks, pre-intercepts, post-intercepts, validation, incoming handlers,
 * requests, and streams in the order described by the server spec.
 */
export async function dispatchIncoming(
  runtime: DispatchRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  event: string,
  rawPayload: unknown,
  attempt = 0,
): Promise<void> {
  if (attempt === 0 && runtime.incomingDedupCap > 0) {
    if (isDuplicateIncoming(connection, rawPayload, runtime.incomingDedupCap)) {
      return;
    }
  }

  const scope = resolveScope(runtime.compiled, rawPayload);
  if (
    scope.channelName &&
    !ChannelPrimitive.hasChannelMembership(connection, scope.channelName, scope.channelScope)
  ) {
    await runtime.handleRuntimeError(connection, ChannelNotSubscribed(), event, {
      _channel: scope.channelName,
      ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
    });
    return;
  }

  // Scope isolation: when the wire payload claims a channel or namespace
  // scope, only handlers declared inside that scope are reachable. Falling
  // back to top-level handlers from inside a scope would let a channel
  // member fire any top-level event by tagging it with `_channel: '...'`,
  // breaking scope contracts (and potentially leaking admin-only top-level
  // events to channel-subscribed clients).
  const scoped = scope.channel ?? scope.namespace;
  const incoming = scoped ? scoped.incoming.get(event) : runtime.compiled.incoming.get(event);
  const request = scoped ? scoped.requests.get(event) : runtime.compiled.requests.get(event);
  const stream = scoped ? scoped.streams.get(event) : runtime.compiled.streams.get(event);

  let message = { event, payload: rawPayload };

  try {
    // Hook return value is treated as the new payload only — routing was
    // resolved above (incoming/request/stream lookup). Whatever a hook
    // returns becomes message.payload verbatim, even if the returned object
    // happens to have its own event/payload fields. The event name is
    // locked from the moment the message hit the dispatcher.
    for (const hook of runtime.incomingHooks) {
      const next = hook(message);
      if (next !== undefined) message = { event: message.event, payload: next };
    }

    for (const moduleRuntime of runtime.moduleRuntimes) {
      if (!moduleRuntime.onIncoming) continue;
      const next = moduleRuntime.onIncoming(message);
      if (next !== undefined) message = { event: message.event, payload: next };
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

    const appPayload = EngineCompileUtils.stripProtocolFields(message.payload);

    let payload: unknown;
    try {
      payload = EngineCompileUtils.validateValue(
        'stream' in primitive ? primitive.stream.validator : primitive.validator,
        appPayload,
        event,
      );
    } catch (error) {
      rethrowIfConfigError(error);
      // validateValue is the only producer of validation errors in this path.
      // Route them fully here (validation hook + error hook) and stop dispatch.
      // Don't rethrow — the outer catch's WskitError 'validation-failed' branch
      // would call handleValidationError again and double-fire user hooks.
      // Manual `throw ValidationFailed(...)` from a handler still routes through
      // the outer catch since it escapes after this try/catch returns.
      await runtime.handleValidationError(connection, event, error, scope);
      // Preserve protocol routing markers (especially `_correlationId`) so a
      // request whose payload fails the schema settles via the client
      // request-response plugin instead of hanging until timeout.
      await runtime.handleRuntimeError(connection, error, event, routingFromPayload(rawPayload));
      return;
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
            return OutgoingRuntime.sendThroughPipeline(
              runtime,
              nextConnection,
              routing,
              nextEvent,
              nextPayload,
            );
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
    await handleDispatchError(runtime, connection, event, rawPayload, scope, error, attempt);
  }
}

async function handleDispatchError(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  event: string,
  rawPayload: unknown,
  scope: EngineRuntimeTypes.ResolvedScope,
  error: unknown,
  attempt: number,
): Promise<void> {
  rethrowIfConfigError(error);
  if (error === Block) return;

  if (error instanceof WskitError && error.code === 'validation-failed') {
    // Pass `scope` so onValidationError hooks see the same channel/namespace
    // ctx for manually-thrown ValidationFailed as they do for schema
    // failures (which already pass scope at the inner catch).
    await runtime.handleValidationError(connection, event, error, scope);
    await runtime.handleRuntimeError(connection, error, event, routingFromPayload(rawPayload));
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

  // Defer — re-enqueue the message after a delay. After 3 retries the engine
  // gives up and fires a DeferExhausted error instead.
  if (error && typeof error === 'object' && (error as { __wskit?: string }).__wskit === 'defer') {
    if (attempt >= 3) {
      const exhausted = ErrorsPrimitive.DeferExhausted({
        event,
        payload: rawPayload,
        retries: attempt,
      });
      // Fire onError hooks only — DeferExhausted is a server-side signal and must not reach the client.
      for (const hook of runtime.errorHooks) {
        await hook(runtime.buildConnectionContext(connection), exhausted, event);
      }
      return;
    }

    const delay = Number((error as { delay: number }).delay);
    runtime.requireTimers().setTimeout(() => {
      void dispatchIncoming(runtime, connection, event, rawPayload, attempt + 1);
    }, delay);
    return;
  }

  // Preserve protocol routing markers from the raw payload on the error
  // frame. Most importantly `_correlationId`: without it a thrown request
  // handler error reaches the client uncorrelated, so the request-response
  // plugin can't settle the pending request and it hangs until timeout.
  await runtime.handleRuntimeError(connection, error, event, routingFromPayload(rawPayload));
}

/**
 * Extract protocol routing markers (correlation, ack, scope) from a raw
 * incoming payload so they can ride along on a server-side error frame and
 * the client can correlate the failure with its pending operation.
 */
function routingFromPayload(rawPayload: unknown): Record<string, unknown> | undefined {
  if (!rawPayload || typeof rawPayload !== 'object') return undefined;
  const record = rawPayload as Record<string, unknown>;
  const routing: Record<string, unknown> = {};
  if (typeof record._correlationId === 'string') routing._correlationId = record._correlationId;
  if (typeof record._ackId === 'string') routing._ackId = record._ackId;
  if (typeof record._channel === 'string') routing._channel = record._channel;
  if (typeof record._channelScope === 'string') routing._channelScope = record._channelScope;
  if (typeof record._namespace === 'string') routing._namespace = record._namespace;
  return Object.keys(routing).length > 0 ? routing : undefined;
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

  // JSON.parse accepts more than plain objects — `null`, `123`, `"text"`,
  // `[]`, `{}`-without-event all parse successfully. Reading `parsed.event`
  // on those would throw and crash the adapter's message handler. Drop them.
  if (!parsed || typeof parsed !== 'object' || typeof parsed.event !== 'string') {
    runtime.logger.warn('Invalid message shape dropped');
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
        const subscribePayload = parsed.payload as Record<string, unknown> | undefined;
        const channel = subscribePayload?._channel;
        const channelScope = subscribePayload?._channelScope;
        const routing: Record<string, unknown> = {};
        if (channel) routing._channel = channel;
        if (channelScope) routing._channelScope = channelScope;
        await runtime.handleRuntimeError(
          connection,
          error,
          '_subscribe',
          Object.keys(routing).length > 0 ? routing : undefined,
        );
      }
      return;
    case '_unsubscribe':
      try {
        await runtime.handleUnsubscribe(
          connection,
          parsed.payload as Record<string, unknown> | undefined,
        );
      } catch (error) {
        const unsubscribePayload = parsed.payload as Record<string, unknown> | undefined;
        const channel = unsubscribePayload?._channel;
        const channelScope = unsubscribePayload?._channelScope;
        const routing: Record<string, unknown> = {};
        if (channel) routing._channel = channel;
        if (channelScope) routing._channelScope = channelScope;
        await runtime.handleRuntimeError(
          connection,
          error,
          '_unsubscribe',
          Object.keys(routing).length > 0 ? routing : undefined,
        );
      }
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
    try {
      const handlers = runtime.protocolHandlers.get(parsed.event) ?? [];
      const scope = resolveScope(runtime.compiled, parsed.payload);
      const ctx = runtime.buildConnectionContext(connection, scope);

      for (const handler of handlers) {
        const handled = await handler(ctx, parsed.payload as Record<string, unknown> | undefined);

        if (handled) return;
      }
    } catch (error) {
      const protocolPayload = parsed.payload as Record<string, unknown> | undefined;
      const channel = protocolPayload?._channel;
      const channelScope = protocolPayload?._channelScope;
      const namespace = protocolPayload?._namespace;
      const routing: Record<string, unknown> = {};
      if (typeof channel === 'string') routing._channel = channel;
      if (typeof channelScope === 'string') routing._channelScope = channelScope;
      if (typeof namespace === 'string') routing._namespace = namespace;
      await runtime.handleRuntimeError(
        connection,
        error,
        parsed.event,
        Object.keys(routing).length > 0 ? routing : undefined,
      );
    }

    return;
  }

  await dispatchIncoming(runtime, connection, parsed.event, parsed.payload);
}
