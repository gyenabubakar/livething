/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  Block,
  ChannelNotSubscribed,
  rethrowIfConfigError,
  UnsupportedProtocol,
  ValidationFailed,
  WSKitError,
} from '@wskit/core';
import * as EngineCompileUtils from '~/_engine/compile/utils.ts';
import { ENGINE_ACK_ID } from '~/_engine/contexts/types.ts';
import { forEachIsolatedAsync } from '~/_engine/runtime/isolation.ts';
import * as Protocol from '~/_engine/runtime/protocol.ts';
import * as DurableStreamRuntime from '~/_engine/stream-durable/runtime.ts';
import { ensureDurableStreamSchema } from '~/_engine/stream-durable/storage.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as ErrorsPrimitive from '~/errors/errors.ts';
import * as InterceptPrimitive from '~/intercept/runtime.ts';
import * as KeepalivePrimitive from '~/keepalive/runtime.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import * as RequestPrimitive from '~/request/runtime.ts';
import * as StreamPrimitive from '~/stream/runtime.ts';
import * as v from 'valibot';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as DurableStreamStorage from '~/_engine/stream-durable/storage.ts';
import { resolveScope, routingFromWSKit } from './scope.ts';
import type * as EngineRuntimeTypes from './types.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;

/**
 * Upper bound on concurrent pending `Defer` retry timers per connection. Past
 * this, a deferring message is exhausted instead of scheduling another timer,
 * so a flood of distinct deferring messages can't grow timers without limit.
 */
const MAX_PENDING_DEFERS = 128;

export type { WSKitRouting } from './protocol.ts';

export {
  broadcastToChannel,
  broadcastToConnections,
  sendThroughPipeline,
} from '~/outgoing/runtime.ts';

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

  declaredErrorCodes: ReadonlySet<string>;

  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Record<PropertyKey, unknown>;

  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: { event: string; payload: Record<string, unknown>; wskit: Record<string, unknown> },
  ): void;

  sendReplay(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: {
      channelName: string | null;
      channelScope: string | null;
      event: string;
      payload: unknown;
      wire: { seq: number; messageId: string; channel?: string };
    },
  ): void;

  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;

  asyncContext: EngineAsyncContext;

  handleRuntimeError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: { error: unknown; event?: string; routing?: Protocol.WSKitRouting },
  ): Promise<void>;

  handleValidationError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: { event: string; validationError: unknown; scope?: EngineRuntimeTypes.ResolvedScope },
  ): Promise<void>;

  broadcastToConnections(
    connections: readonly EngineRuntimeTypes.RuntimeConnection[],
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
   * Tracks whether `ensureDurableStreamSchema` has already run in this
   * engine instance lifetime. Flipped to `true` on first stream start or
   * resume so subsequent operations skip the redundant DDL check.
   */
  durableStreamSchemaReady: boolean;
}

// ───── Section: wire-error helpers ─────

/**
 * Turn a valibot parse failure into a typed `ValidationFailed` error so a
 * malformed wire frame settles as a `__error__` frame instead of crashing the
 * adapter message handler.
 */
