import * as EngineCompileUtils from '~/_engine/compile/utils.ts';
import * as DefineModule from '~/modules/define.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import * as EngineContextTypes from './types.ts';

/**
 * Build the context passed to the `onInit` lifecycle hook.
 */
export function createInitContext(
  deps: Pick<
    EngineContextTypes.CreateTaskContextDeps,
    'env' | 'logger' | 'platform' | 'requireStorage'
  >,
): EngineContextTypes.InitContext<Record<string, unknown>, unknown> {
  const storage = deps.requireStorage();
  return {
    sql: storage.sql,
    kv: storage.kv,
    env: deps.env,
    log: deps.logger,
    platform: deps.platform,
  };
}

/**
 * Build the context passed to the shutdown hook.
 */
export function createShutdownContext(
  deps: EngineContextTypes.CreateTaskContextDeps,
): EngineContextTypes.ShutdownContext<Record<string, unknown>, Record<string, unknown>, unknown> {
  const storage = deps.requireStorage();
  function cancelScheduled(taskId: string, filter?: Record<string, unknown>): void {
    const result = deps.cancelScheduled(taskId, filter);
    if (result.removed === 0) {
      deps.logger.error('[wskit] cancelScheduled matched no runs', {
        taskId,
        filter,
        taskExists: result.taskExists,
      });
    }
  }
  return {
    closeAll: (code, reason) => {
      for (const connection of deps.connections.values()) {
        connection.descriptor.close(code, reason);
      }
    },
    broadcast: (event, payload, options) => {
      deps.broadcastToConnections([...deps.connections.values()], event, payload, options);
    },
    sql: storage.sql,
    kv: storage.kv,
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled,
    connectionCount: deps.connections.size,
    getConnections: () => {
      return [...deps.connections.values()].map((connection) => deps.toConnectionInfo(connection));
    },
    getConnectionsByTag: (tag) => {
      return [...deps.connections.values()]
        .filter((connection) => connection.tags.has(tag))
        .map((connection) => deps.toConnectionInfo(connection));
    },
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,
  };
}

/**
 * Build the context passed to scheduled tasks and module-owned scheduled work.
 */
export function createTaskContext(
  deps: EngineContextTypes.CreateTaskContextDeps,
): EngineContextTypes.TaskContext<Record<string, unknown>, Record<string, unknown>, unknown> {
  const storage = deps.requireStorage();
  const ctx: EngineContextTypes.TaskContext<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown
  > = {
    sql: storage.sql,
    kv: storage.kv,
    broadcast: (event, payload, options) => {
      deps.broadcastToConnections([...deps.connections.values()], event, payload, options);
    },
    sendTo: (tag, event, payload) => {
      for (const connection of deps.connections.values()) {
        if (connection.tags.has(tag)) {
          deps.sendThroughPipeline(connection, undefined, event, payload);
        }
      }
    },
    sendToConnection: (connectionId, event, payload) => {
      const connection = deps.connections.get(connectionId);
      if (!connection) {
        deps.logger.error('[wskit] sendToConnection target not found', {
          connectionId,
          event,
        });
        return false;
      }
      deps.sendThroughPipeline(connection, undefined, event, payload);
      return true;
    },
    getConnections: () => {
      return [...deps.connections.values()].map((connection) => deps.toConnectionInfo(connection));
    },
    getConnectionsByTag: (tag) => {
      return [...deps.connections.values()]
        .filter((connection) => connection.tags.has(tag))
        .map((connection) => deps.toConnectionInfo(connection));
    },
    connectionCount: deps.connections.size,
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled: (taskId, filter) => {
      const result = deps.cancelScheduled(taskId, filter);
      if (result.removed === 0) {
        deps.logger.error('[wskit] cancelScheduled matched no runs', {
          taskId,
          filter,
          taskExists: result.taskExists,
        });
      }
    },
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,
  };

  deps.attachModuleApis(ctx as unknown as Record<PropertyKey, unknown>, undefined);
  return ctx;
}

