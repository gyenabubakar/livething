import { CloseCodes } from '@wskit/core';
import type {
  ConnectionDescriptor,
  ConnectionHandle,
  UpgradeDecision,
} from '~/_engine/adapter/types.ts';
import type { CompiledChannel, CompiledServer } from '~/_engine/compile/types.ts';
import type { ResolvedScope, RuntimeConnection } from './types.ts';

/**
 * Internal dependency bag for connection-focused runtime helpers.
 */
interface ConnectionRuntime {
  compiled: CompiledServer;
  timers?: { clearTimeout(handle: unknown): void; setTimeout(fn: () => void, ms: number): unknown };
  connections: Map<string, RuntimeConnection>;
  wsToConnectionId: Map<unknown, string>;
  generateId(prefix?: string): string;
  persistAttachment(connection: RuntimeConnection): void;
  buildConnectionContext(
    connection: RuntimeConnection,
    scope?: ResolvedScope,
  ): Record<PropertyKey, unknown>;
  runConnectionLifecycle(
    kind: 'connect' | 'disconnect',
    ctx: Record<PropertyKey, unknown>,
  ): Promise<void>;
  processTextMessage(connection: RuntimeConnection, data: string): Promise<void>;
  handleBinaryMessage(connection: RuntimeConnection, data: ArrayBuffer): Promise<void>;
  handleConnectionClose(connection: RuntimeConnection, code: number, reason: string): Promise<void>;
  handleRuntimeError(connection: RuntimeConnection, error: unknown, event?: string): Promise<void>;
}

/**
 * Install or refresh the idle timeout for one connection.
 */
export function installHeartbeat(
  runtime: Pick<ConnectionRuntime, 'compiled' | 'timers'>,
  connection: RuntimeConnection,
): void {
  if (!runtime.compiled.heartbeatTimeout || !runtime.timers) return;
  if (connection.heartbeatTimer !== undefined) {
    runtime.timers.clearTimeout(connection.heartbeatTimer);
  }
  connection.heartbeatTimer = runtime.timers.setTimeout(() => {
    connection.descriptor.close(CloseCodes.IDLE, 'Heartbeat timeout');
  }, runtime.compiled.heartbeatTimeout);
}

/**
 * Reset the heartbeat timer after activity from the connection.
 */
export function refreshHeartbeat(
  runtime: Pick<ConnectionRuntime, 'compiled' | 'timers'>,
  connection: RuntimeConnection,
): void {
  installHeartbeat(runtime, connection);
}

function createHandle(runtime: ConnectionRuntime, connection: RuntimeConnection): ConnectionHandle {
  return {
    handleMessage: (data) => {
      void runtime.processTextMessage(connection, data);
    },
    handleBinary: (data) => {
      void runtime.handleBinaryMessage(connection, data);
    },
    handleClose: (code, reason) => {
      void runtime.handleConnectionClose(connection, code, reason);
    },
    handleError: (error) => {
      void runtime.handleRuntimeError(connection, error, undefined);
    },
  };
}

/**
 * Run connect/disconnect hooks for both the handler and installed modules.
 */
export async function runConnectionLifecycle(
  runtime: {
    connectHooks: readonly ((ctx: Record<PropertyKey, unknown>) => void | Promise<void>)[];
    disconnectHooks: readonly ((ctx: Record<PropertyKey, unknown>) => void | Promise<void>)[];
    moduleRuntimes: readonly {
      instance: { id: string };
      onConnect?: (ctx: Record<PropertyKey, unknown>) => void | Promise<void>;
      onDisconnect?: (ctx: Record<PropertyKey, unknown>) => void | Promise<void>;
    }[];
    activeConnectionState: { current?: string };
    createModuleScopedContext(
      moduleId: string,
      ctx: Record<PropertyKey, unknown>,
    ): Record<PropertyKey, unknown>;
  },
  kind: 'connect' | 'disconnect',
  ctx: Record<PropertyKey, unknown>,
): Promise<void> {
  runtime.activeConnectionState.current = String(ctx.id);

  if (kind === 'connect') {
    for (const hook of runtime.connectHooks) {
      await hook(ctx);
    }
    for (const moduleRuntime of runtime.moduleRuntimes) {
      if (moduleRuntime.onConnect) {
        await moduleRuntime.onConnect(
          runtime.createModuleScopedContext(moduleRuntime.instance.id, ctx),
        );
      }
    }
  } else {
    for (const hook of runtime.disconnectHooks) {
      await hook(ctx);
    }
    for (const moduleRuntime of runtime.moduleRuntimes) {
      if (moduleRuntime.onDisconnect) {
        await moduleRuntime.onDisconnect(
          runtime.createModuleScopedContext(moduleRuntime.instance.id, ctx),
        );
      }
    }
  }

  runtime.activeConnectionState.current = undefined;
}

