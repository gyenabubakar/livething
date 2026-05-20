/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  Block,
  ChannelNotFound,
  ChannelNotSubscribed,
  InvalidScopeMarkers,
  NamespaceNotFound,
  rethrowIfConfigError,
  ValidationFailed,
  WskitError,
} from '@wskit/core';
import * as EngineCompileUtils from '~/_engine/compile/utils.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import * as DurableStreamRuntime from '~/_engine/stream-durable/runtime.ts';
import { ensureDurableStreamSchema } from '~/_engine/stream-durable/storage.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as ErrorsPrimitive from '~/errors/errors.ts';
import * as HeartbeatPrimitive from '~/heartbeat/runtime.ts';
import * as InterceptPrimitive from '~/intercept/runtime.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import * as RequestPrimitive from '~/request/runtime.ts';
import * as StreamPrimitive from '~/stream/runtime.ts';
import * as v from 'valibot';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as DurableStreamStorage from '~/_engine/stream-durable/storage.ts';
import type * as PublicApi from '~/context.ts';
import type * as EngineRuntimeTypes from './types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/** Routing markers carried on a server-sent `__error__` frame's `__wskit`. */
export type WskitRouting = Protocol.WskitRouting;

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
  /**
   * SQLite handle from the adapter. Optional at the dispatch type level
   * because not every adapter configures storage; the durable-stream runtime
   * asserts presence when it routes a durable stream.
   */
  sql?: {
    exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
  };
  protocolHandlers: ReadonlyMap<
    Protocol.IncomingProtocolEvent,
    readonly ((
      ctx: any,
      frame: Protocol.IncomingProtocolFrame,
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
    wskit: Record<string, unknown>,
  ): void;
  sendReplay(
    connection: EngineRuntimeTypes.RuntimeConnection,
    channelName: string | null,
    channelScope: string | null,
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
    routing?: WskitRouting,
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
    options?: PublicApi.BroadcastOptions & { namespace?: string; channelScope?: string | null },
    excludeConnectionId?: string,
  ): void;
  handleSubscribe(
    connection: EngineRuntimeTypes.RuntimeConnection,
    frame: Protocol.SubscribeFrame,
  ): Promise<void>;
  handleUnsubscribe(
    connection: EngineRuntimeTypes.RuntimeConnection,
    frame: Protocol.UnsubscribeFrame,
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
  sessionEndHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;
  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Record<PropertyKey, unknown>;
  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;
  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
    wskit: Record<string, unknown>,
  ): void;
  broadcastToChannel(
    channelName: string,
    event: string,
    payload: unknown,
    excludeConnectionId: string | undefined,
    channelScope: string | null,
    excludeSelf?: boolean,
  ): void;
  handleValidationError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    event: string,
    validationError: unknown,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Promise<void>;
  handleRuntimeError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    error: unknown,
    event?: string,
    routing?: WskitRouting,
  ): Promise<void>;
  isChannelPersistent(channelKey: string): boolean;
  persistMembership(identity: string, channelName: string, channelScope: string | null): void;
  deleteDurableMembership(identity: string, channelName: string, channelScope: string | null): void;
}

// ───── Section: wire-error helpers ─────

/**
 * Turn a valibot parse failure into a typed `ValidationFailed` error so a
 * malformed wire frame settles as a `__error__` frame instead of crashing the
 * adapter message handler.
 */
function toValidationFailed(event: string, error: unknown): WskitError {
  if (error instanceof v.ValiError) {
    return ValidationFailed({
      event,
      issues: error.issues.map((issue) => {
        const normalized: { message: string; path?: Array<string | number> } = {
          message: issue.message,
        };
        const path = issue.path
          ?.map((segment: { key?: unknown }) => segment.key)
          .filter(
            (key: unknown): key is string | number =>
              typeof key === 'string' || typeof key === 'number',
          );
        if (path && path.length > 0) normalized.path = path;
        return normalized;
      }),
    });
  }
  return ValidationFailed({
    event,
    issues: [{ message: error instanceof Error ? error.message : String(error) }],
  });
}

// ───── Section: incoming dedup ─────

/**
 * Check whether an incoming frame's `messageId` has already been seen on this
 * connection. If not, record it in the bounded ring.
 *
 * Returns `true` when the frame is a duplicate and should be dropped. Frames
 * without a `messageId` are never considered duplicates — the client opted out
 * of receiver-side dedup for that frame.
 */
