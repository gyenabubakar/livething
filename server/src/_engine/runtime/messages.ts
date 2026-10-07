/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  Block,
  ChannelNotSubscribed,
  LiveThingError,
  rethrowIfConfigError,
  UnsupportedProtocol,
  ValidationFailed,
} from '@livething/core';
import {
  connectionCall,
  withConnectionCall,
  withConnectionLevelCall,
} from '~/_engine/async-context.ts';
import * as EngineCompileUtils from '~/_engine/compile/utils.ts';
import { forEachIsolatedAsync } from '~/_engine/runtime/isolation.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import * as ErrorsPrimitive from '~/errors/errors.ts';
import { frameOwner } from '~/plugin-scope.ts';
import * as v from 'valibot';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as FeatureSlots from '~/_engine/runtime/feature-slots.ts';
import type * as InterceptPrimitive from '~/intercept/intercept.ts';
import type * as OutgoingRuntime from '~/outgoing/runtime.ts';
import { resolveChannel, routingFromLiveThing } from './scope.ts';
import { runConnectionWork } from './work-queue.ts';
import type * as EngineRuntimeTypes from './types.ts';

type MessageParameter = { event: string; payload: unknown };
type FrameParameter = {
  event: string;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
};
type OptsParameter = {
  event: string;
  payload: Record<string, unknown>;
  livething: Record<string, unknown>;
};
type OptsParameter2 = {
  channelName: string | null;
  channelFamily: string | null;
  event: string;
  payload: unknown;
  wire: { deliverySeq: number; messageId: string; channel?: string };
};
type OptsParameter3 = { error: unknown; event?: string; routing?: Protocol.LiveThingRouting };
type OptsParameter4 = {
  event: string;
  validationError: unknown;
  scope?: EngineRuntimeTypes.ResolvedChannel;
};

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

interface ValidationIssue {
  message: string;
  path?: Array<string | number>;
}

interface ValidationPathSegment {
  key?: unknown;
}

interface InterceptRoutingFields {
  messageId?: string;
  correlationId?: string;
  streamId?: string;
  channel?: string;
  channelFamily?: string | null;
  deliverySeq?: number;
  streamSeq?: number;
}

/**
 * Whether a connection currently holds a channel membership. Computed inline
 * rather than through the imported `hasChannelMembership`: a cross-module
 * reference to that function is mis-linked to an undefined binding in the
 * bundled worker at the dispatch sites below, so we build the key here. Keep
 * this key in sync with `createChannelMembershipKey`.
 */
function connectionHoldsMembership(
  connection: Pick<RuntimeConnection, 'channelMemberships'>,
  channelName: string,
  channelFamily: string | null,
): boolean {
  return connection.channelMemberships.has(JSON.stringify([channelFamily, channelName]));
}

/**
 * Upper bound on concurrent pending `Defer` retry timers per connection. Past
 * this, a deferring message is exhausted instead of scheduling another timer,
 * so a flood of distinct deferring messages can't grow timers without limit.
 */
const MAX_PENDING_DEFERS = 128;

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

  incomingHooks: readonly ((message: MessageParameter) => unknown | void)[];

  answerFrameHooks: readonly ((connectionId: string, frame: FrameParameter) => boolean)[];

  /**
   * Size of the per-connection seen-id ring used by incoming dedup. Zero means
   * incoming dedup is disabled (no `dedup()` primitive registered).
   */
  incomingDedupCap: number;

  errorHooks: readonly ((ctx: any, error: unknown, event?: string) => void | Promise<void>)[];

  declaredErrorCodes: ReadonlySet<string>;

  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedChannel,
  ): Record<PropertyKey, unknown>;

  sendProtocolMessage(connection: EngineRuntimeTypes.RuntimeConnection, opts: OptsParameter): void;

  sendReplay(connection: EngineRuntimeTypes.RuntimeConnection, opts: OptsParameter2): void;

  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;

  asyncContext: EngineAsyncContext;

  handleRuntimeError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: OptsParameter3,
  ): Promise<void>;

  handleValidationError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: OptsParameter4,
  ): Promise<void>;

  broadcastToConnections(
    connections: Iterable<EngineRuntimeTypes.RuntimeConnection>,
    opts: OutgoingRuntime.BroadcastToConnectionsOptions,
  ): void;

  handleSubscribe(
    connection: EngineRuntimeTypes.RuntimeConnection,
    frame: Protocol.SubscribeFrame,
  ): Promise<void>;

  handleUnsubscribe(
    connection: EngineRuntimeTypes.RuntimeConnection,
    frame: Protocol.UnsubscribeFrame,
  ): Promise<void>;

  handleMemberSync(
    connection: EngineRuntimeTypes.RuntimeConnection,
    frame: Protocol.MemberSyncRequestFrame,
  ): void;

  /**
   * Tracks whether the durable-stream schema has already run in this engine
   * instance lifetime. Flipped to `true` on first stream start or continue so
   * subsequent operations skip the redundant DDL check.
   */
  durableStreamSchemaReady: boolean;

  /** Feature dispatch slots filled by the stream/request capabilities. */
  streamTrigger?: FeatureSlots.StreamTrigger;
  streamNudgeBuffer?: FeatureSlots.StreamNudgeBuffer;
  streamCancel?: FeatureSlots.StreamCancel;
  durableStream?: FeatureSlots.DurableStreamService;
  requestDispatch?: FeatureSlots.RequestDispatch;
  runIntercepts?: FeatureSlots.RunIntercepts;
}

