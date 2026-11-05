/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  Block,
  ChannelNotSubscribed,
  rethrowIfConfigError,
  UnsupportedProtocol,
  utf8ByteLength,
  ValidationFailed,
  WrongFrameKind,
} from '@livething/core';
import {
  connectionCall,
  withConnectionCall,
  withConnectionLevelCall,
} from '~/_engine/async-context.ts';
import * as EngineCompileUtils from '~/_engine/compile/utils.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import { runIntercepts } from '~/intercept/runtime.ts';
import { frameOwner } from '~/plugin-scope.ts';
import * as v from 'valibot';
import type { LiveThingError } from '@livething/core';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as FeatureSlots from '~/_engine/runtime/feature-slots.ts';
import type * as InterceptPrimitive from '~/intercept/intercept.ts';
import type * as OutgoingRuntime from '~/outgoing/runtime.ts';
import { resolveChannel, routingFromLiveThing } from './scope.ts';
import {
  abandonSubscribes,
  beginSubscribe,
  finishSubscribe,
  subscribeKey,
} from './subscribe-order.ts';
import { connectionBusy, MAX_PENDING_CONNECTION_WORK, runConnectionWork } from './work-queue.ts';
import type { SubscribeAttempt, SubscribeGate } from './subscribe-order.ts';
import type * as EngineRuntimeTypes from './types.ts';

type MessageParameter = { event: string; payload: unknown };
type FrameParameter = {
  event: string;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
  /** The frame's bytes when it came as a binary frame, else `undefined`. */
  bytes?: Uint8Array;
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

  /** Whether a request the server sent to a connection waits for a correlation id. */
  answerAwaitedHooks?: readonly ((connectionId: string, correlationId: string) => boolean)[];

  /**
   * Size of the per-connection seen-id ring used by incoming dedup. Zero means
   * incoming dedup is disabled (no `dedup()` primitive registered).
   */
  incomingDedupCap: number;

  /**
   * Most bytes of frames one connection may hold between their arrival and the start of
   * their handler: twice the adapter's receive limit.
   */
  maxPendingBytes: number;

  /**
   * The default `maxBytes` of a binary handler: what always fits in the receive limit with
   * the header and a 64 KiB envelope. Absent when the limit is too small for that.
   */
  defaultBinaryMaxBytes?: number;

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

  return ValidationFailed({ event, issues: [{ message: 'The frame is malformed.' }] });
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
  // The already-resolved scope from processTextMessage, so a channel frame isn't
  // resolved twice.
  scope?: EngineRuntimeTypes.ResolvedChannel;
  /** The frame already paid its rate limit on arrival, while it waited behind a subscribe. */
  charged?: boolean;
  /** The frame's size as it arrived, in bytes. `processTextMessage` always passes it. */
  size?: number;
  /** Called when the handler starts, to give the frame's bytes back to the connection. */
  onHandlerStart?: () => void;
  /** The application's bytes when the frame came as a binary frame, else `undefined`. */
  bytes?: Uint8Array;
}

/** Throw `ValidationFailed` when a binary frame's bytes are over its handler's `maxBytes`. */
function assertBytesFit(event: string, bytes: Uint8Array, maxBytes: number | undefined): void {
  if (maxBytes === undefined || bytes.byteLength <= maxBytes) return;

  throw ValidationFailed({
    event,
    issues: [
      { message: `The bytes are ${bytes.byteLength} bytes, over the limit of ${maxBytes} bytes.` },
    ],
  });
}

/** The `wrong-frame-kind` error for a frame that came as the other kind. */
function wrongFrameKind(event: string, bytes: Uint8Array | undefined): LiveThingError {
  return WrongFrameKind({ event, expected: bytes === undefined ? 'binary' : 'text' });
}

/** The intercepts a frame still has to pass, given what it already paid on arrival. */
function interceptsToRun(
  intercepts: readonly InterceptPrimitive.InterceptPrimitive[],
  charged: boolean | undefined,
): readonly InterceptPrimitive.InterceptPrimitive[] {
  return charged ? intercepts.filter((intercept) => !intercept.__chargedOnArrival) : intercepts;
}