/**
 * Stop and forget any active streams owned by a connection that is going away.
 */
export async function cancelActiveStreamsForConnection(
  runtime: {
    activeStreams: Map<
      string,
      {
        id: string;
        connectionId: string;
        generator: AsyncGenerator<unknown, void, unknown>;
        closed: boolean;
      }
    >;
  },
  connectionId: string,
): Promise<void> {
  for (const activeStream of [...runtime.activeStreams.values()]) {
    if (activeStream.connectionId !== connectionId) continue;
    activeStream.closed = true;
    try {
      await activeStream.generator.return(undefined);
    } finally {
      runtime.activeStreams.delete(activeStream.id);
    }
  }
}

/**
 * Perform full close cleanup for a connection, including lifecycle hooks and
 * channel leaves.
 */
export async function handleConnectionClose(
  runtime: Pick<ConnectionRuntime, 'compiled' | 'connections' | 'wsToConnectionId' | 'timers'> & {
    cancelActiveStreamsForConnection(connectionId: string): Promise<void>;
    buildConnectionContext(
      connection: RuntimeConnection,
      scope?: ResolvedScope,
    ): Record<PropertyKey, unknown>;
    runConnectionLifecycle(
      kind: 'connect' | 'disconnect',
      ctx: Record<PropertyKey, unknown>,
    ): Promise<void>;
    leaveChannel(
      connection: RuntimeConnection,
      scope: { channel?: CompiledChannel; channelName: string },
    ): Promise<void>;
  },
  connection: RuntimeConnection,
): Promise<void> {
  await runtime.cancelActiveStreamsForConnection(connection.id);

  const ctx = runtime.buildConnectionContext(connection);
  await runtime.runConnectionLifecycle('disconnect', ctx);

  for (const channelName of [...connection.channels]) {
    const resolved = runtime.compiled.channels.get(channelName);
    await runtime.leaveChannel(connection, {
      channel: resolved,
      channelName,
    });
  }

  if (connection.heartbeatTimer !== undefined && runtime.timers) {
    runtime.timers.clearTimeout(connection.heartbeatTimer);
  }

  runtime.connections.delete(connection.id);
  runtime.wsToConnectionId.delete(connection.wsKey);
}

/**
 * Route binary frames into the optional binary lifecycle hook.
 */
export async function handleBinaryMessage(
  runtime: Pick<ConnectionRuntime, 'buildConnectionContext'> & {
    binaryHooks: readonly ((
      ctx: Record<PropertyKey, unknown>,
      data: ArrayBuffer,
    ) => void | Promise<void>)[];
    refreshHeartbeat(connection: RuntimeConnection): void;
  },
  connection: RuntimeConnection,
  data: ArrayBuffer,
): Promise<void> {
  runtime.refreshHeartbeat(connection);
  if (runtime.binaryHooks.length === 0) return;
  const ctx = runtime.buildConnectionContext(connection);
  for (const hook of runtime.binaryHooks) {
    await hook(ctx, data);
  }
}

/**
 * Create runtime state for a newly accepted connection and return the adapter
 * callbacks that feed events into the engine.
 */
export function acceptConnection(
  runtime: ConnectionRuntime,
  wsKey: unknown,
  descriptor: ConnectionDescriptor,
): ConnectionHandle {
  const connection: RuntimeConnection = {
    id: runtime.generateId('conn'),
    wsKey,
    descriptor,
    meta: descriptor.meta ?? {},
    tags: new Set(descriptor.tags ?? []),
    channels: new Set(),
    latency: null,
    quality: 'good',
  };

  runtime.connections.set(connection.id, connection);
  runtime.wsToConnectionId.set(wsKey, connection.id);
  runtime.persistAttachment(connection);
  installHeartbeat(runtime, connection);

  const ctx = runtime.buildConnectionContext(connection);
  void runtime.runConnectionLifecycle('connect', ctx);

  return createHandle(runtime, connection);
}