function isDuplicateIncoming(
  connection: EngineRuntimeTypes.RuntimeConnection,
  wskit: Protocol.WskitProtocol | undefined,
  cap: number,
): boolean {
  const messageId = wskit?.messageId;
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
 * Read routing markers from a frame's `__wskit` block and resolve the active
 * scope.
 */
export function resolveScope(
  compiled: EngineCompileTypes.CompiledServer,
  wskit: Protocol.WskitProtocol | undefined,
): EngineRuntimeTypes.ResolvedScope {
  if (!wskit) return {};

  // A frame routes to one scope: top-level, namespace, or channel. A frame
  // that names two scopes at once is ambiguous — silently picking one would
  // let a sender bypass channel membership rules by stamping `namespace`
  // alongside `channel`. Reject up front.
  if (wskit.namespace !== undefined && wskit.channel !== undefined) {
    throw InvalidScopeMarkers();
  }

  if (wskit.namespace !== undefined) {
    const namespace = compiled.namespaces.get(wskit.namespace);
    if (!namespace) throw NamespaceNotFound();
    return { namespace };
  }

  if (wskit.channel !== undefined) {
    if (wskit.channelScope !== null) {
      const family = compiled.channelFamilies.get(wskit.channelScope);
      if (!family) throw ChannelNotFound();
      if (!ChannelPrimitive.matchesScopePattern(family.pattern, wskit.channel)) {
        throw ChannelNotFound();
      }
      return {
        channel: family,
        channelName: wskit.channel,
        channelScope: wskit.channelScope,
      };
    }

    const channel = compiled.channels.get(wskit.channel);
    if (!channel) throw ChannelNotFound();
    return {
      channel,
      channelName: wskit.channel,
      channelScope: null,
    };
  }

  return {};
}

/**
 * Pick the routing markers off a frame's `__wskit` block so they can ride
 * along on a server-side `__error__` frame and the client can correlate the
 * failure with its pending operation.
 */
function routingFromWskit(wskit: WskitRouting | undefined): WskitRouting | undefined {
  if (!wskit) return undefined;
  const routing: WskitRouting = {};
  if (wskit.correlationId !== undefined) routing.correlationId = wskit.correlationId;
  if (wskit.ackId !== undefined) routing.ackId = wskit.ackId;
  if (wskit.streamId !== undefined) routing.streamId = wskit.streamId;
  if (wskit.channel !== undefined) {
    routing.channel = wskit.channel;
    routing.channelScope = wskit.channelScope ?? null;
  }
  if (wskit.namespace !== undefined) routing.namespace = wskit.namespace;
  return Object.keys(routing).length > 0 ? routing : undefined;
}

// ───── Section: channel membership helpers ─────

/**
 * Return the current public member snapshot for a channel.
 *
 * The lookup is always exact-match on the (`channelName`, `channelScope`)
 * pair. Pass `null` for static channels and the family key for dynamic
 * channel families. Two scopes that happen to share a concrete channel name
 * stay strictly isolated — no membership ever crosses into the wrong scope.
 */
export function getChannelMembers(
  runtime: EngineRuntimeTypes.ConnectionMembersRuntime,
  channelName: string,
  channelScope: string | null,
): PublicApi.ConnectionInfo<Record<string, unknown>>[] {
  const membershipKey = ChannelPrimitive.createChannelMembershipKey(channelName, channelScope);

  return [...runtime.connections.values()]
    .filter((connection) => connection.channelMemberships.has(membershipKey))
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
      | 'wskitStampHooks'
    > & {
      leaveChannel(
        connection: EngineRuntimeTypes.RuntimeConnection,
        scope: {
          channel?: EngineCompileTypes.CompiledChannel;
          channelName: string;
          channelScope: string | null;
        },
        kickedReason?: string,
      ): Promise<void>;
    },
  channelName: string,
  target: ChannelPrimitive.KickTarget,
  reason: string,
  channelScope: string | null,
): Promise<void> {
  return ChannelPrimitive.kickChannelMembers(runtime, channelName, target, reason, channelScope);
}

/**
 * Handle the `__subscribe__` protocol frame for a channel.
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
      | 'wskitStampHooks'
    >,
  connection: EngineRuntimeTypes.RuntimeConnection,
  frame: Protocol.SubscribeFrame,
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
    frame.__wskit.channel,
    frame.__wskit.channelScope,
    frame.payload,
  );
}

/**
 * Server-initiated `channelHandle.subscribe(ref)`. Looks the target connection
 * up from the ref, refuses cross-instance refs until the broker exists, and
 * delegates to the channel primitive's server-side subscribe path.
 */
export async function subscribeFromServer(
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
      | 'wskitStampHooks'
    > & { instanceId: string | undefined },
  ref: { __wskit: 'connection-ref'; id: string; instance: string | undefined; identity: string },
  channelName: string,
  channelScope: string | null,
  payload: unknown,
  rejoining = false,
): Promise<void> {
  if (ref.instance !== runtime.instanceId) {
    throw new Error(
      `[wskit] channelHandle.subscribe(ref) targets instance "${ref.instance ?? 'undefined'}" but this engine is "${runtime.instanceId ?? 'undefined'}" — cross-instance routing requires a broker, which is not configured yet.`,
    );
  }

  const target = runtime.connections.get(ref.id);
  if (!target) {
    throw new Error(
      `[wskit] channelHandle.subscribe(ref) — no live connection with id "${ref.id}" on this instance.`,
    );
  }

  await ChannelPrimitive.subscribeConnectionAsServer(
    {
      ...runtime,
      broadcastToChannel: (
        channelName2,
        event,
        nextPayload,
        excludeConnectionId,
        channelScope2,
        excludeSelf,
      ) => {
        OutgoingRuntime.broadcastToChannel(
          runtime,
          channelName2,
          event,
          nextPayload,
          excludeConnectionId,
          channelScope2,
          excludeSelf,
        );
      },
      toConnectionInfo: (nextConnection) => runtime.toConnectionInfo(nextConnection),
    },
    target,
    channelName,
    channelScope,
    payload,
    rejoining,
  );
}

/**
 * Handle the `__unsubscribe__` protocol frame for a channel.
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
      | 'wskitStampHooks'
    > & {
      leaveChannel(
        connection: EngineRuntimeTypes.RuntimeConnection,
        scope: {
          channel?: EngineCompileTypes.CompiledChannel;
          channelName: string;
          channelScope: string | null;
        },
      ): Promise<void>;
    },
  connection: EngineRuntimeTypes.RuntimeConnection,
  frame: Protocol.UnsubscribeFrame,
): Promise<void> {
  await ChannelPrimitive.unsubscribeConnection(
    runtime,
    connection,
    frame.__wskit.channel,
    frame.__wskit.channelScope,
  );
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
  payload: unknown,
  wskit: Protocol.WskitProtocol | undefined,
  attempt = 0,
): Promise<void> {
  // Dedup is handled at the top of `processTextMessage` so it covers
  // incoming events, requests, and stream nudges with one budget.
  // Defer retries re-enter this function directly with attempt > 0 and
  // are intentionally not deduped — the engine is replaying its own
  // queued work, not the client's resend.

  let scope: EngineRuntimeTypes.ResolvedScope;
  try {
    scope = resolveScope(runtime.compiled, wskit);
  } catch (error) {
    // resolveScope can throw NamespaceNotFound / ChannelNotFound /
    // InvalidScopeMarkers when the routing markers are missing, unknown, or
    // contradictory. Route those through the runtime-error path so the
    // client gets a typed `__error__` frame.
    await runtime.handleRuntimeError(connection, error, event, routingFromWskit(wskit));
    return;
  }
  if (
    scope.channelName &&
    !ChannelPrimitive.hasChannelMembership(
      connection,
      scope.channelName,
      scope.channelScope ?? null,
    )
  ) {
    await runtime.handleRuntimeError(connection, ChannelNotSubscribed(), event, {
      channel: scope.channelName,
      channelScope: scope.channelScope ?? null,
    });
    return;
  }

  // Scope isolation: when the frame claims a channel or namespace scope, only
  // handlers declared inside that scope are reachable. Falling back to
  // top-level handlers from inside a scope would let a channel member fire
  // any top-level event by tagging it with `channel: '...'`, breaking scope
  // contracts (and potentially leaking admin-only top-level events to
  // channel-subscribed clients).
  const scoped = scope.channel ?? scope.namespace;
  const incoming = scoped ? scoped.incoming.get(event) : runtime.compiled.incoming.get(event);
  const request = scoped ? scoped.requests.get(event) : runtime.compiled.requests.get(event);
  const stream = scoped ? scoped.streams.get(event) : runtime.compiled.streams.get(event);
  const resumableStream = scoped
    ? scoped.resumableStreams.get(event)
    : runtime.compiled.resumableStreams.get(event);
  const recordedStream = scoped
    ? scoped.recordedStreams.get(event)
    : runtime.compiled.recordedStreams.get(event);

  let message = { event, payload };

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

    const primitive = incoming ?? request ?? stream ?? resumableStream ?? recordedStream;
    if (!primitive) return;

    // `message.payload` is already pure user data — framework metadata lives
    // in `__wskit`, so there is nothing to strip before validation.
    let payloadValue: unknown;
    try {
      payloadValue = EngineCompileUtils.validateValue(
        'stream' in primitive ? primitive.stream.validator : primitive.validator,
        message.payload,
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
      // Preserve protocol routing markers (especially `correlationId`) so a
      // request whose payload fails the schema settles via the client
      // request-response plugin instead of hanging until timeout.
      await runtime.handleRuntimeError(connection, error, event, routingFromWskit(wskit));
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
      payloadValue,
    );

    // Stash the ack correlation id (if any) so `ctx.ack()` inside the handler
    // knows which client-side Promise to resolve.
    connection.activeAckId = wskit?.ackId;

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
        wskit,
      );
      return;
    }

    if (stream) {
      await StreamPrimitive.runStream(
        runtime,
        connection,
        scope,
        event,
        stream,
        postPayload,
        wskit,
      );
    } else if (resumableStream || recordedStream) {
      const durable = resumableStream ?? recordedStream!;
      if (!runtime.sql) {
        throw new Error(
          '[wskit] durable stream "' +
            durable.event +
            '" requires storage; the adapter did not call engine.setStorage(...).',
        );
      }
      ensureDurableStreamSchema(runtime.sql);
      await DurableStreamRuntime.runDurableStream(
        runtime as unknown as DurableStreamRuntime.DurableStreamRuntime,
        connection,
        scope,
        {
          event: durable.event,
          kind: resumableStream ? 'resumable' : 'recorded',
          generator: durable.generator,
          allowConcurrent: durable.allowConcurrent,
          broadcast: durable.broadcast ?? false,
          nudges: durable.nudges,
          maxChunks: recordedStream?.maxChunks ?? resumableStream?.maxChunks,
          maxAgeMs: durable.maxAgeMs,
          retentionAfterEndMs: durable.retentionAfterEndMs,
          cursor: resumableStream?.cursor,
          onDisconnect: durable.onDisconnect,
        },
        postPayload,
        wskit,
      );
    }
  } catch (error) {
    await handleDispatchError(runtime, connection, event, payload, wskit, scope, error, attempt);
  }
}

async function handleDispatchError(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  event: string,
  payload: unknown,
  wskit: Protocol.WskitProtocol | undefined,
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
    await runtime.handleRuntimeError(connection, error, event, routingFromWskit(wskit));
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
        payload,
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
      void dispatchIncoming(runtime, connection, event, payload, wskit, attempt + 1);
    }, delay);
    return;
  }

  // Preserve protocol routing markers from the frame's `__wskit` on the error
  // frame. Most importantly `correlationId`: without it a thrown request
  // handler error reaches the client uncorrelated, so the request-response
  // plugin can't settle the pending request and it hangs until timeout.
  await runtime.handleRuntimeError(connection, error, event, routingFromWskit(wskit));
}

// Locate a compiled durable-stream def for a stored row, restoring the same
// scope (top-level / namespace / channel) the row was started in. Returns
// undefined when the def has gone away (e.g. server redeployed without it),
// the scope no longer exists, or the resuming connection is not a member of
// the channel the stream was started in.
function resolveDurableDefForRow(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  row: DurableStreamStorage.DurableStreamRow,
):
  | {
      def: DurableStreamRuntime.DurableStreamRuntimeDef;
      scope: EngineRuntimeTypes.ResolvedScope;
    }
  | undefined {
  let scope: EngineRuntimeTypes.ResolvedScope = {};
  let resumable: EngineCompileTypes.AnyResumableStream | undefined;
  let recorded: EngineCompileTypes.AnyRecordedStream | undefined;

  if (row.channelKey) {
    const channel =
      row.channelScope !== null
        ? runtime.compiled.channelFamilies.get(row.channelScope)
        : runtime.compiled.channels.get(row.channelKey);
    if (!channel) return undefined;
    if (!ChannelPrimitive.hasChannelMembership(connection, row.channelKey, row.channelScope)) {
      return undefined;
    }
    scope = { channel, channelName: row.channelKey, channelScope: row.channelScope };
    resumable = channel.resumableStreams.get(row.event);
    recorded = channel.recordedStreams.get(row.event);
  } else if (row.namespace) {
    const namespace = runtime.compiled.namespaces.get(row.namespace);
    if (!namespace) return undefined;
    scope = { namespace };
    resumable = namespace.resumableStreams.get(row.event);
    recorded = namespace.recordedStreams.get(row.event);
  } else {
    resumable = runtime.compiled.resumableStreams.get(row.event);
    recorded = runtime.compiled.recordedStreams.get(row.event);
  }

  if (resumable) {
    return {
      scope,
      def: {
        event: resumable.event,
        kind: 'resumable',
        generator: resumable.generator,
        allowConcurrent: resumable.allowConcurrent,
        broadcast: resumable.broadcast,
        nudges: resumable.nudges,
        maxChunks: resumable.maxChunks,
        maxAgeMs: resumable.maxAgeMs,
        retentionAfterEndMs: resumable.retentionAfterEndMs,
        cursor: resumable.cursor,
        onDisconnect: resumable.onDisconnect,
      },
    };
  }
  if (recorded) {
    return {
      scope,
      def: {
        event: recorded.event,
        kind: 'recorded',
        generator: recorded.generator,
        allowConcurrent: recorded.allowConcurrent,
        broadcast: recorded.broadcast,
        nudges: recorded.nudges,
        maxChunks: recorded.maxChunks,
        maxAgeMs: recorded.maxAgeMs,
        retentionAfterEndMs: recorded.retentionAfterEndMs,
        onDisconnect: recorded.onDisconnect,
      },
    };
  }
  return undefined;
}

/** Handle a client `__resumeStream__` frame for a suspended or ended durable stream. */
async function handleResumeStream(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  frame: Protocol.ResumeStreamFrame,
): Promise<void> {
  const streamId = frame.__wskit.streamId;
  const lastKnownSeq = frame.payload.lastKnownSeq ?? 0;

  if (!runtime.sql) {
    runtime.sendProtocolMessage(
      connection,
      '__error__',
      { code: 'stream-aborted', detail: { reason: 'not-found' as const } },
      { streamId },
    );
    return;
  }
  ensureDurableStreamSchema(runtime.sql);

  // The frame may carry namespace / channel / channelScope so the resume hits
  // a broadcast scope-key row when the user wasn't the original creator.
  let resumeScope: EngineRuntimeTypes.ResolvedScope = {};
  try {
    resumeScope = resolveScope(runtime.compiled, frame.__wskit);
  } catch {
    /* malformed routing markers — fall back to top-level lookup */
  }
  const durableRuntime = runtime as unknown as DurableStreamRuntime.DurableStreamRuntime;
  const row = DurableStreamRuntime.findResumeRow(durableRuntime, connection, resumeScope, streamId);
  await DurableStreamRuntime.resumeDurableStream(
    durableRuntime,
    connection,
    (matched) => resolveDurableDefForRow(runtime, connection, matched),
    row,
    streamId,
    lastKnownSeq,
  );
}

/**
 * Parse and dispatch one protocol frame (`__x__` event name).
 */
async function dispatchProtocolFrame(
  runtime: DispatchRuntime & {
    activityHooks: readonly ((connectionId: string) => void | Promise<void>)[];
  },
  connection: RuntimeConnection,
  parsed: object,
): Promise<void> {
  let frame: Protocol.IncomingProtocolFrame;
  try {
    frame = v.parse(Protocol.IncomingProtocolFrame, parsed);
  } catch (error) {
    const rawEvent = (parsed as { event?: unknown }).event;
    const event = typeof rawEvent === 'string' ? rawEvent : 'protocol';
    await runtime.handleRuntimeError(connection, toValidationFailed(event, error), event);
    return;
  }

  try {
    switch (frame.event) {
      case '__subscribe__':
        await runtime.handleSubscribe(connection, frame);
        return;
      case '__unsubscribe__':
        await runtime.handleUnsubscribe(connection, frame);
        return;
      case '__streamCancel__': {
        await StreamPrimitive.cancelStream(runtime, connection, frame.__wskit.streamId);
        if (runtime.sql) {
          // A broadcast durable stream's row is keyed by its scope, so the
          // cancel frame's routing markers are needed to find it.
          let cancelScope: EngineRuntimeTypes.ResolvedScope = {};
          try {
            cancelScope = resolveScope(runtime.compiled, frame.__wskit);
          } catch {
            /* malformed routing — fall back to a top-level lookup */
          }
          await DurableStreamRuntime.cancelDurableStream(
            runtime as unknown as DurableStreamRuntime.DurableStreamRuntime,
            connection,
            frame.__wskit.streamId,
            cancelScope,
          );
        }
        return;
      }
      case '__resumeStream__':
        await handleResumeStream(runtime, connection, frame);
        return;
      case '__replay__': {
        const handlers = runtime.protocolHandlers.get('__replay__') ?? [];
        const scope = resolveScope(runtime.compiled, frame.__wskit);
        const ctx = runtime.buildConnectionContext(connection, scope);
        for (const handler of handlers) {
          const handled = await handler(ctx, frame);
          if (handled) return;
        }
        return;
      }
    }
  } catch (error) {
    await runtime.handleRuntimeError(
      connection,
      error,
      frame.event,
      routingFromWskit(frame.__wskit),
    );
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

  // `ping` / `pong` stay raw text frames — never envelope-wrapped.
  if (data === 'ping') {
    connection.descriptor.send('pong');
    return;
  }

  if (data === 'pong') {
    HeartbeatPrimitive.recordConnectionLatency(connection);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    runtime.logger.warn('Invalid JSON message dropped');
    return;
  }

  // JSON.parse accepts more than plain objects — `null`, `123`, `"text"`,
  // `[]`, `{}`-without-event all parse successfully. Drop anything that is not
  // a plain object with a string `event`.
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as { event?: unknown }).event !== 'string'
  ) {
    runtime.logger.warn('Invalid message shape dropped');
    return;
  }

  const event = (parsed as { event: string }).event;

  // A JSON `{ event: 'ping' }` frame answers with a JSON `{ event: 'pong' }`.
  // (Raw text `ping`/`pong` are handled above.)
  if (event === 'ping') {
    connection.descriptor.send(JSON.stringify({ event: 'pong' }));
    return;
  }

  // Protocol frames are parsed against the protocol variant and routed by the
  // dispatcher. They are excluded from dedup and nudge buffering — a retried
  // protocol frame must reach its handler even when the original was lost.
  if (Protocol.isProtocolEventName(event)) {
    await dispatchProtocolFrame(runtime, connection, parsed);
    return;
  }

  // User-event frame: app event with an optional `__wskit` block.
  let frame: Protocol.UserEventFrame;
  try {
    frame = v.parse(Protocol.UserEventFrameSchema, parsed);
  } catch (error) {
    await runtime.handleRuntimeError(connection, toValidationFailed(event, error), event);
    return;
  }
  const wskit = frame.__wskit;

  // Dedup at the gateway so every wire frame carrying `messageId` shares one
  // idempotency budget — incoming events, requests, and stream nudges. The
  // Defer retry path re-enters `dispatchIncoming` directly, so engine-internal
  // retries naturally skip the check.
  if (
    runtime.incomingDedupCap > 0 &&
    isDuplicateIncoming(connection, wskit, runtime.incomingDedupCap)
  ) {
    return;
  }

  // Stream trigger frames must skip nudge buffering even when they carry a
  // streamId. The check walks the scope the frame is targeting so a channel-
  // or namespace-scoped durable stream trigger isn't misrouted into the nudge
  // buffer.
  let triggerScope: EngineRuntimeTypes.ResolvedScope = {};
  try {
    triggerScope = resolveScope(runtime.compiled, wskit);
  } catch {
    /* malformed routing — fall back to top-level maps */
  }
  const triggerScoped = triggerScope.channel ?? triggerScope.namespace;
  const isStreamTrigger = triggerScoped
    ? triggerScoped.streams.has(event) ||
      triggerScoped.resumableStreams.has(event) ||
      triggerScoped.recordedStreams.has(event)
    : runtime.compiled.streams.has(event) ||
      runtime.compiled.resumableStreams.has(event) ||
      runtime.compiled.recordedStreams.has(event);
  if (
    !isStreamTrigger &&
    (await StreamPrimitive.bufferStreamNudge(runtime, connection, event, frame.payload, wskit))
  ) {
    return;
  }

  await dispatchIncoming(runtime, connection, event, frame.payload, wskit);
}
