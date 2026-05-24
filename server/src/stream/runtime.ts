/* oxlint-disable @typescript-eslint/no-explicit-any */
import { rethrowIfConfigError, StreamIdCollision, ValidationFailed } from '@wskit/core';
import { withConnectionContext } from '~/_engine/async-context.ts';
import { validateValue } from '~/_engine/compile/utils.ts';
import {
  assertNoConcurrentStream,
  buildActiveStream,
  installCtxNudges,
} from '~/_engine/stream-common/active-stream.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { DeferExhausted } from '~/errors/errors.ts';
import type { AnyGenerate } from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { ActiveStream, ResolvedScope, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { AsyncContext, Logger } from '~/context.ts';

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

  logger: Pick<Logger, 'warn'>;

  errorHooks: readonly ((ctx: unknown, error: unknown, event?: string) => void | Promise<void>)[];

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
        | { namespace?: string; channel?: string; channelScope?: string | null; streamId?: string }
        | undefined;
      event: string;
      payload: unknown;
    },
  ): boolean;

  asyncContext?: AsyncContext;

  handleRuntimeError(
    connection: RuntimeConnection,
    opts: { error: unknown; event?: string; routing?: Protocol.WskitRouting },
  ): Promise<void>;

  handleValidationError(
    connection: RuntimeConnection,
    opts: { event: string; validationError: unknown; scope?: ResolvedScope },
  ): Promise<void>;

  broadcastToConnections(
    connections: readonly RuntimeConnection[],
    opts: {
      event: string;
      payload: unknown;
      options?: {
        namespace?: string;
        channel?: string;
        channelScope?: string | null;
        excludeSelf?: boolean;
      };
      excludeConnectionId?: string;
    },
  ): void;

  connections: Map<string, RuntimeConnection>;

  persistAttachment(connection: RuntimeConnection): void;
}

/**
 * Extract a client-supplied `streamId` from the incoming frame's `__wskit`.
 * Accepts only non-empty strings under 256 chars to keep the id reasonable for
 * SQL indexing and logging. Anything else is treated as "no id supplied" and
 * the runtime generates one.
 */
function readSuppliedStreamId(wskit: Protocol.WskitProtocol | undefined): string | undefined {
  const value = wskit?.streamId;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined;
  return value;
}

/** Build the `__wskit` routing block for a stream protocol frame. */
function buildStreamRouting(streamId: string, scope: ResolvedScope): Record<string, unknown> {
  const wskit: Record<string, unknown> = { streamId };
  if (scope.namespace?.name) wskit.namespace = scope.namespace.name;
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
 * Buffer one validated nudge for a running stream.
 *
 * Returning `true` means the event belonged to an active stream, so normal
 * incoming routing should stop.
 */
export interface BufferStreamNudgeOptions {
  event: string;

  payload: unknown;

  wskit: Protocol.WskitProtocol | undefined;
}

export async function bufferStreamNudge(
  runtime: Pick<StreamRuntime, 'activeStreams' | 'handleValidationError' | 'handleRuntimeError'>,
  connection: RuntimeConnection,
  options: BufferStreamNudgeOptions,
): Promise<boolean> {
  const { event, payload, wskit } = options;
  const streamId = wskit?.streamId;
  if (typeof streamId !== 'string') return false;

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
    await runtime.handleRuntimeError(connection, { error, event, routing: { streamId } });
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
    await runtime.handleRuntimeError(connection, { error, event, routing: { streamId } });
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
    await runtime.handleRuntimeError(connection, { error, event, routing: { streamId } });
    return true;
  }

  return true;
}

export interface RunStreamOptions {
  scope: ResolvedScope;

  event: string;

  stream: AnyGenerate;

  payload: unknown;

  wskit?: Protocol.WskitProtocol;
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
  // One active stream per event per connection, unless `.allowConcurrent()`.
  assertNoConcurrentStream(runtime, connection, {
    event,
    allowConcurrent: stream.stream.allowConcurrent,
  });

  // Use the client's `streamId` if it sent one. Reject collisions with another
  // active stream on this connection.
  let streamId: string;
  const suppliedId = readSuppliedStreamId(wskit);
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
    wskit: buildStreamRouting(streamId, scope),
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

  try {
    let nextInput: unknown = stream.stream.nudges.length > 0 ? [] : undefined;

    while (!activeStream.closed) {
      // Advance the generator inside the connection's async context so plugin
      // APIs it calls (e.g. hooks.getState()) resolve to the stream owner.
      const result = await withConnectionContext(runtime.asyncContext, connection.id, () =>
        iterator.next(nextInput),
      );
      if (result.done) break;

      if (stream.stream.broadcast) {
        // A channel-scoped stream broadcasts to channel members only. Top-level
        // and namespace streams broadcast to every connection.
        const targets = scope.channelName
          ? [...runtime.connections.values()].filter((target) =>
              ChannelPrimitive.hasChannelMembership(
                target,
                scope.channelName!,
                scope.channelScope ?? null,
              ),
            )
          : [...runtime.connections.values()];
        runtime.broadcastToConnections(targets, {
          event,
          payload: result.value,
          options: {
            namespace: scope.namespace?.name,
            channel: scope.channelName,
            channelScope: scope.channelScope,
            excludeSelf: true,
          },
          excludeConnectionId: connection.id,
        });
      }
      runtime.sendThroughPipeline(connection, {
        routing: {
          namespace: scope.namespace?.name,
          channel: scope.channelName,
          channelScope: scope.channelScope,
          streamId,
        },
        event,
        payload: result.value,
      });

      nextInput = stream.stream.nudges.length > 0 ? [...activeStream.nudges] : undefined;
      activeStream.nudges.length = 0;
    }

    if (!activeStream.closed) {
      runtime.sendProtocolMessage(connection, {
        event: '__streamEnd__',
        payload: {},
        wskit: buildStreamRouting(streamId, scope),
      });
    }
  } catch (streamError) {
    const routing: Protocol.WskitRouting = { streamId };
    if (scope.namespace?.name) routing.namespace = scope.namespace.name;
    if (scope.channelName) routing.channel = scope.channelName;
    if (scope.channelScope) routing.channelScope = scope.channelScope;

    if (
      streamError &&
      typeof streamError === 'object' &&
      (streamError as { __wskit?: string }).__wskit === 'defer'
    ) {
      runtime.logger.warn(
        '[wskit] Defer thrown inside a stream handler — streams cannot be retried',
        {
          event,
          streamId,
        },
      );
      const exhausted = DeferExhausted({ event, payload, retries: 0 });
      for (const hook of runtime.errorHooks) {
        await hook(runtime.buildConnectionContext(connection, scope), exhausted, event);
      }
      runtime.sendProtocolMessage(connection, {
        event: '__error__',
        payload: { code: DeferExhausted.code },
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