/**
 * Recreate a connection handle after an adapter wakes a hibernated socket.
 */
export function wakeHibernatedConnection(
  runtime: ConnectionRuntime,
  wsKey: unknown,
): ConnectionHandle {
  const existingId = runtime.wsToConnectionId.get(wsKey);
  if (existingId) {
    const existing = runtime.connections.get(existingId)!;
    return createHandle(runtime, existing);
  }

  const wsLike = wsKey as {
    send?(data: string | ArrayBuffer | ArrayBufferView): void;
    close?(code?: number, reason?: string): void;
    serializeAttachment?(value: unknown): void;
    deserializeAttachment?(): unknown;
  };
  const attachment =
    typeof wsLike.deserializeAttachment === 'function' ? wsLike.deserializeAttachment() : {};
  const restored =
    attachment && typeof attachment === 'object' ? (attachment as Record<string, unknown>) : {};

  const descriptor: ConnectionDescriptor = {
    send: (data) => wsLike.send?.(data),
    sendBinary: (data) => wsLike.send?.(data),
    close: (code, reason) => wsLike.close?.(code, reason),
    bufferedAmount: () => 0,
    meta: (restored.meta as Record<string, unknown>) ?? {},
    tags: (restored.tags as string[]) ?? [],
  };
  const connection: RuntimeConnection = {
    id: typeof restored.id === 'string' ? restored.id : runtime.generateId('conn'),
    wsKey,
    descriptor,
    meta: (restored.meta as Record<string, unknown>) ?? {},
    tags: new Set((restored.tags as string[]) ?? []),
    channels: new Set((restored.channels as string[]) ?? []),
    latency: null,
    quality: 'good',
  };

  runtime.connections.set(connection.id, connection);
  runtime.wsToConnectionId.set(wsKey, connection.id);
  runtime.persistAttachment(connection);
  installHeartbeat(runtime, connection);

  return createHandle(runtime, connection);
}

/**
 * Run the optional upgrade hook and normalize its result into adapter-friendly
 * accept/reject data.
 */
export async function handleUpgrade(
  runtime: {
    upgradeHooks: readonly ((request: Request) =>
      | { meta?: Record<string, unknown>; tags?: readonly string[] }
      | Promise<{
          meta?: Record<string, unknown>;
          tags?: readonly string[];
        }>)[];
  },
  request: Request,
): Promise<UpgradeDecision> {
  if (runtime.upgradeHooks.length === 0) {
    return {};
  }

  try {
    let result: { meta?: Record<string, unknown>; tags?: readonly string[] } = {};
    for (const hook of runtime.upgradeHooks) {
      result = await hook(request);
    }
    return { meta: result.meta, tags: result.tags };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { __wskit?: string }).__wskit === 'reject-upgrade'
    ) {
      return {
        reject: true,
        code: (error as { code: number }).code,
        reason: (error as { reason: string }).reason,
      };
    }

    return {
      reject: true,
      code: 500,
      reason: 'Upgrade failed',
    };
  }
}

/**
 * Shut down the engine, module hooks, active streams, and open connections.
 */
export async function handleShutdown(
  runtime: Pick<ConnectionRuntime, 'connections' | 'timers'> & {
    shutdownHooks: readonly ((ctx: unknown) => void | Promise<void>)[];
    moduleRuntimes: readonly { onShutdown?: () => void | Promise<void> }[];
    createShutdownContext(): unknown;
    cancelActiveStreamsForConnection(connectionId: string): Promise<void>;
    alarmState: { current: unknown | null };
  },
): Promise<void> {
  for (const hook of runtime.shutdownHooks) {
    await hook(runtime.createShutdownContext());
  }

  for (const moduleRuntime of runtime.moduleRuntimes) {
    if (moduleRuntime.onShutdown) await moduleRuntime.onShutdown();
  }

  for (const connection of [...runtime.connections.values()]) {
    await runtime.cancelActiveStreamsForConnection(connection.id);
  }

  for (const connection of runtime.connections.values()) {
    connection.descriptor.close(CloseCodes.GOING_AWAY, 'Server shutting down');
  }

  if (runtime.alarmState.current !== null && runtime.timers) {
    runtime.timers.clearTimeout(runtime.alarmState.current);
    runtime.alarmState.current = null;
  }
}