type MessagingDeps = Pick<
  EngineContextTypes.BuildConnectionContextDeps,
  'broadcastToConnections' | 'connections' | 'logger' | 'sendThroughPipeline'
>;

/** Build the top-level send/broadcast/close messaging surface for a connection ctx. */
function buildMessagingApi(
  connection: EngineContextTypes.RuntimeConnection,
  deps: MessagingDeps,
): Pick<
  EngineContextTypes.ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown>,
  'broadcast' | 'broadcastBinary' | 'close' | 'send' | 'sendBinary' | 'sendTo' | 'sendToConnection'
> {
  return {
    send: (event, payload) => deps.sendThroughPipeline(connection, undefined, event, payload),
    broadcast: (event, payload, options) => {
      deps.broadcastToConnections(
        [...deps.connections.values()],
        event,
        payload,
        options,
        connection.id,
      );
    },
    sendTo: (tag, event, payload) => {
      for (const target of deps.connections.values()) {
        if (target.tags.has(tag)) {
          deps.sendThroughPipeline(target, undefined, event, payload);
        }
      }
    },
    sendToConnection: (connectionId, event, payload) => {
      const target = deps.connections.get(connectionId);
      if (!target) {
        deps.logger.error('[wskit] sendToConnection target not found', {
          connectionId,
          event,
        });
        return false;
      }
      deps.sendThroughPipeline(target, undefined, event, payload);
      return true;
    },
    sendBinary: (data) => {
      connection.descriptor.sendBinary(data);
      return true;
    },
    broadcastBinary: (data, options) => {
      for (const target of deps.connections.values()) {
        if (options?.excludeSelf && target.id === connection.id) continue;
        target.descriptor.sendBinary(data);
      }
    },
    close: (code, reason) => connection.descriptor.close(code, reason),
  };
}

type ChannelsApiDeps = Pick<
  EngineContextTypes.BuildConnectionContextDeps,
  'getChannelMembers' | 'kickChannelMembers'
>;

/** Build the `ctx.channels` helper surface (members/kick). */
function buildChannelsApi(
  _connection: EngineContextTypes.RuntimeConnection,
  deps: ChannelsApiDeps,
): EngineContextTypes.ConnectionContext<
  Record<string, unknown>,
  Record<string, unknown>,
  unknown
>['channels'] {
  return {
    members: (name) => deps.getChannelMembers(name),
    kick: (channelNameToKick, tag, reason) => {
      deps.kickChannelMembers(channelNameToKick, tag, reason);
    },
  };
}

type ScopeExtrasDeps = Pick<
  EngineContextTypes.BuildConnectionContextDeps,
  'broadcastToChannel' | 'broadcastToConnections' | 'connections' | 'sendThroughPipeline'
>;

/** Attach scope-bound `ctx.namespace` / `ctx.channel` helpers when a scope is active. */
function buildScopeExtras(
  connection: EngineContextTypes.RuntimeConnection,
  scope:
    | {
        namespace?: EngineContextTypes.CompiledNamespace;
        channel?: EngineContextTypes.CompiledChannel;
        channelName?: string;
        channelScope?: string;
      }
    | undefined,
  deps: ScopeExtrasDeps,
): { namespace?: unknown; channel?: unknown } {
  const extras: { namespace?: unknown; channel?: unknown } = {};

  if (scope?.namespace) {
    const namespace = scope.namespace;
    extras.namespace = {
      name: namespace.name,
      send: (event: string, payload: unknown) => {
        return deps.sendThroughPipeline(connection, { namespace: namespace.name }, event, payload);
      },
      broadcast: (event: string, payload: unknown) => {
        deps.broadcastToConnections(
          [...deps.connections.values()],
          event,
          payload,
          { namespace: namespace.name },
          connection.id,
        );
      },
    };
  }

  if (scope?.channel) {
    const channel = scope.channel;
    const channelName =
      scope.channelName ?? (typeof channel.pattern === 'string' ? channel.pattern : '');
    const channelScope = scope.channelScope;
    extras.channel = {
      name: channelName,
      send: (event: string, payload: unknown) => {
        return deps.sendThroughPipeline(
          connection,
          { channel: channelName, channelScope },
          event,
          payload,
        );
      },
      broadcast: (event: string, payload: unknown) => {
        deps.broadcastToChannel(channelName, event, payload, connection.id, channelScope);
      },
    };
  }

  return extras;
}