/**
 * Turn a valibot parse failure into a typed `ValidationFailed` error so a
 * malformed wire frame settles as a `__error__` frame instead of crashing the
 * adapter message handler.
 */
function toValidationFailed(event: string, error: unknown): LiveThingError {
  if (error instanceof v.ValiError) {
    return ValidationFailed({
      event,
      issues: error.issues.map((issue) => {
        const normalized: ValidationIssue = {
          message: issue.message,
        };

        const path = issue.path
          ?.map((segment: ValidationPathSegment) => segment.key)
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
  livething: Protocol.LiveThingProtocol | undefined,
  cap: number,
): boolean {
  const messageId = livething?.messageId;
  // The wire schema bounds and non-empties `messageId` (`WireId`); absent means
  // the client opted out of receiver-side dedup for this frame.
  if (messageId === undefined) return false;

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

/**
 * Build the curated `routing` view of a frame's `__livething` envelope for the
 * intercept callback. Returns an empty object when no routing markers were
 * sent so callers never have to null-check.
 */
function buildInterceptRouting(
  livething: Protocol.LiveThingProtocol | undefined,
): InterceptPrimitive.InterceptRouting {
  if (!livething) return {};

  const routing: InterceptRoutingFields = {};
  if (livething.messageId !== undefined) routing.messageId = livething.messageId;
  if (livething.correlationId !== undefined) routing.correlationId = livething.correlationId;
  if (livething.streamId !== undefined) routing.streamId = livething.streamId;

  if (livething.channel !== undefined) {
    routing.channel = livething.channel;
    routing.channelFamily = livething.channelFamily ?? null;
  }

  if (livething.deliverySeq !== undefined) routing.deliverySeq = livething.deliverySeq;
  if (livething.streamSeq !== undefined) routing.streamSeq = livething.streamSeq;

  return routing;
}

export interface DispatchIncomingOptions {
  event: string;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
  attempt?: number;
  // The already-resolved scope from processTextMessage, so a channel frame isn't
  // resolved twice. Omitted on a Defer retry, which re-resolves from scratch.
  scope?: EngineRuntimeTypes.ResolvedChannel;
}

interface HandleDispatchErrorOptions {
  event: string;

  payload: unknown;

  livething: Protocol.LiveThingProtocol | undefined;

  scope: EngineRuntimeTypes.ResolvedChannel;

  error: unknown;

  attempt: number;

  /**
   * True only when the throw came from an `on()` handler body. `Defer` re-queues
   * the message, which is meaningful only for an `on()` handler: a request would
   * re-run and re-answer a settled correlation, an intercept fires on every frame
   * kind, and a stream can't restart after yielding. So `Defer` is honored only
   * when this is set; thrown anywhere else it collapses to `internal-error`.
   */
  fromIncomingHandler: boolean;
}

/**
 * Main inbound event dispatcher.
 *
 * Runs plugin hooks, intercepts, validation, incoming handlers, requests, and
 * streams in that fixed order.
 */
export async function dispatchIncoming(
  runtime: DispatchRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  opts: DispatchIncomingOptions,
): Promise<void> {
  const { event, payload, livething, attempt = 0 } = opts;
  // Dedup runs in `processTextMessage`. Defer retries re-enter here directly
  // and skip dedup — that is the engine replaying its own work, not a resend.

  // Bail if the connection is already closing. A Defer retry is scheduled on a
  // timer; if the socket closed during the delay, re-running the handler would
  // fire side effects (sends, broadcasts, storage writes) for a client that is
  // gone — and the connection is already out of the runtime maps by then.
  if (connection.closing) return;

  let scope: EngineRuntimeTypes.ResolvedChannel;
  if (opts.scope) {
    scope = opts.scope;
  } else {
    try {
      scope = resolveChannel(runtime.compiled, livething);
    } catch (error) {
      await runtime.handleRuntimeError(connection, {
        error,
        event,
        routing: routingFromLiveThing(livething),
      });
      return;
    }
  }

  if (
    scope.channelName &&
    !connectionHoldsMembership(connection, scope.channelName, scope.channelFamily ?? null)
  ) {
    // Keep every incoming routing id (correlationId/ackId/streamId/…) so the
    // client can match this error to its pending op, then stamp the channel markers.
    const routing: Protocol.LiveThingRouting = routingFromLiveThing(livething) ?? {};
    routing.channel = scope.channelName;
    routing.channelFamily = scope.channelFamily ?? null;
    // A nudge frame's reject is non-terminal — keep the stream alive on the client.
    if (livething?.streamNudgeId !== undefined) routing.streamTerminated = false;
    await runtime.handleRuntimeError(connection, {
      error: ChannelNotSubscribed(),
      event,
      routing,
    });
    return;
  }

  const scoped = scope.channel;
  const incoming = scoped ? scoped.incoming.get(event) : runtime.compiled.incoming.get(event);
  const request = scoped ? scoped.requests.get(event) : runtime.compiled.requests.get(event);
  const stream = scoped ? scoped.streams.get(event) : runtime.compiled.streams.get(event);

  const cursorStream = scoped
    ? scoped.cursorStreams.get(event)
    : runtime.compiled.cursorStreams.get(event);

  const recordedStream = scoped
    ? scoped.recordedStreams.get(event)
    : runtime.compiled.recordedStreams.get(event);

  let sharedCtx: Record<PropertyKey, unknown> | undefined;
  function getCtx(): Record<PropertyKey, unknown> {
    return (sharedCtx ??= runtime.buildConnectionContext(connection, scope));
  }

  let message = { event, payload };
  // Set once the `on()` handler is about to run, so the catch can tell a Defer
  // thrown from the handler body (honored) from one thrown by an intercept or a
  // request handler (collapsed to internal-error).
  let fromIncomingHandler = false;

  try {
    if (attempt === 0) {
      for (const hook of runtime.incomingHooks) {
        const next = hook(message);
        if (next !== undefined) message = { event: message.event, payload: next };
      }
    }

    if (attempt === 0 && runtime.runIntercepts) {
      let interceptKind: 'incoming' | 'request' | 'stream' | 'unknown' = 'unknown';
      if (incoming) interceptKind = 'incoming';
      else if (request) interceptKind = 'request';
      else if (stream || cursorStream || recordedStream) interceptKind = 'stream';
      const interceptRouting = buildInterceptRouting(livething);
      let frame: InterceptPrimitive.InterceptFrame = {
        event,
        payload: message.payload,
        kind: interceptKind,
        routing: interceptRouting,
        owner: frameOwner(event),
      };

      frame = await runtime.runIntercepts(runtime, connection, {
        intercepts: runtime.compiled.intercepts,
        frame,
        getCtx,
        call: { kind: 'connection', getCtx },
      });

      if (scope.channel) {
        frame = await runtime.runIntercepts(runtime, connection, {
          intercepts: scope.channel.intercepts,
          frame,
          getCtx,
          call: connectionCall(connection.id, scope, getCtx),
        });
      }

      message = { event: frame.event, payload: frame.payload };
    }

    const primitive = incoming ?? request ?? stream ?? cursorStream ?? recordedStream;
    if (!primitive) return;

    let payloadValue: unknown;
    try {
      payloadValue = EngineCompileUtils.validateValue(
        'stream' in primitive ? primitive.stream.validator : primitive.validator,
        message.payload,
        event,
      );
    } catch (error) {
      rethrowIfConfigError(error);
      // Route the validation error fully here and stop. Rethrowing would make
      // the outer catch fire the user hooks a second time.
      await runtime.handleValidationError(connection, { event, validationError: error, scope });
      // Keep routing markers (`correlationId`) so a bad-payload request settles
      // on the client instead of hanging until timeout.
      await runtime.handleRuntimeError(connection, {
        error,
        event,
        routing: routingFromLiveThing(livething),
      });
      return;
    }

    if (incoming) {
      fromIncomingHandler = true;
      await runConnectionWork(connection, incoming.allowInterleaving ?? false, () => {
        if (connection.closing) return;

        return withConnectionCall(
          runtime.asyncContext,
          connectionCall(connection.id, scope, getCtx),
          () => incoming.handler(getCtx(), payloadValue),
        );
      });
      return;
    }

    if (request) {
      await runConnectionWork(connection, request.allowInterleaving ?? true, () => {
        if (connection.closing) return;

        return runtime.requestDispatch?.(runtime, connection, {
          connection,
          ctx: getCtx(),
          scope,
          event,
          request,
          payload: payloadValue,
          livething,
        });
      });
      return;
    }

    if (stream) {
      await runtime.streamTrigger?.(runtime, connection, {
        scope,
        event,
        stream,
        payload: payloadValue,
        livething,
      });
    } else if (cursorStream || recordedStream) {
      const durable = cursorStream ?? recordedStream!;
      await runtime.durableStream?.trigger(runtime, connection, {
        scope,
        durable,
        kind: cursorStream ? 'cursor' : 'recorded',
        payload: payloadValue,
        livething,
      });
    }
  } catch (error) {
    await handleDispatchError(runtime, connection, {
      event,
      payload: message.payload,
      livething,
      scope,
      error,
      attempt,
      fromIncomingHandler,
    });
  }
}

async function handleDispatchError(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  opts: HandleDispatchErrorOptions,
): Promise<void> {
  const { event, payload, livething, scope, error, attempt, fromIncomingHandler } = opts;
  rethrowIfConfigError(error);
  if (error === Block) return;

  const isDefer =
    !!error &&
    typeof error === 'object' &&
    (error as { __livething?: string }).__livething === 'defer';

  // `Defer` re-queues the message, which only makes sense for an `on()` handler.
  // Thrown from an intercept (fires on every frame kind), a request handler
  // (would re-answer a settled correlation), or anywhere else, it is a mistake —
  // log it and let it fall through to `internal-error` below.
  if (isDefer && !fromIncomingHandler) {
    runtime.logger.error(
      '[livething] Defer is only valid in an on() handler — ignoring it and surfacing internal-error',
      { event },
    );
  }

  if (error instanceof LiveThingError && error.code === 'validation-failed') {
    await runtime.handleValidationError(connection, { event, validationError: error, scope });
    await runtime.handleRuntimeError(connection, {
      error,
      event,
      routing: routingFromLiveThing(livething),
    });
    return;
  }

  if (
    error &&
    typeof error === 'object' &&
    (error as { __livething?: string }).__livething === 'disconnect'
  ) {
    connection.descriptor.close(
      (error as { code: number }).code,
      (error as { reason: string }).reason,
    );
    return;
  }

  // Defer — re-queue the message after a delay. Give up and fire
  // DeferExhausted after 3 retries, or when this connection already has
  // MAX_PENDING_DEFERS timers in flight. Only an `on()` handler may Defer; a
  // Defer from anywhere else fell through the guard above and lands on the
  // generic `internal-error` path below.
  if (isDefer && fromIncomingHandler) {
    const pendingDefers = connection.deferTimers?.size ?? 0;
    if (attempt >= 3 || pendingDefers >= MAX_PENDING_DEFERS) {
      const exhausted = ErrorsPrimitive.DeferExhausted({
        event,
        payload,
        retries: attempt,
      });
      // Fire onError hooks only — DeferExhausted must not reach the client.
      // Isolate per hook so an observer throw never escapes dispatch as an
      // unhandled rejection — this code runs inside `void dispatchIncoming`.
      await forEachIsolatedAsync(
        runtime.errorHooks,
        (hook) => {
          const ctx = runtime.buildConnectionContext(connection, scope);
          return withConnectionLevelCall(
            runtime.asyncContext,
            { connectionId: connection.id, ctx },
            () => hook(ctx, exhausted, event),
          );
        },
        { context: `onError hook (DeferExhausted) event="${event}"` },
      );
      return;
    }

    const delay = Number((error as { delay: number }).delay);
    const timers = (connection.deferTimers ??= new Set());
    const timer = setTimeout(() => {
      timers.delete(timer);
      void dispatchIncoming(runtime, connection, {
        event,
        payload,
        livething,
        attempt: attempt + 1,
      });
    }, delay);
    timers.add(timer);
    return;
  }

  // Keep routing markers (`correlationId`) so a thrown request error settles
  // on the client instead of hanging until timeout.
  await runtime.handleRuntimeError(connection, {
    error,
    event,
    routing: routingFromLiveThing(livething),
  });
}

/** Handle a client `__continueStream__` frame for a suspended or ended durable stream. */
async function handleContinueStream(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  frame: Protocol.ContinueStreamFrame,
): Promise<void> {
  const streamId = frame.__livething.streamId;
  const lastKnownSeq = frame.payload.lastKnownSeq ?? 0;

  if (!runtime.durableStream) {
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: UnsupportedProtocol.code, detail: { event: '__continueStream__' } },
      livething: { streamId },
    });
    return;
  }

  let continueScope: EngineRuntimeTypes.ResolvedChannel;
  try {
    continueScope = resolveChannel(runtime.compiled, frame.__livething);
  } catch (error) {
    await runtime.handleRuntimeError(connection, {
      error,
      event: frame.event,
      routing: routingFromLiveThing(frame.__livething),
    });
    return;
  }

  await runtime.durableStream.continue(runtime, connection, {
    continueScope,
    streamId,
    lastKnownSeq,
  });
}

/** Cancel a stream for a client `__streamCancel__` frame: the live side, then the durable row. */
async function handleStreamCancel(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  frame: Protocol.StreamCancelFrame,
): Promise<void> {
  await runtime.streamCancel?.(runtime, connection, frame.__livething.streamId);
  if (!runtime.durableStream || !runtime.sql) return;

  let cancelScope: EngineRuntimeTypes.ResolvedChannel;
  try {
    cancelScope = resolveChannel(runtime.compiled, frame.__livething);
  } catch (error) {
    await runtime.handleRuntimeError(connection, {
      error,
      event: frame.event,
      routing: routingFromLiveThing(frame.__livething),
    });
    return;
  }

  await runtime.durableStream.cancel(runtime, connection, {
    streamId: frame.__livething.streamId,
    cancelScope,
  });
}

/**
 * Parse and dispatch one protocol frame (`__x__` event name).
 */
async function dispatchProtocolFrame(
  runtime: DispatchRuntime & {
    activityHooks: readonly ((connectionId: string) => void | Promise<void>)[];
  },
  connection: RuntimeConnection,
  parsed: unknown,
): Promise<void> {
  let frame: Protocol.IncomingProtocolFrame;
  try {
    frame = v.parse(Protocol.IncomingProtocolFrame, parsed);
  } catch (error) {
    const rawEvent = Array.isArray(parsed) ? parsed[0] : undefined;
    const event = typeof rawEvent === 'string' ? rawEvent : 'protocol';
    await runtime.handleRuntimeError(connection, {
      error: toValidationFailed(event, error),
      event,
    });
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

      case '__memberSync__':
        runtime.handleMemberSync(connection, frame);
        return;

      case '__streamCancel__': {
        const { streamId } = frame.__livething;
        const cancelling = handleStreamCancel(runtime, connection, frame);
        connection.cancellingStreams ??= new Map();
        connection.cancellingStreams.set(streamId, cancelling);
        try {
          await cancelling;
        } finally {
          if (connection.cancellingStreams.get(streamId) === cancelling) {
            connection.cancellingStreams.delete(streamId);
          }
        }

        return;
      }

      case '__continueStream__':
        await handleContinueStream(runtime, connection, frame);
        return;

      case '__replay__': {
        const handlers = runtime.protocolHandlers.get('__replay__') ?? [];
        const scope = resolveChannel(runtime.compiled, frame.__livething);
        const ctx = runtime.buildConnectionContext(connection, scope);
        for (const handler of handlers) {
          const handled = await handler(ctx, frame);
          if (handled) return;
        }

        // No replay handler owns this scope — replay is off, or off for this
        // channel. Tell the client instead of silently dropping the request.
        await runtime.handleRuntimeError(connection, {
          error: UnsupportedProtocol({ event: '__replay__' }),
          event: '__replay__',
          routing: routingFromLiveThing(frame.__livething),
        });
        return;
      }

      case '__received__':
      case '__read__':
      case '__receivedQuery__':
      case '__readQuery__': {
        const handlers = runtime.protocolHandlers.get(frame.event) ?? [];
        const scope = resolveChannel(runtime.compiled, frame.__livething);
        const ctx = runtime.buildConnectionContext(connection, scope);
        // Acks are fire-and-forget. A handler consuming the frame settles it; an
        // ack for a channel without inbox/receipts is dropped silently — there is
        // no reply the client waits on. A receipt query replies to its own
        // correlationId or, unauthorized, is dropped the same way.
        for (const handler of handlers) {
          if (await handler(ctx, frame)) return;
        }

        return;
      }
    }
  } catch (error) {
    await runtime.handleRuntimeError(connection, {
      error,
      event: frame.event,
      routing: routingFromLiveThing(frame.__livething),
    });
  }
}

/** A hook that observes one connection by id and must never break dispatch. */
type ConnectionHook = (connectionId: string) => void | Promise<void>;

/**
 * Run every hook in `hooks` against one connection, in registration order,
 * logging and swallowing whatever a hook throws so one bad observer cannot stop
 * the frame from being handled.
 */
async function runConnectionHooks(
  hooks: readonly ConnectionHook[],
  hookName: string,
  observed: ConnectionHookObservation,
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook(observed.connectionId);
    } catch (error) {
      observed.logger.error(`[livething] ${hookName} hook threw`, {
        connectionId: observed.connectionId,
        error,
      });
    }
  }
}

