import { CloseCodes, InternalError } from '@wskit/core';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as HeartbeatPrimitive from '~/heartbeat/runtime.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from './types.ts';

/**
 * Minimal subset of the WebSocket-like object the engine wraps on wake. The
 * descriptor uses `send` and `close` to drive the underlying socket; the
 * per-connection snapshot is loaded via `runtime.restoreAttachment(wsKey)`,
 * which routes through the adapter's hibernation API.
 */
interface HibernatableWebSocket {
  send?(data: string | ArrayBuffer | ArrayBufferView): void;
  close?(code?: number, reason?: string): void;
}

/**
 * Internal dependency bag for connection-focused runtime helpers.
 */
interface ConnectionRuntime {
  compiled: EngineCompileTypes.CompiledServer;
  timers?: { clearTimeout(handle: unknown): void; setTimeout(fn: () => void, ms: number): unknown };
  connections: Map<string, EngineRuntimeTypes.RuntimeConnection>;
  wsToConnectionId: Map<unknown, string>;
  generateId(prefix?: string): string;
  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;
  /**
   * Adapter-provided snapshot restore. Returns the value the adapter most
   * recently passed to `persist(wsKey, snapshot)`, or `undefined` if there is
   * nothing to restore. Adapters without hibernation support omit this field.
   */
  restoreAttachment?(wsKey: unknown): unknown;
  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Record<PropertyKey, unknown>;
  runConnectionLifecycle(
    kind: 'connect' | 'disconnect',
    ctx: Record<PropertyKey, unknown>,
  ): Promise<void>;
  processTextMessage(connection: EngineRuntimeTypes.RuntimeConnection, data: string): Promise<void>;
  handleBinaryMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    data: ArrayBuffer,
  ): Promise<void>;
  handleConnectionClose(
    connection: EngineRuntimeTypes.RuntimeConnection,
    code: number,
    reason: string,
  ): Promise<void>;
  handleRuntimeError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    error: unknown,
    event?: string,
  ): Promise<void>;
}