/**
 * Build the per-connection handler context.
 *
 * Top-level send/broadcast live on the root object. Scoped namespace/channel
 * APIs are attached under `ctx.namespace` and `ctx.channel`.
 */
export function buildConnectionContext(
  deps: EngineContextTypes.BuildConnectionContextDeps,
  connection: EngineContextTypes.RuntimeConnection,
  scope?: {
    namespace?: EngineContextTypes.CompiledNamespace;
    channel?: EngineContextTypes.CompiledChannel;
    channelName?: string;
    channelScope?: string;
  },
): EngineContextTypes.ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown> &
  Record<PropertyKey, unknown> {
  const storage = deps.requireStorage();
  function cancelScheduled(taskId: string, filter?: Record<string, unknown>): void {
    const result = deps.cancelScheduled(taskId, filter);
    if (result.removed === 0) {
      deps.logger.error('[wskit] cancelScheduled matched no runs', {
        taskId,
        filter,
        taskExists: result.taskExists,
      });
    }
  }
  const base: EngineContextTypes.ConnectionContext<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown
  > &
    Record<PropertyKey, unknown> = {
    [EngineContextTypes.ENGINE_SCOPE_META]: {
      namespaceName: scope?.namespace?.name,
      channelName: scope?.channelName,
      channelScope: scope?.channelScope ?? scope?.channel?.key,
    } satisfies EngineContextTypes.EngineScopeMeta,
    id: connection.id,
    meta: connection.meta,
    tags: [...connection.tags],
    tag: (label) => {
      connection.tags.add(label);
      deps.persistAttachment(connection);
    },
    untag: (label) => {
      connection.tags.delete(label);
      deps.persistAttachment(connection);
    },
    ...buildMessagingApi(connection, deps),
    getConnections: () => {
      return [...deps.connections.values()].map((target) => deps.toConnectionInfo(target));
    },
    getConnectionsByTag: (tag) => {
      return [...deps.connections.values()]
        .filter((target) => target.tags.has(tag))
        .map((target) => deps.toConnectionInfo(target));
    },
    connectionCount: deps.connections.size,
    bufferedAmount: connection.descriptor.bufferedAmount(),
    latency: connection.latency,
    quality: connection.quality,
    channels: buildChannelsApi(connection, deps),
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled,
    setAlarm: (time) => {
      const timers = deps.requireTimers();
      if (timers.setAlarm) {
        void timers.setAlarm(time);
      }
    },
    sql: storage.sql,
    kv: storage.kv,
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,
  };

  const scopeExtras = buildScopeExtras(connection, scope, deps);
  if (scopeExtras.namespace) base.namespace = scopeExtras.namespace as typeof base.namespace;
  if (scopeExtras.channel) base.channel = scopeExtras.channel as typeof base.channel;

  for (const extend of deps.contextExtenders ?? []) {
    Object.assign(base, extend(base));
  }

  deps.attachModuleApis(base, connection);
  return base;
}

/**
 * Wrap a context so module event helpers automatically prefix their event names.
 *
 * Modules declare outgoing events with short names (e.g. `'flushed'`), but on
 * the wire they become `'__acme:analytics:flushed'`. This Proxy intercepts
 * `send`, `broadcast`, `sendTo`, and `sendToConnection` and prepends the
 * module's ID before delegating to the real context method.
 */
