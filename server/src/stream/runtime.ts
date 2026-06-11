/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  InternalError,
  NudgeOverflow,
  rethrowIfConfigError,
  StreamIdCollision,
  ValidationFailed,
} from '@wskit/core';
import { withConnectionContext } from '~/_engine/async-context.ts';
import { validateValue } from '~/_engine/compile/utils.ts';
import { forEachIsolatedAsync } from '~/_engine/runtime/isolation.ts';
import {
  assertNoConcurrentStream,
  buildActiveStream,
  installCtxNudges,
} from '~/_engine/stream-common/active-stream.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { normalizeRuntimeError } from '~/errors/runtime.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type { AnyGenerate } from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ActiveStream, ResolvedScope, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Logger } from '~/context.ts';

/**
 * The small runtime surface stream helpers need from the engine.
 *
 * The engine still owns generic message routing and the active-stream map.
 * This helper owns the stream-specific behavior that happens once a stream
 * declaration was matched.
 */
interface StreamRuntime {
  activeStreams: Map<string, ActiveStream>;

  generateId(prefix?: string): string;

  logger: Pick<Logger, 'warn' | 'error'>;

  errorHooks: readonly ((ctx: unknown, error: unknown, event?: string) => void | Promise<void>)[];

  declaredErrorCodes: ReadonlySet<string>;

  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;

  sendProtocolMessage(
    connection: RuntimeConnection,
    opts: { event: string; payload: Record<string, unknown>; wskit: Record<string, unknown> },
  ): void;

  sendThroughPipeline(
    connection: RuntimeConnection,
    opts: {
      routing:
        | {
            channel?: string;
            channelScope?: string | null;
            streamId?: string;
            seq?: number;
            streamKind?: 'ephemeral' | 'persistent';
          }
        | undefined;
      event: string;
      payload: unknown;
    },
  ): boolean;

  asyncContext: EngineAsyncContext;

  handleRuntimeError(
    connection: RuntimeConnection,
    opts: { error: unknown; event?: string; routing?: Protocol.WSKitRouting },
  ): Promise<void>;

  handleValidationError(
    connection: RuntimeConnection,
    opts: { event: string; validationError: unknown; scope?: ResolvedScope },
  ): Promise<void>;

  connections: Map<string, RuntimeConnection>;

  persistAttachment(connection: RuntimeConnection): void;
}

/** Build the `__wskit` routing block for a stream protocol frame. */
function buildStreamRouting(
  streamId: string,
  scope: ResolvedScope,
): Partial<Protocol.WSKitProtocol> {
  const wskit: Partial<Protocol.WSKitProtocol> = { streamId };
  if (scope.channelName) wskit.channel = scope.channelName;
  if (scope.channelScope) wskit.channelScope = scope.channelScope;
  return wskit;
}

/**
 * Cancel one live stream when the owning client sends `__streamCancel__`.
 */