/** Wrap a `RuntimeConnection` into the `ConnectionHandle` callbacks the adapter uses. */
function createHandle(
  runtime: ConnectionRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
): EngineAdapterTypes.ConnectionHandle {
  async function waitForLifecycle(): Promise<void> {
    await connection.lifecycleReady;
  }

  return {
    handleMessage: async (data) => {
      await waitForLifecycle();
      return runtime.processTextMessage(connection, data);
    },
    handleBinary: async (data) => {
      await waitForLifecycle();
      return runtime.handleBinaryMessage(connection, data);
    },
    handleClose: async (code, reason) => {
      await waitForLifecycle();
      return runtime.handleConnectionClose(connection, code, reason);
    },
    handleError: async (error) => {
      await waitForLifecycle();
      return runtime.handleRuntimeError(connection, error, undefined);
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
  const previous = runtime.activeConnectionState.current;
  runtime.activeConnectionState.current = String(ctx.id);

  try {
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
  } finally {
    runtime.activeConnectionState.current = previous;
  }
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
    logger?: { error(message: string, fields?: Record<string, unknown>): void };
  },
  connectionId: string,
): Promise<void> {
  for (const activeStream of [...runtime.activeStreams.values()]) {
    if (activeStream.connectionId !== connectionId) continue;
    activeStream.closed = true;
    try {
      // A user-supplied generator may throw from its `finally` block. Log
      // and move on — the rest of connection-close cleanup (running
      // disconnect hooks, leaving channels, clearing timers, deleting the
      // connection from the runtime maps) must still happen even when one
      // stream's teardown blows up.
      await activeStream.generator.return(undefined);
    } catch (error) {
      runtime.logger?.error('[wskit] stream cleanup threw on connection close', {
        streamId: activeStream.id,
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
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
      connection: EngineRuntimeTypes.RuntimeConnection,
      scope?: EngineRuntimeTypes.ResolvedScope,
    ): Record<PropertyKey, unknown>;
    runConnectionLifecycle(
      kind: 'connect' | 'disconnect',
      ctx: Record<PropertyKey, unknown>,
    ): Promise<void>;
    leaveChannel(
      connection: EngineRuntimeTypes.RuntimeConnection,
      scope: {
        channel?: EngineCompileTypes.CompiledChannel;
        channelName: string;
        channelScope: string | null;
      },
    ): Promise<void>;
    logger?: { error(message: string, fields?: Record<string, unknown>): void };
  },
  connection: EngineRuntimeTypes.RuntimeConnection,
): Promise<void> {
  await runtime.cancelActiveStreamsForConnection(connection.id);

  runtime.connections.delete(connection.id);
  runtime.wsToConnectionId.delete(connection.wsKey);

  const ctx = runtime.buildConnectionContext(connection);
  try {
    // A user-supplied onDisconnect hook (or a module's onDisconnect) may
    // throw. Contain the throw so the rest of the close cleanup —
    // channel leaves (which broadcast `_memberLeave` to peers), heartbeat
    // timer teardown — still runs. Otherwise channel members never see
    // the leave and timers leak.
    await runtime.runConnectionLifecycle('disconnect', ctx);
    /* oxlint-disable-next-line @typescript-eslint/no-unused-vars */
  } catch (error) {
    runtime.logger?.error('[wskit] disconnect lifecycle hook threw', {
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (const membership of ChannelPrimitive.listChannelMemberships(connection)) {
    const resolved = ChannelPrimitive.resolveCompiledChannel(
      runtime.compiled,
      membership.channelName,
      membership.channelScope,
    );
    await runtime.leaveChannel(connection, {
      channel: resolved,
      channelName: membership.channelName,
      channelScope: membership.channelScope,
    });
  }

  if (connection.heartbeatTimer !== undefined && runtime.timers) {
    runtime.timers.clearTimeout(connection.heartbeatTimer);
    connection.heartbeatTimer = undefined;
  }

  HeartbeatPrimitive.stopConnectionPing(runtime.timers, connection);
}

/**
 * Route binary frames into the optional binary lifecycle hook.
 *
 * A throw from any hook is routed through the engine's runtime-error path
 * so the client gets `_error` and `onError` hooks fire — the same shape
 * text-message handlers already follow. The first throw stops the
 * remaining binary hooks for this frame.
 */
export async function handleBinaryMessage(
  runtime: Pick<ConnectionRuntime, 'buildConnectionContext' | 'handleRuntimeError'> & {
    activityHooks: readonly ((connectionId: string) => void | Promise<void>)[];
    binaryHooks: readonly ((
      ctx: Record<PropertyKey, unknown>,
      data: ArrayBuffer,
    ) => void | Promise<void>)[];
  },
  connection: EngineRuntimeTypes.RuntimeConnection,
  data: ArrayBuffer,
): Promise<void> {
  for (const hook of runtime.activityHooks) {
    await hook(connection.id);
  }
  if (runtime.binaryHooks.length === 0) return;
  const ctx = runtime.buildConnectionContext(connection);
  for (const hook of runtime.binaryHooks) {
    try {
      await hook(ctx, data);
    } catch (error) {
      await runtime.handleRuntimeError(connection, error, undefined);
      return;
    }
  }
}

/**
 * Create runtime state for a newly accepted connection and return the adapter
 * callbacks that feed events into the engine.
 */
export function acceptConnection(
  runtime: ConnectionRuntime,
  wsKey: unknown,
  descriptor: EngineAdapterTypes.ConnectionDescriptor,
): EngineAdapterTypes.ConnectionHandle {
  const connection: EngineRuntimeTypes.RuntimeConnection = {
    id: runtime.generateId('conn'),
    wsKey,
    descriptor,
    meta: descriptor.meta ?? {},
    tags: new Set(descriptor.tags ?? []),
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };

  runtime.connections.set(connection.id, connection);
  runtime.wsToConnectionId.set(wsKey, connection.id);
  runtime.persistAttachment(connection);

  if (runtime.timers) {
    HeartbeatPrimitive.scheduleConnectionPing(runtime.timers, connection);
  }

  const ctx = runtime.buildConnectionContext(connection);
  // lifecycleReady swallows handler errors into handleRuntimeError; if handleRuntimeError itself throws, the rejection is unhandled — acceptable because that path is fatal anyway.
  connection.lifecycleReady = runtime
    .runConnectionLifecycle('connect', ctx)
    .catch((error) => runtime.handleRuntimeError(connection, error, undefined));

  return createHandle(runtime, connection);
}

function restoreChannelMemberships(
  restored: Record<string, unknown>,
): Map<string, { channelName: string; channelScope: string | null }> {
  const memberships = new Map<string, { channelName: string; channelScope: string | null }>();

  if (Array.isArray(restored.channelMemberships)) {
    for (const membership of restored.channelMemberships) {
      if (!membership || typeof membership !== 'object') continue;

      const channelName =
        typeof (membership as { channelName?: unknown }).channelName === 'string'
          ? (membership as { channelName: string }).channelName
          : undefined;

      if (!channelName) continue;

      const channelScope: string | null =
        typeof (membership as { channelScope?: unknown }).channelScope === 'string'
          ? (membership as { channelScope: string }).channelScope
          : null;

      memberships.set(ChannelPrimitive.createChannelMembershipKey(channelName, channelScope), {
        channelName,
        channelScope,
      });
    }
  }

  return memberships;
}

/**
 * Recreate a connection handle after an adapter wakes a hibernated socket.
 */
export function wakeHibernatedConnection(
  runtime: ConnectionRuntime,
  wsKey: unknown,
): EngineAdapterTypes.ConnectionHandle {
  const existingId = runtime.wsToConnectionId.get(wsKey);
  if (existingId) {
    const existing = runtime.connections.get(existingId)!;
    return createHandle(runtime, existing);
  }

  const wsLike = wsKey as HibernatableWebSocket;
  const attachment = runtime.restoreAttachment ? runtime.restoreAttachment(wsKey) : undefined;
  const restored =
    attachment && typeof attachment === 'object' ? (attachment as Record<string, unknown>) : {};
  const channelMemberships = restoreChannelMemberships(restored);

  const restoredStreamIds = Array.isArray(restored.activeStreamIds)
    ? (restored.activeStreamIds as string[])
    : [];

  const descriptor: EngineAdapterTypes.ConnectionDescriptor = {
    send: (data) => wsLike.send?.(data),
    sendBinary: (data) => wsLike.send?.(data),
    close: (code, reason) => wsLike.close?.(code, reason),
    bufferedAmount: () => 0,
    meta: (restored.meta as Record<string, unknown>) ?? {},
    tags: (restored.tags as string[]) ?? [],
  };

  for (const streamId of restoredStreamIds) {
    descriptor.send(
      JSON.stringify({
        event: '_error',
        payload: { code: InternalError.code, _streamId: streamId },
      }),
    );
  }

  const connection: EngineRuntimeTypes.RuntimeConnection = {
    id: typeof restored.id === 'string' ? restored.id : runtime.generateId('conn'),
    wsKey,
    descriptor,
    meta: (restored.meta as Record<string, unknown>) ?? {},
    tags: new Set((restored.tags as string[]) ?? []),
    channelMemberships,
    latency: null,
    quality: 'good',
  };

  runtime.connections.set(connection.id, connection);
  runtime.wsToConnectionId.set(wsKey, connection.id);
  runtime.persistAttachment(connection);

  if (runtime.timers) {
    HeartbeatPrimitive.scheduleConnectionPing(runtime.timers, connection);
  }

  connection.lifecycleReady = Promise.resolve();

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
): Promise<EngineAdapterTypes.UpgradeDecision> {
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