interface HandleDispatchErrorOptions {
  event: string;

  livething: Protocol.LiveThingProtocol | undefined;

  error: unknown;
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
  const { event, payload, livething, size = 0, onHandlerStart, bytes } = opts;
  // A closing connection is already out of the runtime maps, so running its
  // handler would fire side effects for a client that is gone.
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

  const recordedStream = scoped
    ? scoped.recordedStreams.get(event)
    : runtime.compiled.recordedStreams.get(event);

  const primitive = incoming ?? request ?? stream ?? recordedStream;
  if (
    primitive &&
    ((primitive as { binary?: boolean }).binary === true) !== (bytes !== undefined)
  ) {
    await runtime.handleRuntimeError(connection, {
      error: wrongFrameKind(event, bytes),
      event,
      routing: routingFromLiveThing(livething),
    });
    return;
  }

  let sharedCtx: Record<PropertyKey, unknown> | undefined;
  function getCtx(): Record<PropertyKey, unknown> {
    return (sharedCtx ??= runtime.buildConnectionContext(connection, scope));
  }

  let message = { event, payload };

  try {
    for (const hook of runtime.incomingHooks) {
      const next = hook(message);
      if (next !== undefined) message = { event: message.event, payload: next };
    }

    const channelIntercepts = scope.channel?.intercepts;
    if (runtime.compiled.intercepts.length > 0 || (channelIntercepts?.length ?? 0) > 0) {
      let interceptKind: 'incoming' | 'request' | 'stream' | 'unknown' = 'unknown';
      if (incoming) interceptKind = 'incoming';
      else if (request) interceptKind = 'request';
      else if (stream || recordedStream) interceptKind = 'stream';
      const interceptRouting = buildInterceptRouting(livething);
      let frame: InterceptPrimitive.InterceptFrame = {
        event,
        payload: message.payload,
        kind: interceptKind,
        routing: interceptRouting,
        owner: frameOwner(event),
        size,
        ...(bytes === undefined ? {} : { bytes }),
      };

      frame = await runIntercepts(runtime, connection, {
        intercepts: interceptsToRun(runtime.compiled.intercepts, opts.charged),
        frame,
        getCtx,
        call: { kind: 'connection', getCtx },
      });

      if (channelIntercepts) {
        frame = await runIntercepts(runtime, connection, {
          intercepts: channelIntercepts,
          frame,
          getCtx,
          call: connectionCall(connection.id, scope, getCtx),
        });
      }

      message = { event: frame.event, payload: frame.payload };
    }

    if (!primitive) return;

    let payloadValue: unknown;
    try {
      payloadValue = EngineCompileUtils.validateValue(
        'stream' in primitive ? primitive.stream.validator : primitive.validator,
        message.payload,
        event,
      );
      if (bytes !== undefined) {
        assertBytesFit(
          event,
          bytes,
          (primitive as { maxBytes?: number }).maxBytes ?? runtime.defaultBinaryMaxBytes,
        );
      }
    } catch (error) {
      rethrowIfConfigError(error);
      // Route the validation error fully here and stop. Rethrowing would make
      // the outer catch fire the user hooks a second time. Keep routing markers (`correlationId`) so a bad-payload request settles
      // on the client instead of hanging until timeout.
      await runtime.handleRuntimeError(connection, {
        error,
        event,
        routing: routingFromLiveThing(livething),
      });
      return;
    }

    if (incoming) {
      await runConnectionWork(connection, incoming.allowInterleaving ?? false, () => {
        onHandlerStart?.();
        if (connection.closing) return;

        return withConnectionCall(
          runtime.asyncContext,
          connectionCall(connection.id, scope, getCtx),
          () => incoming.handler(getCtx(), payloadValue, bytes),
        );
      });
      return;
    }

    if (request) {
      await runConnectionWork(connection, request.allowInterleaving ?? true, () => {
        onHandlerStart?.();
        if (connection.closing) return;

        return runtime.requestDispatch?.(runtime, connection, {
          connection,
          ctx: getCtx(),
          scope,
          event,
          request,
          payload: payloadValue,
          livething,
          bytes,
        });
      });
      return;
    }

    onHandlerStart?.();
    if (stream) {
      await runtime.streamTrigger?.(runtime, connection, {
        scope,
        event,
        stream,
        payload: payloadValue,
        livething,
        bytes,
      });
    } else if (recordedStream) {
      await runtime.durableStream?.trigger(runtime, connection, {
        scope,
        durable: recordedStream,
        payload: payloadValue,
        livething,
      });
    }
  } catch (error) {
    await handleDispatchError(runtime, connection, { event, livething, error });
  }
}