type PluginConnectionHook = { handler: (ctx: unknown) => void | Promise<void> };

interface ConnectionHookObservation {
  connectionId: string;
  logger: DispatchRuntime['logger'];
}

interface PluginConnectionHookObservation extends ConnectionHookObservation {
  ctx: unknown;
  asyncContext: EngineAsyncContext | undefined;
}

interface StreamNudgeBufferInput {
  runtime: DispatchRuntime;
  connection: RuntimeConnection;
  event: string;
  frame: Protocol.UserEventFrame;
  livething: Protocol.LiveThingProtocol | undefined;
  triggerScope: EngineRuntimeTypes.ResolvedChannel;
}

/**
 * Run each plugin's `onPing` / `onPong` observer against the same scoped ctx it
 * would see in any other lifecycle hook, isolating a throw the same way
 * `runConnectionHooks` does. Building the ctx is skipped when no plugin listens.
 */
async function runPluginConnectionHooks(
  hooks: readonly PluginConnectionHook[],
  hookName: string,
  observed: PluginConnectionHookObservation,
): Promise<void> {
  for (const entry of hooks) {
    try {
      await withConnectionLevelCall(
        observed.asyncContext,
        { connectionId: observed.connectionId, ctx: observed.ctx },
        () => entry.handler(observed.ctx),
      );
    } catch (error) {
      observed.logger.error(`[livething] ${hookName} hook threw`, {
        connectionId: observed.connectionId,
        error,
      });
    }
  }
}

