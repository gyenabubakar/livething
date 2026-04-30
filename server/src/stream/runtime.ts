/* oxlint-disable @typescript-eslint/no-explicit-any */
import { InternalError, rethrowIfConfigError } from '@wskit/core';
import { validateValue } from '~/_engine/compile/utils.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type { AnyGenerate } from '~/_engine/compile/types.ts';
import type { ActiveStream, ResolvedScope, RuntimeConnection } from '~/_engine/runtime/types.ts';

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
  logger: {
    warn(message: string, data?: Record<string, unknown>): void;
  };
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
  ): void;
  sendThroughPipeline(
    connection: RuntimeConnection,
    scope: {
      namespace?: string;
      channel?: string;
      channelScope?: string;
      streamId?: string;
    },
    event: string,
    payload: unknown,
  ): boolean;
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
  broadcastToConnections(
    connections: readonly RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: {
      namespace?: string;
      channel?: string;
      channelScope?: string;
      excludeSelf?: boolean;
    },
    excludeConnectionId?: string,
  ): void;
  connections: Map<string, RuntimeConnection>;
  persistAttachment(connection: RuntimeConnection): void;
}

/**
 * Cancel one live stream when the owning client sends `_streamCancel`.
 */
export async function cancelStream(
  runtime: Pick<StreamRuntime, 'activeStreams'>,
  connection: RuntimeConnection,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  if (!payload || typeof payload._streamId !== 'string') return;

  const activeStream = runtime.activeStreams.get(payload._streamId);
  if (!activeStream || activeStream.connectionId !== connection.id || activeStream.closed) {
    return;
  }

  activeStream.closed = true;

  try {
    await activeStream.generator.return(undefined);
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
export async function bufferStreamNudge(
  runtime: Pick<StreamRuntime, 'activeStreams' | 'handleValidationError'>,
  connection: RuntimeConnection,
  event: string,
  payload: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (!payload || typeof payload._streamId !== 'string') return false;

  const activeStream = runtime.activeStreams.get(payload._streamId);
  if (!activeStream || activeStream.connectionId !== connection.id || activeStream.closed) {
    return false;
  }

  const validator = activeStream.nudgeValidators.get(event);
  if (!activeStream.nudgeValidators.has(event)) return false;

  const nudgePayload = { ...payload };
  delete nudgePayload._streamId;

  try {
    activeStream.nudges.push({
      event,
      payload: validateValue(validator, nudgePayload, event),
    });
  } catch (error) {
    rethrowIfConfigError(error);
    await runtime.handleValidationError(connection, event, error);
    // The frame matched an active stream and a registered nudge event —
    // it was meant for the stream. Treat it as handled (with error) so
    // the caller does not fall through to dispatchIncoming, which would
    // re-route a malformed nudge through any same-named top-level
    // .incoming() handler.
    return true;
  }

  return true;
}

/**
 * Start one matched stream, forward yielded chunks, and surface its lifecycle
 * protocol events.
 */
export async function runStream(
  runtime: StreamRuntime,
  connection: RuntimeConnection,
  scope: ResolvedScope,
  event: string,
  stream: AnyGenerate,
  payload: unknown,
): Promise<void> {
  const streamId = runtime.generateId('stream');
  runtime.sendProtocolMessage(connection, '_streamOk', {
    _streamId: streamId,
    ...(scope.namespace?.name ? { _namespace: scope.namespace.name } : {}),
    ...(scope.channelName ? { _channel: scope.channelName } : {}),
    ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
  });

  const ctx = runtime.buildConnectionContext(connection, scope) as Record<string, unknown>;
  ctx.nudges = (value: unknown) => (Array.isArray(value) ? value : []);

  // Construct the iterator. The generator body does not run yet — calling an
  // async generator function only returns the iterator; the body advances on
  // each `iterator.next()` call below. Bracketing the connection id around
  // construction would clear it before the body could ever observe it, so
  // the bracket lives around each `iterator.next()` instead.
  const iterator = stream.generator(ctx, payload);

  const activeStream: ActiveStream = {
    id: streamId,
    connectionId: connection.id,
    generator: iterator as AsyncGenerator<unknown, void, unknown>,
    nudges: [],
    nudgeValidators: new Map(
      stream.stream.nudges.map((declaration) => [declaration.event, declaration.validator]),
    ),
    closed: false,
  };

  runtime.activeStreams.set(streamId, activeStream);
  if (!connection.activeStreamIds) connection.activeStreamIds = new Set();
  connection.activeStreamIds.add(streamId);
  runtime.persistAttachment(connection);

  try {
    let nextInput: unknown = stream.stream.nudges.length > 0 ? [] : undefined;

    while (!activeStream.closed) {
      // Set the active connection id around each advance so module APIs the
      // generator calls before its first internal await (e.g. hooks.getState())
      // see the stream owner's connection. Restore afterwards so unrelated
      // operations don't observe a stale id.
      runtime.setActiveConnectionId(connection.id);
      let result: IteratorResult<unknown>;
      try {
        result = await iterator.next(nextInput);
      } finally {
        runtime.setActiveConnectionId(undefined);
      }
      if (result.done) break;

      if (stream.stream.broadcast) {
        // Channel-scoped streams broadcast to channel members only — the
        // chunk carries `_channel` in the wire envelope, and a non-member
        // has no business receiving it. Top-level and namespace-scoped
        // streams broadcast to every connection (no membership concept).
        const targets = scope.channelName
          ? [...runtime.connections.values()].filter((target) =>
              ChannelPrimitive.hasChannelMembership(target, scope.channelName!, scope.channelScope),
            )
          : [...runtime.connections.values()];
        runtime.broadcastToConnections(
          targets,
          event,
          result.value,
          {
            namespace: scope.namespace?.name,
            channel: scope.channelName,
            // For dynamic channel families (e.g. scope('rooms', /^room:.+$/))
            // the family key lives in scope.channelScope. Forward it so peer
            // sends resolve the channel family rather than failing the
            // outgoing-event check against a non-existent static channel.
            channelScope: scope.channelScope,
            excludeSelf: true,
          },
          connection.id,
        );
      }
      runtime.sendThroughPipeline(
        connection,
        {
          namespace: scope.namespace?.name,
          channel: scope.channelName,
          channelScope: scope.channelScope,
          streamId,
        },
        event,
        result.value,
      );

      nextInput = stream.stream.nudges.length > 0 ? [...activeStream.nudges] : undefined;
      activeStream.nudges.length = 0;
    }

    if (!activeStream.closed) {
      runtime.sendProtocolMessage(connection, '_streamEnd', {
        _streamId: streamId,
        ...(scope.namespace?.name ? { _namespace: scope.namespace.name } : {}),
        ...(scope.channelName ? { _channel: scope.channelName } : {}),
        ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
      });
    }
  } catch (streamError) {
    const routing = {
      _streamId: streamId,
      ...(scope.namespace?.name ? { _namespace: scope.namespace.name } : {}),
      ...(scope.channelName ? { _channel: scope.channelName } : {}),
      ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
    };

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
      runtime.sendProtocolMessage(connection, '_error', { code: InternalError.code, ...routing });
    } else {
      await runtime.handleRuntimeError(connection, streamError, event, routing);
    }
  } finally {
    connection.activeStreamIds?.delete(streamId);
    runtime.activeStreams.delete(streamId);
    runtime.persistAttachment(connection);
  }
}