export async function cancelStream(
  runtime: Pick<StreamRuntime, 'activeStreams'> & {
    logger?: Pick<Logger, 'error'>;
  },
  connection: RuntimeConnection,
  streamId: string,
): Promise<void> {
  const activeStream = runtime.activeStreams.get(streamId);
  if (!activeStream || activeStream.connectionId !== connection.id || activeStream.closed) {
    return;
  }

  activeStream.closed = true;

  try {
    // The generator's cleanup (`finally`) may throw. Contain it so the throw
    // doesn't escape the WS callback as an unhandled adapter error.
    await activeStream.generator.return(undefined);
  } catch (error) {
    runtime.logger?.error('[wskit] stream cleanup threw on __streamCancel__', {
      streamId: activeStream.id,
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    runtime.activeStreams.delete(activeStream.id);
  }
}

/**
 * Max nudges buffered for one active stream. When a client queues more than
 * this (the generator is draining them too slowly), the stream is aborted
 * instead of letting the buffer grow without bound.
 */
const NUDGE_BUFFER_CAP = 256;

/**
 * Buffer one validated nudge for a running stream.
 *
 * Returning `true` means the event belonged to an active stream, so normal
 * incoming routing should stop.
 */
export interface BufferStreamNudgeOptions {
  event: string;

  payload: unknown;

  wskit: Protocol.WSKitProtocol | undefined;
}

export async function bufferStreamNudge(
  runtime: Pick<
    StreamRuntime,
    'activeStreams' | 'handleValidationError' | 'handleRuntimeError' | 'sendProtocolMessage'
  > & { logger?: Pick<Logger, 'error'> },
  connection: RuntimeConnection,
  options: BufferStreamNudgeOptions,
): Promise<boolean> {
  const { event, payload, wskit } = options;
  const streamId = wskit?.streamId;
  if (streamId === undefined) return false;
  const streamNudgeId = wskit?.streamNudgeId;

  // A rejected nudge is non-terminal: the error carries streamTerminated:false and
  // the streamNudgeId, so the client's nudge() Promise rejects without ending the stream.
  const rejectRouting: Protocol.WSKitRouting = { streamId, streamTerminated: false };
  if (streamNudgeId !== undefined) rejectRouting.streamNudgeId = streamNudgeId;

  const activeStream = runtime.activeStreams.get(streamId);

  // A `streamId` frame must match a live stream owned by this connection. If
  // not, it is bad — send `__error__` and mark it handled so it never falls
  // through to a same-named top-level `.incoming()` handler.
  if (!activeStream || activeStream.connectionId !== connection.id || activeStream.closed) {
    const error = ValidationFailed({
      event,
      issues: [
        {
          message: `frame references unknown or inactive stream "${streamId}"`,
          path: ['streamId'],
        },
      ],
    });
    await runtime.handleRuntimeError(connection, { error, event, routing: rejectRouting });
    return true;
  }

  const validator = activeStream.nudgeValidators.get(event);
  // The stream is live, but `event` is not a registered nudge for it. Treat as
  // handled so it does not fall through to top-level dispatch.
  if (!activeStream.nudgeValidators.has(event)) {
    const error = ValidationFailed({
      event,
      issues: [
        {
          message: `event "${event}" is not a registered nudge for stream "${streamId}"`,
          path: [],
        },
      ],
    });
    await runtime.handleRuntimeError(connection, { error, event, routing: rejectRouting });
    return true;
  }

  // The client is queueing nudges faster than the generator drains them.
  // Growing the buffer without bound is a memory-exhaustion vector, and silently
  // dropping nudges would corrupt the stream's input. Reject THIS nudge as
  // backpressure — non-terminal, so only its nudge() Promise rejects and the
  // stream keeps running. The client can slow down and retry.
  if (activeStream.nudges.length >= NUDGE_BUFFER_CAP) {
    runtime.sendProtocolMessage(connection, {
      event: '__error__',
      payload: { code: NudgeOverflow.code, detail: { cap: NUDGE_BUFFER_CAP } },
      wskit: rejectRouting,
    });
    return true;
  }

  try {
    activeStream.nudges.push({
      event,
      payload: validateValue(validator, payload, event),
    });
  } catch (error) {
    rethrowIfConfigError(error);
    await runtime.handleValidationError(connection, { event, validationError: error });
    // Send `__error__` with `streamId` routing so the client hits the right
    // stream-error handler. Mark handled so it does not fall through.
    await runtime.handleRuntimeError(connection, { error, event, routing: rejectRouting });
    return true;
  }

  // The nudge passed validation and is buffered — confirm it so the client's
  // nudge() Promise resolves. (No streamNudgeId means a fire-and-forget nudge.)
  if (streamNudgeId !== undefined) {
    runtime.sendProtocolMessage(connection, {
      event: '__nudgeOk__',
      payload: {},
      wskit: { streamId, streamNudgeId },
    });
  }

  return true;
}

export interface RunStreamOptions {
  scope: ResolvedScope;

  event: string;

  stream: AnyGenerate;

  payload: unknown;

  wskit?: Protocol.WSKitProtocol;
}

/**
 * Start one matched stream, forward yielded chunks, and surface its lifecycle
 * protocol events.
 */
export async function runStream(
  runtime: StreamRuntime,
  connection: RuntimeConnection,
  options: RunStreamOptions,
): Promise<void> {
  const { scope, event, stream, payload, wskit } = options;
  // One active stream per event per connection, unless `allowConcurrent: true`.
  assertNoConcurrentStream(runtime, connection, {
    event,
    allowConcurrent: stream.stream.allowConcurrent,
  });

  // Use the client's `streamId` if it sent one. Reject collisions with another
  // active stream on this connection. The wire schema already bounds and
  // non-empties it (`StreamIdString`), so its presence is the only question.
  let streamId: string;
  const suppliedId = wskit?.streamId;
  if (suppliedId !== undefined) {
    if (runtime.activeStreams.has(suppliedId)) {
      throw StreamIdCollision();
    }
    streamId = suppliedId;
  } else {
    streamId = runtime.generateId('stream');
  }

  runtime.sendProtocolMessage(connection, {
    event: '__streamOk__',
    payload: {},
    wskit: { ...buildStreamRouting(streamId, scope), streamKind: 'ephemeral' },
  });

  const ctx = runtime.buildConnectionContext(connection, scope) as Record<PropertyKey, unknown>;
  installCtxNudges(ctx);

  const iterator = stream.generator(ctx, payload) as AsyncGenerator<unknown, void, unknown>;

  const { active: activeStream } = buildActiveStream({
    streamId,
    event,
    connection,
    generator: iterator,
    nudges: stream.stream.nudges.map((declaration) => ({
      event: declaration.event,
      validator: declaration.validator,
    })),
  });

  runtime.activeStreams.set(streamId, activeStream);
  if (!connection.activeStreamIds) connection.activeStreamIds = new Set();
  connection.activeStreamIds.add(streamId);
  runtime.persistAttachment(connection);

  // Who a broadcast fans out to: channel members for a channel stream, every
  // connection otherwise — minus the creator, who gets its own copy.
  function broadcastTargets(): RuntimeConnection[] {
    const all = scope.channelName
      ? [...runtime.connections.values()].filter((target) =>
          ChannelPrimitive.hasChannelMembership(
            target,
            scope.channelName!,
            scope.channelScope ?? null,
          ),
        )
      : [...runtime.connections.values()];
    return all.filter((target) => target.id !== connection.id);
  }

  try {
    let nextInput: unknown = stream.stream.nudges.length > 0 ? [] : undefined;
    let seq = 0;

    while (!activeStream.closed) {
      // Advance the generator inside the connection's async context so plugin
      // APIs it calls (e.g. hooks.getState()) resolve to the stream owner.
      const result = await withConnectionContext(runtime.asyncContext, connection.id, () =>
        iterator.next(nextInput),
      );
      if (result.done) break;

      seq += 1;
      const chunkRouting = {
        channel: scope.channelName,
        channelScope: scope.channelScope,
        streamId,
        streamKind: 'ephemeral' as const,
        seq,
      };

      if (stream.stream.broadcast) {
        // Fan out per-target so each peer chunk carries streamId + seq + streamKind
        // (same as the creator's), which onStream needs to group and complete it.
        await forEachIsolatedAsync(
          broadcastTargets(),
          (target) => {
            runtime.sendThroughPipeline(target, {
              routing: chunkRouting,
              event,
              payload: result.value,
            });
          },
          { context: `stream broadcast fan-out streamId="${streamId}" event="${event}"` },
        );
      }
      runtime.sendThroughPipeline(connection, {
        routing: chunkRouting,
        event,
        payload: result.value,
      });

      nextInput = stream.stream.nudges.length > 0 ? [...activeStream.nudges] : undefined;
      activeStream.nudges.length = 0;
    }

    if (!activeStream.closed) {
      const endWskit = { ...buildStreamRouting(streamId, scope), seq };
      runtime.sendProtocolMessage(connection, {
        event: '__streamEnd__',
        payload: {},
        wskit: endWskit,
      });
      if (stream.stream.broadcast) {
        await forEachIsolatedAsync(
          broadcastTargets(),
          (target) =>
            runtime.sendProtocolMessage(target, {
              event: '__streamEnd__',
              payload: {},
              wskit: endWskit,
            }),
          { context: `stream broadcast end streamId="${streamId}"` },
        );
      }
    }
  } catch (streamError) {
    const routing: Protocol.WSKitRouting = { streamId, streamTerminated: true };
    if (scope.channelName) routing.channel = scope.channelName;
    if (scope.channelScope) routing.channelScope = scope.channelScope;

    // A terminal error reaches the creator (below) and, for a broadcast, every
    // subscriber — so a peer's onError fires instead of a misleading clean end.
    if (stream.stream.broadcast) {
      const { payload, wskit } = normalizeRuntimeError(
        streamError,
        routing,
        runtime.declaredErrorCodes,
      );
      await forEachIsolatedAsync(
        broadcastTargets(),
        (target) => runtime.sendProtocolMessage(target, { event: '__error__', payload, wskit }),
        { context: `stream broadcast error streamId="${streamId}"` },
      );
    }

    if (
      streamError &&
      typeof streamError === 'object' &&
      (streamError as { __wskit?: string }).__wskit === 'defer'
    ) {
      // Defer makes no sense in a stream: a generator that already yielded
      // chunks cannot be retried from the start. Treat it as a programming
      // mistake — log an error and surface it to the client as a plain
      // internal error, not a defer-exhausted one (nothing was ever retried).
      runtime.logger.error(
        '[wskit] Defer thrown inside a stream handler — streams cannot be retried',
        {
          event,
          streamId,
        },
      );
      const internal = InternalError();
      // Isolate per hook so an observer throw never blocks the __error__ frame
      // the client is waiting for.
      await forEachIsolatedAsync(
        runtime.errorHooks,
        (hook) => hook(runtime.buildConnectionContext(connection, scope), internal, event),
        { context: `stream onError hook event="${event}"` },
      );
      runtime.sendProtocolMessage(connection, {
        event: '__error__',
        payload: { code: InternalError.code },
        wskit: routing as Record<string, unknown>,
      });
    } else {
      await runtime.handleRuntimeError(connection, { error: streamError, event, routing });
    }
  } finally {
    connection.activeStreamIds?.delete(streamId);
    runtime.activeStreams.delete(streamId);
    runtime.persistAttachment(connection);
  }
}