async function bufferNudgeIfNeeded(input: StreamNudgeBufferInput): Promise<boolean> {
  const { runtime, connection, event, frame, livething, triggerScope } = input;
  if (!livething?.streamId) return false;

  const activeStream = runtime.activeStreams.get(livething.streamId);
  if (activeStream && activeStream.connectionId === connection.id && !activeStream.closed) {
    const storedScope = activeStream.scope ?? {};
    const sameScope =
      (storedScope.channelName ?? undefined) === (triggerScope.channelName ?? undefined) &&
      (storedScope.channelFamily ?? null) === (triggerScope.channelFamily ?? null);
    const memberOk =
      !storedScope.channelName ||
      connectionHoldsMembership(
        connection,
        storedScope.channelName,
        storedScope.channelFamily ?? null,
      );
    if (!sameScope || !memberOk) {
      const routing: Protocol.LiveThingRouting = {
        streamId: livething.streamId,
        streamTerminated: false,
      };

      if (livething.streamNudgeId !== undefined) routing.streamNudgeId = livething.streamNudgeId;
      await runtime.handleRuntimeError(connection, {
        error: ChannelNotSubscribed(),
        event,
        routing,
      });
      return true;
    }
  }

  let payload = frame.payload;
  const interceptScope = activeStream?.scope ?? triggerScope;
  const topIntercepts = runtime.compiled.intercepts;
  const channelIntercepts = interceptScope.channel?.intercepts;
  if (runtime.runIntercepts && (topIntercepts.length > 0 || (channelIntercepts?.length ?? 0) > 0)) {
    let sharedCtx: Record<PropertyKey, unknown> | undefined;
    function getCtx(): Record<PropertyKey, unknown> {
      return (sharedCtx ??= runtime.buildConnectionContext(connection, interceptScope));
    }

    try {
      let intercepted: InterceptPrimitive.InterceptFrame = {
        event,
        payload,
        kind: 'nudge',
        routing: buildInterceptRouting(livething),
        owner: frameOwner(event),
      };

      intercepted = await runtime.runIntercepts(runtime, connection, {
        intercepts: topIntercepts,
        frame: intercepted,
        getCtx,
        call: { kind: 'connection', getCtx },
      });
      if (channelIntercepts) {
        intercepted = await runtime.runIntercepts(runtime, connection, {
          intercepts: channelIntercepts,
          frame: intercepted,
          getCtx,
          call: connectionCall(connection.id, interceptScope, getCtx),
        });
      }

      payload = intercepted.payload;
    } catch (error) {
      rethrowIfConfigError(error);
      if (error === Block) return true;

      if (
        error &&
        typeof error === 'object' &&
        (error as { __livething?: string }).__livething === 'disconnect'
      ) {
        connection.descriptor.close(
          (error as { code: number }).code,
          (error as { reason: string }).reason,
        );
        return true;
      }

      const routing: Protocol.LiveThingRouting = {
        streamId: livething.streamId,
        streamTerminated: false,
      };

      if (livething.streamNudgeId !== undefined) routing.streamNudgeId = livething.streamNudgeId;

      await runtime.handleRuntimeError(connection, { error, event, routing });
      return true;
    }
  }

  return !!(await runtime.streamNudgeBuffer?.(runtime, connection, { event, payload, livething }));
}

