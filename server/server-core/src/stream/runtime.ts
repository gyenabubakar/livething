/* oxlint-disable @typescript-eslint/no-explicit-any */
import { validateValue } from '~/_engine/compile/utils.ts';
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
    options?: { namespace?: string; channel?: string; excludeSelf?: boolean },
    excludeConnectionId?: string,
  ): void;
  connections: Map<string, RuntimeConnection>;
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
    await runtime.handleValidationError(connection, event, error);
    return false;
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

  runtime.setActiveConnectionId(connection.id);
  const iterator = stream.generator(ctx, payload);
  runtime.setActiveConnectionId(undefined);

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

  try {
    let nextInput: unknown = stream.stream.nudges.length > 0 ? [] : undefined;

    while (!activeStream.closed) {
      const result = await iterator.next(nextInput);
      if (result.done) break;

      if (stream.stream.broadcast) {
        runtime.broadcastToConnections(
          [...runtime.connections.values()],
          event,
          result.value,
          {
            namespace: scope.namespace?.name,
            channel: scope.channelName,
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
    await runtime.handleRuntimeError(connection, streamError, event, {
      _streamId: streamId,
      ...(scope.namespace?.name ? { _namespace: scope.namespace.name } : {}),
      ...(scope.channelName ? { _channel: scope.channelName } : {}),
      ...(scope.channelScope ? { _channelScope: scope.channelScope } : {}),
    });
  } finally {
    runtime.activeStreams.delete(streamId);
  }
}