export function createModuleScopedContext(
  moduleId: string,
  ctx: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  function prefix(event: string): string {
    return EngineCompileUtils.prefixedModuleEvent(moduleId, event);
  }

  // Proxy traps only the four send-like methods. Everything else (meta, sql,
  // log, etc.) passes through to the underlying connection context unchanged.
  return new Proxy(ctx, {
    get(target, key, receiver) {
      switch (key) {
        case 'send':
          return wrapPrefixedSend(target, receiver, 'send', prefix, 'event-first');
        case 'broadcast':
          return wrapPrefixedSend(target, receiver, 'broadcast', prefix, 'event-first');
        case 'sendTo':
          return wrapPrefixedSend(target, receiver, 'sendTo', prefix, 'event-second');
        case 'sendToConnection':
          return wrapPrefixedSend(target, receiver, 'sendToConnection', prefix, 'event-second');
        default:
          return Reflect.get(target, key, receiver);
      }
    },
  });
}

/**
 * Build a wrapper around one of the four send-like methods on a connection
 * context. The wrapper rewrites the `event` argument through `prefix` and
 * forwards every other argument unchanged.
 *
 * `position` says which positional arg holds the event name:
 *   - `event-first`  → `(event, payload, ...rest)` (e.g. `send`, `broadcast`)
 *   - `event-second` → `(target, event, payload)` (e.g. `sendTo`, `sendToConnection`)
 */
function wrapPrefixedSend(
  target: Record<PropertyKey, unknown>,
  receiver: unknown,
  key: 'send' | 'broadcast' | 'sendTo' | 'sendToConnection',
  prefix: (event: string) => string,
  position: 'event-first' | 'event-second',
): (...args: unknown[]) => unknown {
  const original = Reflect.get(target, key, receiver) as (...args: unknown[]) => unknown;
  if (position === 'event-first') {
    return (event: unknown, ...rest: unknown[]) => original(prefix(event as string), ...rest);
  }
  return (first: unknown, event: unknown, ...rest: unknown[]) =>
    original(first, prefix(event as string), ...rest);
}

/**
 * Attach module API objects to the hidden module API map on a context.
 */
export function attachModuleApis(
  moduleRuntimes: readonly EngineContextTypes.ModuleRuntime[],
  ctx: Record<PropertyKey, unknown>,
  connection?: EngineContextTypes.RuntimeConnection,
): void {
  const apiMap: Record<PropertyKey, unknown> = {};

  for (const runtime of moduleRuntimes) {
    const moduleCtx = createModuleScopedContext(runtime.instance.id, ctx);
    const api = runtime.contextFactory(moduleCtx);
    apiMap[(runtime.instance as PrimitiveCore.Primitive).__identity[0]] = api;

    if (connection) {
      apiMap[runtime.instance.id] = api;
    }
  }

  Object.defineProperty(ctx, DefineModule.MODULE_API_MAP, {
    configurable: true,
    enumerable: false,
    value: apiMap,
    writable: false,
  });
}

/**
 * Convert mutable runtime connection state into the stable public info shape.
 */
export function toConnectionInfo(
  connection: EngineContextTypes.RuntimeConnection,
): EngineContextTypes.ConnectionInfo<Record<string, unknown>> {
  return {
    id: connection.id,
    meta: connection.meta,
    tags: [...connection.tags],
    channels: [...connection.channels],
    latency: connection.latency,
    quality: connection.quality,
    bufferedAmount: connection.descriptor.bufferedAmount(),
  };
}

/**
 * Persist connection attachment data when the adapter supports socket
 * serialization for hibernation or resume.
 */
export function persistAttachment(connection: EngineContextTypes.RuntimeConnection): void {
  const wsLike = connection.wsKey as { serializeAttachment?: (value: unknown) => void };
  if (typeof wsLike.serializeAttachment === 'function') {
    wsLike.serializeAttachment({
      id: connection.id,
      meta: connection.meta,
      tags: [...connection.tags],
      channelMemberships: [...connection.channelMemberships.values()],
      activeStreamIds: [...(connection.activeStreamIds ?? [])],
    });
  }
}