function toValidationFailed(event: string, error: unknown): WSKitError {
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
  wskit: Protocol.WSKitProtocol | undefined,
  cap: number,
): boolean {
  const messageId = wskit?.messageId;
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

// ───── Section: inbound dispatch ─────

/**
 * Build the curated `routing` view of a frame's `__wskit` envelope for the
 * intercept callback. Returns an empty object when no routing markers were
 * sent so callers never have to null-check.
 */
function buildInterceptRouting(
  wskit: Protocol.WSKitProtocol | undefined,
): InterceptPrimitive.InterceptRouting {
  if (!wskit) return {};
  const routing: {
    messageId?: string;
    ackId?: string;
    correlationId?: string;
    streamId?: string;
    channel?: string;
    channelScope?: string | null;
    seq?: number;
  } = {};
  if (wskit.messageId !== undefined) routing.messageId = wskit.messageId;
  if (wskit.ackId !== undefined) routing.ackId = wskit.ackId;
  if (wskit.correlationId !== undefined) routing.correlationId = wskit.correlationId;
  if (wskit.streamId !== undefined) routing.streamId = wskit.streamId;
  if (wskit.channel !== undefined) {
    routing.channel = wskit.channel;
    routing.channelScope = wskit.channelScope ?? null;
  }
  if (wskit.seq !== undefined) routing.seq = wskit.seq;
  return routing;
}

export interface DispatchIncomingOptions {
  event: string;
  payload: unknown;
  wskit: Protocol.WSKitProtocol | undefined;
  attempt?: number;
}

interface HandleDispatchErrorOptions {
  event: string;

  payload: unknown;

  wskit: Protocol.WSKitProtocol | undefined;

  scope: EngineRuntimeTypes.ResolvedScope;

  error: unknown;

  attempt: number;
}

/**
 * Main inbound event dispatcher.
 *
 * Runs plugin hooks, intercepts, validation, incoming handlers, requests, and
 * streams in the order described by the server spec.
 */
export async function dispatchIncoming(
  runtime: DispatchRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  opts: DispatchIncomingOptions,
): Promise<void> {
  const { event, payload, wskit, attempt = 0 } = opts;
  // Dedup runs in `processTextMessage`. Defer retries re-enter here directly
  // and skip dedup — that is the engine replaying its own work, not a resend.

  // Bail if the connection is already closing. A Defer retry is scheduled on a
  // timer; if the socket closed during the delay, re-running the handler would
  // fire side effects (sends, broadcasts, storage writes) for a client that is
  // gone — and the connection is already out of the runtime maps by then.
  if (connection.closing) return;

  let scope: EngineRuntimeTypes.ResolvedScope;
  try {
    scope = resolveScope(runtime.compiled, wskit);
  } catch (error) {
    // Bad routing markers — send the client a typed `__error__` frame.
    await runtime.handleRuntimeError(connection, {
      error,
      event,
      routing: routingFromWSKit(wskit),
    });
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
    await runtime.handleRuntimeError(connection, {
      error: ChannelNotSubscribed(),
      event,
      routing: { channel: scope.channelName, channelScope: scope.channelScope ?? null },
    });
    return;
  }

  // A scoped frame can only reach handlers declared in that scope — never top-level ones.
  const scoped = scope.channel;
  const incoming = scoped ? scoped.incoming.get(event) : runtime.compiled.incoming.get(event);
  const request = scoped ? scoped.requests.get(event) : runtime.compiled.requests.get(event);
  const stream = scoped ? scoped.streams.get(event) : runtime.compiled.streams.get(event);

  const resumableStream = scoped
    ? scoped.resumableStreams.get(event)
    : runtime.compiled.resumableStreams.get(event);

  const recordedStream = scoped
    ? scoped.recordedStreams.get(event)
    : runtime.compiled.recordedStreams.get(event);

  // One context for the whole dispatch — reused across intercepts and the
  // handler. Built on first need.
  let sharedCtx: Record<PropertyKey, unknown> | undefined;
  function getCtx(): Record<PropertyKey, unknown> {
    return (sharedCtx ??= runtime.buildConnectionContext(connection, scope));
  }

  let message = { event, payload };

  try {
    // A hook's return value becomes the new payload only. The event name is locked.
    if (attempt === 0) {
      for (const hook of runtime.incomingHooks) {
        const next = hook(message);
        if (next !== undefined) message = { event: message.event, payload: next };
      }

      for (const pluginRuntime of runtime.pluginRuntimes) {
        if (!pluginRuntime.onIncoming) continue;
        const next = pluginRuntime.onIncoming(message);
        if (next !== undefined) message = { event: message.event, payload: next };
      }
    }

    if (attempt === 0) {
      let interceptKind: 'incoming' | 'request' | 'stream' | 'unknown' = 'unknown';
      if (incoming) interceptKind = 'incoming';
      else if (request) interceptKind = 'request';
      else if (stream || resumableStream || recordedStream) interceptKind = 'stream';
      const interceptRouting = buildInterceptRouting(wskit);
      let frame: InterceptPrimitive.InterceptFrame = {
        event,
        payload: message.payload,
        kind: interceptKind,
        routing: interceptRouting,
      };
      frame = await InterceptPrimitive.runIntercepts(runtime, connection, {
        intercepts: runtime.compiled.intercepts,
        frame,
        getCtx,
      });

      if (scope.channel) {
        frame = await InterceptPrimitive.runIntercepts(runtime, connection, {
          intercepts: scope.channel.intercepts,
          frame,
          getCtx,
        });
      }

      message = { event: frame.event, payload: frame.payload };
    }

    const primitive = incoming ?? request ?? stream ?? resumableStream ?? recordedStream;
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
        routing: routingFromWSKit(wskit),
      });
      return;
    }

    if (incoming) {
      await InterceptPrimitive.runWithScopedContext(runtime, connection, {
        ctx: getCtx(),
        handler: (ctx) => {
          // The ack id rides on this dispatch's own ctx so `ctx.ack()` confirms
          // this message, never a later one that interleaved on the connection.
          (ctx as Record<PropertyKey, unknown>)[ENGINE_ACK_ID] = wskit?.ackId;
          return incoming.handler(ctx, payloadValue);
        },
      });
      return;
    }

    if (request) {
      await RequestPrimitive.handleRequest(
        {
          asyncContext: runtime.asyncContext,
          logger: runtime.logger,
          sendThroughPipeline: (nextConnection, nextOpts) => {
            return OutgoingRuntime.sendThroughPipeline(runtime, nextConnection, nextOpts);
          },
        },
        { connection, ctx: getCtx(), scope, event, request, payload: payloadValue, wskit },
      );
      return;
    }

    if (stream) {
      await StreamPrimitive.runStream(runtime, connection, {
        scope,
        event,
        stream,
        payload: payloadValue,
        wskit,
      });
    } else if (resumableStream || recordedStream) {
      const durable = resumableStream ?? recordedStream!;
      if (!runtime.sql) {
        throw new Error(
          '[wskit] durable stream "' +
            durable.event +
            '" requires storage; the adapter did not provide storage.',
        );
      }
      if (!runtime.durableStreamSchemaReady) {
        ensureDurableStreamSchema(runtime.sql);
        runtime.durableStreamSchemaReady = true;
      }
      await DurableStreamRuntime.runDurableStream(
        runtime as unknown as DurableStreamRuntime.DurableStreamRuntime,
        connection,
        {
          scope,
          def: {
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
          payload: payloadValue,
          wskit,
        },
      );
    }
  } catch (error) {
    await handleDispatchError(runtime, connection, {
      event,
      payload: message.payload,
      wskit,
      scope,
      error,
      attempt,
    });
  }
}