/**
 * Parse one websocket text frame and route protocol messages or app events.
 *
 * The bare `ping` and `pong` frames are not JSON and never reach a handler.
 * They fan out to their own hooks instead: the engine's built-in ping hook
 * answers with `pong`, and `keepalive()` listens on `pong` to time the
 * round-trip.
 */
export async function processTextMessage(
  runtime: DispatchRuntime & {
    activityHooks: readonly ConnectionHook[];
    messageActivityHooks: readonly ConnectionHook[];
    pingHooks: readonly ConnectionHook[];
    pongHooks: readonly ConnectionHook[];
    pluginPingHooks: readonly PluginConnectionHook[];
    pluginPongHooks: readonly PluginConnectionHook[];
    appPingHooks: readonly ConnectionHook[];
    appPongHooks: readonly ConnectionHook[];
  },
  connection: RuntimeConnection,
  data: string,
): Promise<void> {
  const observed = { connectionId: connection.id, logger: runtime.logger };

  if (runtime.activityHooks.length > 0) {
    await runConnectionHooks(runtime.activityHooks, 'connection activity', observed);
  }

  // Ping and pong observers run in one order: the engine and capabilities first
  // (the engine's reply, `keepalive()`'s measurement), then plugins, then the
  // app — so a plugin or the app always reads a fresh `ctx.latency`.
  if (data === 'ping') {
    await runConnectionHooks(runtime.pingHooks, 'ping', observed);
    if (runtime.pluginPingHooks.length > 0) {
      await runPluginConnectionHooks(runtime.pluginPingHooks, 'ping', {
        ...observed,
        ctx: runtime.buildConnectionContext(connection),
        asyncContext: runtime.asyncContext,
      });
    }

    await runConnectionHooks(runtime.appPingHooks, 'ping', observed);
    return;
  }

  if (data === 'pong') {
    await runConnectionHooks(runtime.pongHooks, 'pong', observed);
    if (runtime.pluginPongHooks.length > 0) {
      await runPluginConnectionHooks(runtime.pluginPongHooks, 'pong', {
        ...observed,
        ctx: runtime.buildConnectionContext(connection),
        asyncContext: runtime.asyncContext,
      });
    }

    await runConnectionHooks(runtime.appPongHooks, 'pong', observed);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    runtime.logger.warn('Invalid JSON message dropped');
    return;
  }

  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string') {
    runtime.logger.warn('Invalid message shape dropped');
    return;
  }

  const event = parsed[0];

  if (runtime.messageActivityHooks.length > 0) {
    await runConnectionHooks(runtime.messageActivityHooks, 'message activity', observed);
  }

  let livething: Protocol.LiveThingProtocol | undefined;
  try {
    // A declined server→client request comes back as an `__error__` frame echoing
    // the request's correlationId. `__error__` is protocol-shaped, so without this
    // it would route to dispatchProtocolFrame — which has no `__error__` case and
    // would reject it as a validation error — and never reach the answer-frame
    // settle hooks, leaving the server's pending ctx.request(...) promise to hang
    // to timeout. Offer a correlated `__error__` to those hooks first; if none own
    // it (no serverRequests() capability, or the request already settled/timed out), drop
    // it rather than emit a spurious protocol-validation error back to the client.
    if (event === '__error__') {
      const declineFrame = Protocol.parseUserEventFrame(parsed);
      const declineLiveThing = declineFrame.__livething;
      if (declineLiveThing?.correlationId !== undefined) {
        const payload = declineFrame.payload;
        for (const hook of runtime.answerFrameHooks) {
          if (hook(connection.id, { event, payload, livething: declineLiveThing })) return;
        }

        return;
      }
    }

    // Protocol frames skip dedup and nudge buffering — a retried one must still
    // reach its handler.
    if (Protocol.isProtocolEventName(event)) {
      await dispatchProtocolFrame(runtime, connection, parsed);
      return;
    }

    let frame: Protocol.UserEventFrame;
    try {
      frame = Protocol.parseUserEventFrame(parsed);
    } catch (error) {
      await runtime.handleRuntimeError(connection, {
        error: toValidationFailed(event, error),
        event,
      });
      return;
    }

    livething = frame.__livething;

    // A user-event frame echoing a `correlationId` may be the client's answer to a
    // server-initiated request. Offer it to the answer-frame hooks (owned by the
    // requests capability) before anything else — they settle the server's pending
    // promise and stop routing so the answer never reaches an `on`/`request`
    // handler or gets dropped by dedup. A correlationId with no matching pending
    // entry falls through to normal routing.
    if (livething?.correlationId !== undefined) {
      for (const hook of runtime.answerFrameHooks) {
        if (hook(connection.id, { event, payload: frame.payload, livething })) return;
      }
    }

    // Dedup here so every frame with a `messageId` shares one idempotency budget.
    if (
      runtime.incomingDedupCap > 0 &&
      isDuplicateIncoming(connection, livething, runtime.incomingDedupCap)
    ) {
      return;
    }

    // A stream trigger frame skips nudge buffering even with a streamId. Walk the
    // target scope so a scoped durable trigger isn't misrouted into the buffer.
    let triggerScope: EngineRuntimeTypes.ResolvedChannel = {};
    let scopeError: unknown;
    try {
      triggerScope = resolveChannel(runtime.compiled, livething);
    } catch (error) {
      scopeError = error;
    }

    // A scoped frame whose channel doesn't match the declared scope must not
    // silently fall through to top-level nudge buffering — that lets a wrong
    // channel deliver into a same-named top-level stream. If the frame carries
    // a streamId and scope resolution failed, surface the resolution error to
    // the client and stop.
    if (scopeError && livething?.streamId) {
      // Preserve the nudge routing so the client can match the rejected nudge
      // Promise; a nudge reject is non-terminal, so the stream stays alive.
      const routing: Protocol.LiveThingRouting = routingFromLiveThing(livething) ?? {
        streamId: livething.streamId,
      };
      if (livething.streamNudgeId !== undefined) routing.streamTerminated = false;
      await runtime.handleRuntimeError(connection, {
        error: scopeError,
        event,
        routing,
      });
      return;
    }

    const triggerScoped = triggerScope.channel;
    const isStreamTrigger = triggerScoped
      ? triggerScoped.streams.has(event) ||
        triggerScoped.cursorStreams.has(event) ||
        triggerScoped.recordedStreams.has(event)
      : runtime.compiled.streams.has(event) ||
        runtime.compiled.cursorStreams.has(event) ||
        runtime.compiled.recordedStreams.has(event);
    if (
      !isStreamTrigger &&
      (await bufferNudgeIfNeeded({ runtime, connection, event, frame, livething, triggerScope }))
    )
      return;

    await dispatchIncoming(runtime, connection, {
      event,
      payload: frame.payload,
      livething,
      // Reuse the scope resolved above; on a resolve failure pass none so
      // dispatchIncoming re-resolves and routes the error.
      scope: scopeError ? undefined : triggerScope,
    });
  } catch (error) {
    await runtime.handleRuntimeError(connection, {
      error,
      event,
      routing: routingFromLiveThing(livething),
    });
  }
}
