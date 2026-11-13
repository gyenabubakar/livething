/* oxlint-disable @typescript-eslint/no-explicit-any */
import {
  ChannelNotSubscribed,
  NudgeOverflow,
  rethrowIfConfigError,
  StreamAborted,
  StreamIdCollision,
  ValidationFailed,
} from '@livething/core';
import { connectionCall, inConnectionCall, withConnectionCall } from '~/_engine/async-context.ts';
import { validateValue } from '~/_engine/compile/utils.ts';
import { forEachIsolatedAsync } from '~/_engine/runtime/isolation.ts';
import {
  abortActiveStream,
  assertNoConcurrentStream,
  buildActiveStream,
  buildDrain,
  installCtxDrain,
  installCtxNudges,
  installCtxSignal,
} from '~/_engine/stream-common/active-stream.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { normalizeRuntimeError } from '~/errors/runtime.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type { AnyGenerate } from '~/_engine/compile/types.ts';
import type { DurableStreamService } from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ActiveStream, ResolvedChannel, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { Logger } from '~/context.ts';
import type { SharedSend, SharedSendOptions } from '~/outgoing/runtime.ts';

type OptsParameter = {
  event: string;
  payload: Record<string, unknown>;
  livething: Record<string, unknown>;
};
type OptsParameter2 = {
  routing:
    | {
        channel?: string;
        channelFamily?: string | null;
        streamId?: string;
        streamSeq?: number;
        streamDurability?: 'ephemeral' | 'persistent';
      }
    | undefined;
  event: string;
  payload: unknown;
};
type OptsParameter3 = { error: unknown; event?: string; routing?: Protocol.LiveThingRouting };

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
    scope?: ResolvedChannel,
  ): Record<PropertyKey, unknown>;

  sendProtocolMessage(connection: RuntimeConnection, opts: OptsParameter): void;

  sendThroughPipeline(connection: RuntimeConnection, opts: OptsParameter2): boolean;

  openSharedSend(opts: SharedSendOptions): SharedSend;

  asyncContext: EngineAsyncContext;

  handleRuntimeError(connection: RuntimeConnection, opts: OptsParameter3): Promise<void>;

  connections: Map<string, RuntimeConnection>;

  persistAttachment(connection: RuntimeConnection): void;
}

/** Build the `__livething` routing block for a stream protocol frame. */
function buildStreamRouting(
  streamId: string,
  scope: ResolvedChannel,
): Partial<Protocol.LiveThingProtocol> {
  const livething: Partial<Protocol.LiveThingProtocol> = { streamId };
  if (scope.channelName) livething.channel = scope.channelName;
  if (scope.channelFamily) livething.channelFamily = scope.channelFamily;
  return livething;
}

/**
 * The peers a broadcast stream fans out to: channel members for a channel
 * stream, every connection otherwise — minus the creator, who handles its own
 * copy. Shared by the live fan-out and the cancel terminal so a cancel reaches
 * the same peers a normal end would.
 */
function streamBroadcastTargets(
  connections: Map<string, RuntimeConnection>,
  creatorId: string,
  scope: ResolvedChannel,
): RuntimeConnection[] {
  const all = scope.channelName
    ? [...connections.values()].filter((target) =>
        ChannelPrimitive.hasChannelMembership(
          target,
          scope.channelName!,
          scope.channelFamily ?? null,
        ),
      )
    : [...connections.values()];
  return all.filter((target) => target.id !== creatorId);
}

/**
 * Cancel one live stream when the owning client sends `__streamCancel__`.
 */