async function handleDispatchError(
  runtime: DispatchRuntime,
  connection: RuntimeConnection,
  opts: HandleDispatchErrorOptions,
): Promise<void> {
  const { event, payload, wskit, scope, error, attempt } = opts;
  rethrowIfConfigError(error);
  if (error === Block) return;

  if (error instanceof WSKitError && error.code === 'validation-failed') {
    // Pass `scope` so onValidationError hooks get the right channel ctx.
    await runtime.handleValidationError(connection, { event, validationError: error, scope });
    await runtime.handleRuntimeError(connection, {
      error,
      event,
      routing: routingFromWSKit(wskit),
    });
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

  // Defer — re-queue the message after a delay. Give up and fire
  // DeferExhausted after 3 retries, or when this connection already has
  // MAX_PENDING_DEFERS timers in flight.
  if (error && typeof error === 'object' && (error as { __wskit?: string }).__wskit === 'defer') {
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
        (hook) => hook(runtime.buildConnectionContext(connection), exhausted, event),
        { context: `onError hook (DeferExhausted) event="${event}"` },
      );
      return;
    }

    const delay = Number((error as { delay: number }).delay);
    const timers = (connection.deferTimers ??= new Set());
    const timer = setTimeout(() => {
      timers.delete(timer);
      void dispatchIncoming(runtime, connection, { event, payload, wskit, attempt: attempt + 1 });
    }, delay);
    timers.add(timer);
    return;
  }

  // Keep routing markers (`correlationId`) so a thrown request error settles
  // on the client instead of hanging until timeout.
  await runtime.handleRuntimeError(connection, { error, event, routing: routingFromWSKit(wskit) });
}