async function handleDispatchError(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  opts: HandleDispatchErrorOptions,
): Promise<void> {
  const { event, livething, error } = opts;
  rethrowIfConfigError(error);
  if (error === Block) return;

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
    frame = Protocol.parseIncomingProtocolFrame(parsed);
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
  charged: boolean;
  size: number;
  bytes?: Uint8Array;
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
  const { runtime, connection, event, frame, livething, triggerScope, charged, size, bytes } =
    input;
  if (!livething?.streamId) return false;

  const activeStream = runtime.activeStreams.get(livething.streamId);
  const ownStream =
    activeStream && activeStream.connectionId === connection.id && !activeStream.closed;
  if (ownStream) {
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

  // A nudge must be text, and no intercept sees a binary one. A non-member gets
  // channel-not-subscribed first, as for any channel frame.
  if (bytes !== undefined) {
    const nonMember =
      !ownStream &&
      !!triggerScope.channelName &&
      !connectionHoldsMembership(
        connection,
        triggerScope.channelName,
        triggerScope.channelFamily ?? null,
      );
    await runtime.handleRuntimeError(connection, {
      error: nonMember ? ChannelNotSubscribed() : wrongFrameKind(event, bytes),
      event,
      routing: { ...routingFromLiveThing(livething), streamTerminated: false },
    });
    return true;
  }

  let payload = frame.payload;
  const interceptScope = activeStream?.scope ?? triggerScope;
  const topIntercepts = interceptsToRun(runtime.compiled.intercepts, charged);
  const channelIntercepts = interceptScope.channel?.intercepts;
  let sharedCtx: Record<PropertyKey, unknown> | undefined;

  function getCtx(): Record<PropertyKey, unknown> {
    return (sharedCtx ??= runtime.buildConnectionContext(connection, interceptScope));
  }

  if (topIntercepts.length > 0 || (channelIntercepts?.length ?? 0) > 0) {
    try {
      let intercepted: InterceptPrimitive.InterceptFrame = {
        event,
        payload,
        kind: 'nudge',
        routing: buildInterceptRouting(livething),
        owner: frameOwner(event),
        size,
      };

      intercepted = await runIntercepts(runtime, connection, {
        intercepts: topIntercepts,
        frame: intercepted,
        getCtx,
        call: { kind: 'connection', getCtx },
      });
      if (channelIntercepts) {
        intercepted = await runIntercepts(runtime, connection, {
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
  runtime: FrameRuntime,
  connection: RuntimeConnection,
  data: string,
): Promise<void> {
  const parsed = data === 'ping' || data === 'pong' ? undefined : parseFrame(data);
  await processFrame(runtime, connection, {
    data,
    parsed,
    size: utf8ByteLength(data),
    ...(parsed === INVALID_FRAME ? { invalid: 'Invalid JSON message dropped' } : {}),
  });
}

/** The runtime bag that the text and the binary receive paths share. */
export type FrameRuntime = DispatchRuntime & {
  activityHooks: readonly ConnectionHook[];
  messageActivityHooks: readonly ConnectionHook[];
  pingHooks: readonly ConnectionHook[];
  pongHooks: readonly ConnectionHook[];
  pluginPingHooks: readonly PluginConnectionHook[];
  pluginPongHooks: readonly PluginConnectionHook[];
  appPingHooks: readonly ConnectionHook[];
  appPongHooks: readonly ConnectionHook[];
};

/** One received frame, after the first parse. A binary frame's envelope is parsed like text. */
export interface ReceivedFrame {
  /** The text of a text frame. Absent for a binary frame. */
  data?: string;
  /** The parsed JSON of the frame (or of a binary frame's envelope). */
  parsed: unknown;
  /** The size of the whole frame as it arrived, in bytes. */
  size: number;
  /** The application's bytes of a binary frame. Absent for a text frame. */
  bytes?: Uint8Array;
  /** Set when the frame could not be parsed: the reason that is logged before it is dropped. */
  invalid?: string;
}

/**
 * Route one received frame, text or binary, through the same steps in the same order.
 * Everything up to `placeFrame` runs with no `await`, so frames keep the order they came in.
 */
export async function processFrame(
  runtime: FrameRuntime,
  connection: RuntimeConnection,
  received: ReceivedFrame,
): Promise<void> {
  const { parsed, size, bytes } = received;
  // The frame's bytes count against the connection from now until its handler starts.
  function answersWaitingRequest(correlationId: string): boolean {
    return (runtime.answerAwaitedHooks ?? []).some((awaits) =>
      awaits(connection.id, correlationId),
    );
  }

  const counted = waitsInLine(parsed, bytes !== undefined, answersWaitingRequest) ? size : 0;
  const held = connection.pendingBytes ?? 0;
  if (counted > 0 && held + counted > runtime.maxPendingBytes) {
    await refuseBusy(runtime, connection, parsed);
    return;
  }

  connection.pendingBytes = held + counted;
  let released = false;
  function release(): void {
    if (released) return;

    released = true;
    connection.pendingBytes! -= counted;
  }

  let place: FramePlace = {};
  try {
    // Before the first await, so frames take their place in the order they arrived
    // even when hooks below make this frame wait.
    place = placeFrame(connection, parsed, bytes !== undefined);
    await processParsedMessage(runtime, connection, { ...received, place, release });
  } finally {
    release();
    if (place.attempt) finishSubscribe(connection, place.attempt);
  }
}

/**
 * Whether a frame can wait for its handler, so its bytes count against the connection's
 * budget: an app event, or a `__subscribe__` (which waits for `check`). A ping, a pong, the
 * other protocol frames and an answer to a server request never wait in line, so a full
 * budget must not stop a client from leaving a channel, cancelling a stream or answering.
 */
function waitsInLine(
  parsed: unknown,
  binary: boolean,
  answersWaitingRequest: (correlationId: string) => boolean,
): boolean {
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return false;

  // A binary frame with a framework event name is refused at once, so it never waits.
  if (Protocol.isProtocolEventName(parsed[0])) return !binary && parsed[0] === '__subscribe__';

  // Only a real answer skips the budget. A frame that only says it answers can still
  // reach a handler and wait for it.
  const exchange = (parsed[2] as { exchange?: { id?: unknown; source?: unknown } } | null)
    ?.exchange;
  return !(
    exchange?.source === 'server' &&
    typeof exchange.id === 'string' &&
    answersWaitingRequest(exchange.id)
  );
}

/** Answer a frame that would take the connection over its byte budget with `ConnectionBusy`. */
async function refuseBusy(
  runtime: Pick<DispatchRuntime, 'handleRuntimeError'>,
  connection: RuntimeConnection,
  parsed: unknown,
): Promise<void> {
  const event = Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined;
  let livething: Protocol.LiveThingProtocol | undefined;
  try {
    livething = Protocol.parseUserEventFrame(parsed).__livething;
  } catch {
    livething = undefined;
  }

  await runtime.handleRuntimeError(connection, {
    error: connectionBusy(),
    event,
    routing: refusalRouting(livething),
  });
}

const INVALID_FRAME = Symbol('invalid-frame');

/** A frame's place in its channel's order. */
interface FramePlace {
  /** Set when the frame is a `__subscribe__`. */
  attempt?: SubscribeAttempt;
  /** The subscribes that were running when the frame arrived. It runs after them. */
  gate?: SubscribeGate;
}

/** One received frame with its place in its channel's order. */
interface IncomingFrame extends ReceivedFrame {
  place: FramePlace;
  /** Gives the frame's bytes back to the connection's budget, once its handler starts. */
  release: () => void;
}

function parseFrame(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return INVALID_FRAME;
  }
}

/** The channel a frame's metadata names, as a key, or `undefined`. */
function frameChannelKey(parsed: unknown): string | undefined {
  if (!Array.isArray(parsed)) return undefined;

  const channel = (parsed[2] as { channel?: { name?: unknown; family?: unknown } } | null)?.channel;
  if (typeof channel?.name !== 'string') return undefined;

  return subscribeKey(channel.name, typeof channel.family === 'string' ? channel.family : null);
}

/**
 * Give a frame its place among its channel's subscribes, since a subscribe can
 * be slow (an async `check`). The last request wins: a `__subscribe__` replaces
 * an earlier one still in `check`, and an `__unsubscribe__` cancels it. Any other
 * frame runs after the subscribes running now, in the order the client sent it.
 */
function placeFrame(connection: RuntimeConnection, parsed: unknown, binary: boolean): FramePlace {
  const key = frameChannelKey(parsed);
  if (key === undefined) return {};

  // A binary `__subscribe__` or `__unsubscribe__` is refused, so it must not touch a subscribe.
  const event = binary ? undefined : (parsed as unknown[])[0];
  if (event === '__subscribe__') return { attempt: beginSubscribe(connection, key, 'client') };

  if (event === '__unsubscribe__') abandonSubscribes(connection, key);

  return { gate: connection.pendingSubscribes?.get(key) };
}

function isHeld(gate: SubscribeGate | undefined): gate is SubscribeGate {
  return gate !== undefined && gate.attempts.size > 0;
}

interface HeldFrame {
  gate: SubscribeGate | undefined;
  event: string;
  routing: Protocol.LiveThingRouting | undefined;
}

/**
 * Wait until the frame's turn comes. The wait is limited per connection, so a
 * `check` that never settles can't make the frames behind it fill the memory.
 * Returns whether to go on with the frame.
 */
async function waitForTurn(
  runtime: Pick<DispatchRuntime, 'handleRuntimeError'>,
  connection: RuntimeConnection,
  held: HeldFrame,
): Promise<boolean> {
  const { gate, event, routing } = held;
  if (!isHeld(gate)) return true;

  const heldFrames = connection.heldFrames ?? 0;
  if (heldFrames >= MAX_PENDING_CONNECTION_WORK) {
    await runtime.handleRuntimeError(connection, { error: connectionBusy(), event, routing });
    return false;
  }

  connection.heldFrames = heldFrames + 1;
  await gate.opened;
  connection.heldFrames -= 1;

  return !connection.closing;
}

/** The routing of a frame refused before dispatch. A refused nudge doesn't end its stream. */
function refusalRouting(
  livething: Protocol.LiveThingProtocol | undefined,
): Protocol.LiveThingRouting | undefined {
  const routing = routingFromLiveThing(livething);
  if (routing && livething?.streamNudgeId !== undefined) routing.streamTerminated = false;

  return routing;
}

/** The routing of a protocol frame not parsed yet, or none when its metadata is malformed. */
function rawFrameRouting(parsed: unknown): Protocol.LiveThingRouting | undefined {
  try {
    return routingFromLiveThing(Protocol.parseUserEventFrame(parsed).__livething);
  } catch {
    return undefined;
  }
}

interface ArrivalCharge {
  event: string;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
  scope: EngineRuntimeTypes.ResolvedChannel;
  size: number;
  bytes?: Uint8Array;
}

/**
 * Charge the rate limit of a frame about to wait behind a subscribe, so a flood
 * is refused when it arrives, not after the subscribe ends. Returns whether the
 * frame may go on.
 */
async function chargeOnArrival(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  charge: ArrivalCharge,
): Promise<boolean> {
  const { event, payload, livething, scope, size, bytes } = charge;
  try {
    await runIntercepts(runtime, connection, {
      intercepts: runtime.compiled.intercepts.filter((intercept) => intercept.__chargedOnArrival),
      frame: {
        event,
        payload,
        kind: 'unknown',
        routing: buildInterceptRouting(livething),
        owner: frameOwner(event),
        size,
        ...(bytes === undefined ? {} : { bytes }),
      },
      getCtx: () => runtime.buildConnectionContext(connection, scope),
    });
    return true;
  } catch (error) {
    await runtime.handleRuntimeError(connection, {
      error,
      event,
      routing: refusalRouting(livething),
    });
    return false;
  }
}

async function processParsedMessage(
  runtime: FrameRuntime,
  connection: RuntimeConnection,
  message: IncomingFrame,
): Promise<void> {
  const { data, parsed, place, size, release, bytes } = message;
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

  if (message.invalid !== undefined) {
    runtime.logger.warn(message.invalid);
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
        // A binary `__error__` is not a decline: a waiting request takes it as a wrong-kind answer.
        for (const hook of runtime.answerFrameHooks) {
          if (hook(connection.id, { event, payload, livething: declineLiveThing, bytes })) return;
        }

        if (bytes === undefined) return;
      }
    }

    // A framework event must be text: a binary one stops here.
    if (bytes !== undefined && Protocol.isProtocolEventName(event)) {
      await runtime.handleRuntimeError(connection, {
        error: wrongFrameKind(event, bytes),
        event,
        routing: rawFrameRouting(parsed),
      });
      return;
    }

    // Protocol frames skip dedup and nudge buffering — a retried one must still
    // reach its handler.
    if (Protocol.isProtocolEventName(event)) {
      if (place.attempt?.abandoned) return;

      const routing = isHeld(place.gate) ? rawFrameRouting(parsed) : undefined;
      // A subscribe has no turn to wait for, and starts here with no await.
      const turn = { gate: place.gate, event, routing };
      if (place.attempt || (await waitForTurn(runtime, connection, turn))) {
        await dispatchProtocolFrame(runtime, connection, parsed);
      }

      return;
    }

    let frame: Protocol.UserEventFrame;
    try {
      frame = Protocol.parseUserEventFrame(parsed);
    } catch (error) {
      if (await waitForTurn(runtime, connection, { gate: place.gate, event, routing: undefined })) {
        await runtime.handleRuntimeError(connection, {
          error: toValidationFailed(event, error),
          event,
        });
      }

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
        if (hook(connection.id, { event, payload: frame.payload, livething, bytes })) return;
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

    // After the answer hooks: the onSubscribe hook may be the one waiting for an answer.
    const charged = isHeld(place.gate) && !scopeError;
    if (
      charged &&
      !(await chargeOnArrival(runtime, connection, {
        event,
        payload: frame.payload,
        livething,
        scope: triggerScope,
        size,
        bytes,
      }))
    ) {
      return;
    }

    const turn = { gate: place.gate, event, routing: refusalRouting(livething) };
    if (!(await waitForTurn(runtime, connection, turn))) return;

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
      ? triggerScoped.streams.has(event) || triggerScoped.recordedStreams.has(event)
      : runtime.compiled.streams.has(event) || runtime.compiled.recordedStreams.has(event);
    if (
      !isStreamTrigger &&
      (await bufferNudgeIfNeeded({
        runtime,
        connection,
        event,
        frame,
        livething,
        triggerScope,
        charged,
        size,
        bytes,
      }))
    )
      return;

    await dispatchIncoming(runtime, connection, {
      event,
      payload: frame.payload,
      livething,
      // Reuse the scope resolved above; on a resolve failure pass none so
      // dispatchIncoming re-resolves and routes the error.
      scope: scopeError ? undefined : triggerScope,
      charged,
      size,
      onHandlerStart: release,
      bytes,
    });
  } catch (error) {
    await runtime.handleRuntimeError(connection, {
      error,
      event,
      routing: routingFromLiveThing(livething),
    });
  }
}