export async function cancelStream(
  runtime: Pick<StreamRuntime, 'activeStreams' | 'connections' | 'sendProtocolMessage'> & {
    logger: Pick<Logger, 'error'>;
  },
  connection: RuntimeConnection,
  streamId: string,
): Promise<void> {
  const activeStream = runtime.activeStreams.get(streamId);
  if (!activeStream || activeStream.connectionId !== connection.id || activeStream.closed) {
    return;
  }

  activeStream.closed = true;

  // Fire the stop signal before return() so in-flight awaited work (fetch,
  // timers wired to ctx.stream.signal) is cancelled, then cleanup runs.
  abortActiveStream(activeStream, 'cancelled');

  try {
    // The generator's cleanup (`finally`) may throw. Contain it so the throw
    // doesn't escape the WS callback as an unhandled adapter error.
    await activeStream.generator.return(undefined);
  } catch (error) {
    runtime.logger.error('[livething] stream cleanup threw on __streamCancel__', {
      streamId: activeStream.id,
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // For a broadcast stream, fan a terminal `__streamEnd__` out to the peers so
    // their `onStream` runs complete instead of hanging until timeout — the same
    // terminal a normal completion sends. The creator initiated the cancel, so
    // it gets none. Peers route by the stream's event name, carried as eventName.
    if (activeStream.broadcast && activeStream.scope) {
      const peerEndLiveThing = {
        ...buildStreamRouting(activeStream.id, activeStream.scope),
        eventName: activeStream.event,
      };

      await forEachIsolatedAsync(
        streamBroadcastTargets(runtime.connections, connection.id, activeStream.scope),
        (target) =>
          runtime.sendProtocolMessage(target, {
            event: '__streamEnd__',
            payload: {},
            livething: peerEndLiveThing,
          }),
        {
          context: `stream broadcast cancel end streamId="${activeStream.id}"`,
          logger: runtime.logger,
        },
      );
    }

    runtime.activeStreams.delete(activeStream.id);
  }
}

export interface StopChannelStreamsOptions {
  channelName: string;

  channelFamily: string | null;

  /**
   * True when the user has no connection left in the channel. A stream of that
   * user that kept running after its connection dropped (a recorded stream) is
   * then stopped too, since no member can continue it.
   */
  userGone: boolean;
}

type StopChannelStreamsRuntime = Pick<
  StreamRuntime,
  'activeStreams' | 'connections' | 'sendProtocolMessage' | 'persistAttachment'
> & {
  logger: Pick<Logger, 'error'>;
  durableStream?: DurableStreamService;
};

function belongsToLeaver(
  activeStream: ActiveStream,
  connection: RuntimeConnection,
  opts: StopChannelStreamsOptions,
): boolean {
  const scope = activeStream.scope;
  if (!scope?.channelName) return false;

  if (scope.channelName !== opts.channelName) return false;

  if ((scope.channelFamily ?? null) !== opts.channelFamily) return false;

  if (activeStream.connectionId === connection.id) return true;

  return (
    opts.userGone &&
    activeStream.detached === true &&
    connection.userId !== '' &&
    activeStream.connection?.userId === connection.userId
  );
}

/**
 * Stop every stream a connection runs in a channel it just left (unsubscribe,
 * kick, or server-side removal). Each stream's signal aborts with reason
 * `'unsubscribed'` and its generator's `return()` runs. The owning client gets
 * a terminal `stream-aborted` error with reason `'unsubscribed'`, and the peers
 * of a broadcast stream get `__streamEnd__`. A durable stream is
 * also deleted from storage, so nobody can continue it later.
 */
export async function stopChannelStreams(
  runtime: StopChannelStreamsRuntime,
  connection: RuntimeConnection,
  opts: StopChannelStreamsOptions,
): Promise<void> {
  const leaving = [...runtime.activeStreams.values()].filter(
    (activeStream) => !activeStream.closed && belongsToLeaver(activeStream, connection, opts),
  );

  for (const activeStream of leaving) {
    const scope = activeStream.scope!;
    activeStream.closed = true;
    abortActiveStream(activeStream, 'unsubscribed');

    const owner = activeStream.detached ? undefined : activeStream.connection;
    if (owner && !owner.closing) {
      const routing: Protocol.LiveThingRouting = {
        ...buildStreamRouting(activeStream.id, scope),
        streamTerminated: true,
      };

      runtime.sendProtocolMessage(owner, {
        event: '__error__',
        payload: { code: StreamAborted.code, detail: { reason: 'unsubscribed' } },
        livething: routing as Record<string, unknown>,
      });
    }

    try {
      await activeStream.generator.return(undefined);
    } catch (error) {
      runtime.logger.error('[livething] stream cleanup threw on channel leave', {
        streamId: activeStream.id,
        connectionId: activeStream.connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (activeStream.durable) {
      runtime.durableStream?.endOnLeave(runtime, activeStream.connection ?? connection, {
        streamId: activeStream.id,
        scope,
      });
    } else if (activeStream.broadcast) {
      const peerEndLiveThing = {
        ...buildStreamRouting(activeStream.id, scope),
        eventName: activeStream.event,
      };

      await forEachIsolatedAsync(
        streamBroadcastTargets(runtime.connections, activeStream.connectionId, scope),
        (target) =>
          runtime.sendProtocolMessage(target, {
            event: '__streamEnd__',
            payload: {},
            livething: peerEndLiveThing,
          }),
        {
          context: `stream broadcast end on channel leave streamId="${activeStream.id}"`,
          logger: runtime.logger,
        },
      );
    }

    if (runtime.activeStreams.get(activeStream.id) === activeStream) {
      runtime.activeStreams.delete(activeStream.id);
    }

    if (owner?.activeStreamIds?.delete(activeStream.id)) runtime.persistAttachment(owner);
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

  livething: Protocol.LiveThingProtocol | undefined;
}

export async function bufferStreamNudge(
  runtime: Pick<StreamRuntime, 'activeStreams' | 'handleRuntimeError' | 'sendProtocolMessage'> & {
    logger?: Pick<Logger, 'error'>;
  },
  connection: RuntimeConnection,
  options: BufferStreamNudgeOptions,
): Promise<boolean> {
  const { event, payload, livething } = options;
  const streamId = livething?.streamId;
  if (streamId === undefined) return false;

  const streamNudgeId = livething?.streamNudgeId;

  // A rejected nudge is non-terminal: the error carries streamTerminated:false and
  // the streamNudgeId, so the client's nudge() Promise rejects without ending the stream.
  const rejectRouting: Protocol.LiveThingRouting = { streamId, streamTerminated: false };
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

  // The nudge must target the exact scope the stream runs in, and the
  // connection must still hold that membership. A nudge claiming a different
  // (or absent) scope for a channel stream is rejected — it must not reach
  // the generator or run on the wrong scope.
  const storedScope = activeStream.scope ?? {};
  const claimedChannel = livething?.channel;
  const claimedScope = livething?.channelFamily ?? null;
  const sameScope =
    (storedScope.channelName ?? undefined) === (claimedChannel ?? undefined) &&
    (storedScope.channelFamily ?? null) === claimedScope;
  const memberOk =
    !storedScope.channelName ||
    ChannelPrimitive.hasChannelMembership(
      connection,
      storedScope.channelName,
      storedScope.channelFamily ?? null,
    );

  if (!sameScope || !memberOk) {
    await runtime.handleRuntimeError(connection, {
      error: ChannelNotSubscribed(),
      event,
      routing: rejectRouting,
    });
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
      livething: rejectRouting,
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
      livething: { streamId, streamNudgeId },
    });
  }

  return true;
}

export interface RunStreamOptions {
  scope: ResolvedChannel;

  event: string;

  stream: AnyGenerate;

  payload: unknown;

  livething?: Protocol.LiveThingProtocol;

  /** The bytes of the frame that started a binary stream, else `undefined`. */
  bytes?: Uint8Array;
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
  const { scope, event, stream, payload, livething } = options;

  // One active stream per event per connection, unless `allowConcurrent: true`.
  assertNoConcurrentStream(runtime, connection, {
    event,
    allowConcurrent: stream.stream.allowConcurrent,
  });

  // Use the client's `streamId` if it sent one. Reject collisions with another
  // active stream on this connection. The wire schema already bounds and
  // non-empties it (`StreamIdString`), so its presence is the only question.
  let streamId: string;
  const suppliedId = livething?.streamId;
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
    livething: { ...buildStreamRouting(streamId, scope), streamDurability: 'ephemeral' },
  });
  if (connection.closing) return;

  const ctx = runtime.buildConnectionContext(connection, scope) as Record<PropertyKey, unknown>;
  installCtxNudges(ctx);
  const abortController = new AbortController();
  installCtxSignal(ctx, abortController);

  // Who a broadcast fans out to: channel members for a channel stream, every
  // connection otherwise — minus the creator, who gets its own copy.
  function broadcastTargets(): RuntimeConnection[] {
    return streamBroadcastTargets(runtime.connections, connection.id, scope);
  }

  async function sendBroadcastEnd(seq: number): Promise<void> {
    if (!stream.stream.broadcast) return;

    const endLiveThing = {
      ...buildStreamRouting(streamId, scope),
      streamSeq: seq,
      eventName: event,
    };

    await forEachIsolatedAsync(
      broadcastTargets(),
      (target) =>
        runtime.sendProtocolMessage(target, {
          event: '__streamEnd__',
          payload: {},
          livething: endLiveThing,
        }),
      { context: `stream broadcast end streamId="${streamId}"`, logger: runtime.logger },
    );
  }

  // The drain function needs the active-stream object to know when the stream is
  // torn down, but the iterator (built from ctx, which carries drain) is created
  // before the active stream exists. A late-bound holder breaks the cycle.
  let activeStreamRef: ActiveStream | undefined = undefined;
  installCtxDrain(
    ctx,
    buildDrain({
      // Broadcast paces against the healthiest of every target; a single stream
      // against just its own connection.
      targets: () => (stream.stream.broadcast ? [connection, ...broadcastTargets()] : [connection]),
      isClosed: () => activeStreamRef?.closed ?? false,
    }),
  );

  const streamCall = connectionCall(connection.id, scope, () => ctx);
  const iterator = inConnectionCall(
    runtime.asyncContext,
    streamCall,
    withConnectionCall(runtime.asyncContext, streamCall, () =>
      stream.generator(ctx, payload, options.bytes),
    ) as AsyncGenerator<unknown, void, unknown>,
  );

  const { active: activeStream } = buildActiveStream({
    streamId,
    event,
    connection,
    generator: iterator,
    scope,
    abortController,
    broadcast: stream.stream.broadcast,
    nudges: stream.stream.nudges.map((declaration) => ({
      event: declaration.event,
      validator: declaration.validator,
    })),
  });
  activeStreamRef = activeStream;

  runtime.activeStreams.set(streamId, activeStream);
  if (!connection.activeStreamIds) connection.activeStreamIds = new Set();
  connection.activeStreamIds.add(streamId);
  runtime.persistAttachment(connection);

  try {
    let nextInput: unknown = stream.stream.nudges.length > 0 ? [] : undefined;
    let seq = 0;

    while (!activeStream.closed) {
      // The wrapped iterator runs inside the connection's async context, so plugin
      // APIs the generator calls (e.g. hooks.getState()) resolve to the stream owner.
      const result = await iterator.next(nextInput);
      if (result.done) break;

      // A cancel can land while next() was pending. Drop the resolved value —
      // sending it would emit a chunk (and a later __streamEnd__) after cancel.
      if (activeStream.closed) {
        await iterator.return(undefined);
        break;
      }

      seq += 1;
      const chunkRouting = {
        channel: scope.channelName,
        channelFamily: scope.channelFamily,
        streamId,
        streamDurability: 'ephemeral' as const,
        streamSeq: seq,
      };

      let sent: boolean;
      if (stream.stream.broadcast) {
        // One frame for the creator and every peer: each carries the same streamId + seq +
        // streamDurability, which onStream needs to group and complete it.
        const chunkSend = runtime.openSharedSend({
          routing: chunkRouting,
          event,
          payload: result.value,
          target: scope.channelName ? { kind: 'channel' } : { kind: 'all' },
        });
        await forEachIsolatedAsync(
          broadcastTargets(),
          (target) => {
            chunkSend.deliver(target);
          },
          {
            context: `stream broadcast fan-out streamId="${streamId}" event="${event}"`,
            logger: runtime.logger,
          },
        );
        try {
          sent = chunkSend.deliver(connection);
        } finally {
          chunkSend.finish();
        }
      } else {
        sent = runtime.sendThroughPipeline(connection, {
          routing: chunkRouting,
          event,
          payload: result.value,
        });
      }

      if (!sent) {
        activeStream.closed = true;
        await iterator.return(undefined);
        await sendBroadcastEnd(seq);
        break;
      }

      nextInput = stream.stream.nudges.length > 0 ? [...activeStream.nudges] : undefined;
      activeStream.nudges.length = 0;
    }

    if (!activeStream.closed && !connection.closing) {
      const endLiveThing = { ...buildStreamRouting(streamId, scope), streamSeq: seq };
      runtime.sendProtocolMessage(connection, {
        event: '__streamEnd__',
        payload: {},
        livething: endLiveThing,
      });
      await sendBroadcastEnd(seq);
    }
  } catch (streamError) {
    // When LiveThing refused a chunk, the generator still waits at its yield. Close it, so its
    // finally blocks run. A generator that threw has already finished, so this does nothing.
    await iterator.return(undefined).catch(() => {});

    const routing: Protocol.LiveThingRouting = { streamId, streamTerminated: true };
    if (scope.channelName) routing.channel = scope.channelName;
    if (scope.channelFamily) routing.channelFamily = scope.channelFamily;

    // A terminal error reaches the creator (below) and, for a broadcast, every
    // subscriber — so a peer's onError fires instead of a misleading clean end.
    if (stream.stream.broadcast) {
      const normalized = normalizeRuntimeError(streamError, routing, runtime.declaredErrorCodes);
      const peerErrorLiveThing = { ...normalized.livething, eventName: event };
      await forEachIsolatedAsync(
        broadcastTargets(),
        (target) =>
          runtime.sendProtocolMessage(target, {
            event: '__error__',
            payload: normalized.payload,
            livething: peerErrorLiveThing,
          }),
        { context: `stream broadcast error streamId="${streamId}"`, logger: runtime.logger },
      );
    }

    await runtime.handleRuntimeError(connection, { error: streamError, event, routing });
  } finally {
    connection.activeStreamIds?.delete(streamId);
    runtime.activeStreams.delete(streamId);
    runtime.persistAttachment(connection);
  }
}