// Find the compiled durable-stream def for a stored row, in the scope the row
// was started in. Returns undefined if the def or scope is gone, or the
// resuming connection is not a member of the stream's channel.
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
    // No storage means durable streams aren't supported at all. Say so, rather
    // than implying this particular stream merely expired or went missing.
    // streamId stays on the envelope so the client correlates the error to the
    // stream it tried to resume and surfaces it to that consumer.
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: UnsupportedProtocol.code, detail: { event: '__resumeStream__' } },
      wskit: { streamId },
    });
    return;
  }
  if (!runtime.durableStreamSchemaReady) {
    ensureDurableStreamSchema(runtime.sql);
    runtime.durableStreamSchemaReady = true;
  }

  // Routing markers let a non-creator resume a broadcast stream by its scope key.
  // Malformed markers used to fall back to a top-level lookup, which then
  // matched and resumed an unrelated top-level stream with the same id.
  // Surface the routing failure as a typed __error__ tied to the streamId
  // instead — the client gets a clear signal and no other stream is touched.
  let resumeScope: EngineRuntimeTypes.ResolvedScope;
  try {
    resumeScope = resolveScope(runtime.compiled, frame.__wskit);
  } catch (error) {
    await runtime.handleRuntimeError(connection, {
      error,
      event: frame.event,
      routing: routingFromWSKit(frame.__wskit),
    });
    return;
  }
  const durableRuntime = runtime as unknown as DurableStreamRuntime.DurableStreamRuntime;
  const row = DurableStreamRuntime.findResumeRow(durableRuntime, connection, {
    resumeScope,
    streamId,
  });
  await DurableStreamRuntime.resumeDurableStream(durableRuntime, connection, {
    resolveDef: (matched) => resolveDurableDefForRow(runtime, connection, matched),
    row,
    streamId,
    lastKnownSeq,
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
  parsed: object,
): Promise<void> {
  let frame: Protocol.IncomingProtocolFrame;
  try {
    frame = v.parse(Protocol.IncomingProtocolFrame, parsed);
  } catch (error) {
    const rawEvent = (parsed as { event?: unknown }).event;
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
        await StreamPrimitive.cancelStream(runtime, connection, frame.__wskit.streamId);
        if (runtime.sql) {
          // A broadcast stream's row is keyed by scope, so we need the cancel
          // frame's routing markers to find it. A malformed scope marker (e.g.
          // a channel name that does not match its declared family pattern)
          // used to fall back to a top-level lookup, which then matched and
          // cancelled the caller's unrelated top-level stream with the same
          // id. Surface the routing failure as a typed __error__ tied to the
          // streamId instead — the client gets a clear signal and no other
          // stream is touched.
          let cancelScope: EngineRuntimeTypes.ResolvedScope;
          try {
            cancelScope = resolveScope(runtime.compiled, frame.__wskit);
          } catch (error) {
            await runtime.handleRuntimeError(connection, {
              error,
              event: frame.event,
              routing: routingFromWSKit(frame.__wskit),
            });
            return;
          }
          await DurableStreamRuntime.cancelDurableStream(
            runtime as unknown as DurableStreamRuntime.DurableStreamRuntime,
            connection,
            { streamId: frame.__wskit.streamId, cancelScope },
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
        // No replay handler owns this scope — replay is off, or off for this
        // channel. Tell the client instead of silently dropping the request.
        await runtime.handleRuntimeError(connection, {
          error: UnsupportedProtocol({ event: '__replay__' }),
          event: '__replay__',
          routing: routingFromWSKit(frame.__wskit),
        });
        return;
      }
    }
  } catch (error) {
    await runtime.handleRuntimeError(connection, {
      error,
      event: frame.event,
      routing: routingFromWSKit(frame.__wskit),
    });
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
    try {
      await hook(connection.id);
    } catch (error) {
      runtime.logger.error('[wskit] connection activity hook threw', {
        connectionId: connection.id,
        error,
      });
    }
  }

  if (data === 'ping') {
    connection.descriptor.send('pong');
    return;
  }

  if (data === 'pong') {
    KeepalivePrimitive.recordConnectionLatency(connection);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    runtime.logger.warn('Invalid JSON message dropped');
    return;
  }

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

  // Protocol frames skip dedup and nudge buffering — a retried one must still
  // reach its handler.
  if (Protocol.isProtocolEventName(event)) {
    await dispatchProtocolFrame(runtime, connection, parsed);
    return;
  }

  // User-event frame: app event with an optional `__wskit` block.
  let frame: Protocol.UserEventFrame;
  try {
    frame = v.parse(Protocol.UserEventFrameSchema, parsed);
  } catch (error) {
    await runtime.handleRuntimeError(connection, {
      error: toValidationFailed(event, error),
      event,
    });
    return;
  }
  const wskit = frame.__wskit;

  // Dedup here so every frame with a `messageId` shares one idempotency budget.
  if (
    runtime.incomingDedupCap > 0 &&
    isDuplicateIncoming(connection, wskit, runtime.incomingDedupCap)
  ) {
    return;
  }

  // A stream trigger frame skips nudge buffering even with a streamId. Walk the
  // target scope so a scoped durable trigger isn't misrouted into the buffer.
  let triggerScope: EngineRuntimeTypes.ResolvedScope = {};
  let scopeError: unknown;
  try {
    triggerScope = resolveScope(runtime.compiled, wskit);
  } catch (error) {
    scopeError = error;
  }
  // A scoped frame whose channel doesn't match the declared scope must not
  // silently fall through to top-level nudge buffering — that lets a wrong
  // channel deliver into a same-named top-level stream. If the frame carries
  // a streamId and scope resolution failed, surface the resolution error to
  // the client and stop.
  if (scopeError && wskit?.streamId) {
    await runtime.handleRuntimeError(connection, {
      error: scopeError,
      event,
      routing: { streamId: wskit.streamId },
    });
    return;
  }
  const triggerScoped = triggerScope.channel;
  const isStreamTrigger = triggerScoped
    ? triggerScoped.streams.has(event) ||
      triggerScoped.resumableStreams.has(event) ||
      triggerScoped.recordedStreams.has(event)
    : runtime.compiled.streams.has(event) ||
      runtime.compiled.resumableStreams.has(event) ||
      runtime.compiled.recordedStreams.has(event);
  if (!isStreamTrigger) {
    let nudgePayload = frame.payload;

    if (wskit?.streamId) {
      const topIntercepts = runtime.compiled.intercepts;
      const chIntercepts = triggerScope.channel?.intercepts;

      if (topIntercepts.length > 0 || (chIntercepts?.length ?? 0) > 0) {
        let sharedCtx: Record<PropertyKey, unknown> | undefined;
        function getCtx() {
          return (sharedCtx ??= runtime.buildConnectionContext(connection, triggerScope));
        }

        try {
          let nudgeFrame: InterceptPrimitive.InterceptFrame = {
            event,
            payload: frame.payload,
            kind: 'nudge',
            routing: buildInterceptRouting(wskit),
          };
          nudgeFrame = await InterceptPrimitive.runIntercepts(runtime, connection, {
            intercepts: topIntercepts,
            frame: nudgeFrame,
            getCtx,
          });
          if (chIntercepts) {
            nudgeFrame = await InterceptPrimitive.runIntercepts(runtime, connection, {
              intercepts: chIntercepts,
              frame: nudgeFrame,
              getCtx,
            });
          }
          nudgePayload = nudgeFrame.payload;
        } catch (error) {
          rethrowIfConfigError(error);
          if (error === Block) return;
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
          // A thrown nudge intercept is non-terminal: tag the error with
          // streamTerminated:false and the streamNudgeId so the client's nudge()
          // Promise rejects while the stream stays live and keeps emitting chunks.
          const rejectRouting: Protocol.WSKitRouting = {
            streamId: wskit.streamId,
            streamTerminated: false,
          };
          if (wskit.streamNudgeId !== undefined) rejectRouting.streamNudgeId = wskit.streamNudgeId;
          await runtime.handleRuntimeError(connection, {
            error,
            event,
            routing: rejectRouting,
          });
          return;
        }
      }
    }

    const buffered = await StreamPrimitive.bufferStreamNudge(runtime, connection, {
      event,
      payload: nudgePayload,
      wskit,
    });
    if (buffered) return;
  }

  await dispatchIncoming(runtime, connection, { event, payload: frame.payload, wskit });
}
