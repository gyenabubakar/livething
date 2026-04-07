import { prefixedModuleEvent } from '~/_engine/compile/utils.ts';
import { MODULE_API_MAP } from '~/define-module.ts';
import type { Primitive } from '~/primitive.ts';
import type {
  BroadcastOptions,
  BuildConnectionContextDeps,
  CompiledChannel,
  CompiledNamespace,
  ConnectionContext,
  ConnectionInfo,
  CreateTaskContextDeps,
  InitContext,
  ModuleRuntime,
  RuntimeConnection,
  ShutdownContext,
  TaskContext,
} from './types.ts';

/**
 * Build the context passed to the `onInit` lifecycle hook.
 */
export function createInitContext(
  deps: Pick<CreateTaskContextDeps, 'env' | 'logger' | 'platform' | 'requireStorage'>,
): InitContext<Record<string, unknown>, unknown> {
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
  deps: CreateTaskContextDeps,
): ShutdownContext<Record<string, unknown>, Record<string, unknown>, unknown> {
  const storage = deps.requireStorage();
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
    cancelScheduled: (taskId, filter) => {
      deps.cancelScheduled(taskId, filter);
    },
    connectionCount: deps.connections.size,
    getConnections: () =>
      [...deps.connections.values()].map((connection) => deps.toConnectionInfo(connection)),
    getConnectionsByTag: (tag) =>
      [...deps.connections.values()]
        .filter((connection) => connection.tags.has(tag))
        .map((connection) => deps.toConnectionInfo(connection)),
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
  deps: CreateTaskContextDeps,
): TaskContext<Record<string, unknown>, Record<string, unknown>, unknown> {
  const storage = deps.requireStorage();
  const ctx: TaskContext<Record<string, unknown>, Record<string, unknown>, unknown> = {
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
      if (!connection) return false;
      deps.sendThroughPipeline(connection, undefined, event, payload);
      return true;
    },
    getConnections: () =>
      [...deps.connections.values()].map((connection) => deps.toConnectionInfo(connection)),
    getConnectionsByTag: (tag) =>
      [...deps.connections.values()]
        .filter((connection) => connection.tags.has(tag))
        .map((connection) => deps.toConnectionInfo(connection)),
    connectionCount: deps.connections.size,
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled: (taskId, filter) => {
      deps.cancelScheduled(taskId, filter);
    },
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,
  };

  deps.attachModuleApis(ctx as unknown as Record<PropertyKey, unknown>, undefined);
  return ctx;
}

/**
 * Build the per-connection handler context.
 *
 * Top-level send/broadcast live on the root object. Scoped namespace/channel
 * APIs are attached under `ctx.namespace` and `ctx.channel`.
 */
export function buildConnectionContext(
  deps: BuildConnectionContextDeps,
  connection: RuntimeConnection,
  scope?: {
    namespace?: CompiledNamespace;
    channel?: CompiledChannel;
    channelName?: string;
    channelScope?: string;
  },
): ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown> &
  Record<PropertyKey, unknown> {
  const storage = deps.requireStorage();
  const base: ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown> &
    Record<PropertyKey, unknown> = {
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
      if (!target) return false;
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
    getConnections: () =>
      [...deps.connections.values()].map((target) => deps.toConnectionInfo(target)),
    getConnectionsByTag: (tag) =>
      [...deps.connections.values()]
        .filter((target) => target.tags.has(tag))
        .map((target) => deps.toConnectionInfo(target)),
    connectionCount: deps.connections.size,
    bufferedAmount: connection.descriptor.bufferedAmount(),
    latency: connection.latency,
    quality: connection.quality,
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled: (taskId, filter) => {
      deps.cancelScheduled(taskId, filter);
    },
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

  if (scope?.namespace) {
    const namespace = scope.namespace;
    base.namespace = {
      name: namespace.name,
      send: (event, payload) =>
        deps.sendThroughPipeline(connection, { namespace: namespace.name }, event, payload),
      broadcast: (event, payload) =>
        deps.broadcastToConnections(
          [...deps.connections.values()],
          event,
          payload,
          { namespace: namespace.name },
          connection.id,
        ),
    };
  }

  if (scope?.channel) {
    const channel = scope.channel;
    const channelName =
      scope.channelName ?? (typeof channel.pattern === 'string' ? channel.pattern : '');
    const channelScope = scope.channelScope ?? channel.key;
    base.channel = {
      name: channelName,
      send: (event, payload) =>
        deps.sendThroughPipeline(
          connection,
          { channel: channelName, channelScope },
          event,
          payload,
        ),
      broadcast: (event, payload) =>
        deps.broadcastToChannel(channelName, event, payload, connection.id, channelScope),
      sendReplay: (event, payload, wire) =>
        deps.sendReplay(connection, channelName, channelScope, event, payload, wire),
    };
    base.channels = {
      members: (name) => deps.getChannelMembers(name),
      kick: (channelNameToKick, tag, reason) =>
        deps.kickChannelMembers(channelNameToKick, tag, reason),
    };
  }

  if (deps.compiled.ack && !scope?.namespace && !scope?.channel) {
    base.ack = () => {
      if (!connection.activeAckId) return;
      deps.sendProtocolMessage(connection, '_ack', { _ackId: connection.activeAckId });
    };
  }

  if (deps.compiled.replay && !scope?.namespace && !scope?.channel) {
    base.sendReplay = (
      event: string,
      payload: unknown,
      wire: { seq: number; messageId: string; channel?: string },
    ) => {
      deps.sendReplay(connection, wire.channel, undefined, event, payload, wire);
    };
  }

  for (const extend of deps.contextExtenders ?? []) {
    Object.assign(base, extend(base));
  }

  deps.attachModuleApis(base, connection);
  return base;
}

/**
 * Wrap a context so module event helpers automatically prefix their event names.
 */
export function createModuleScopedContext(
  moduleId: string,
  ctx: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> {
  function prefix(event: string): string {
    return prefixedModuleEvent(moduleId, event);
  }

  return new Proxy(ctx, {
    get(target, key, receiver) {
      if (key === 'send') {
        return (event: string, payload: unknown) =>
          (Reflect.get(target, 'send', receiver) as (event: string, payload: unknown) => void)(
            prefix(event),
            payload,
          );
      }
      if (key === 'broadcast') {
        return (event: string, payload: unknown, options?: BroadcastOptions) =>
          (
            Reflect.get(target, 'broadcast', receiver) as (
              event: string,
              payload: unknown,
              options?: BroadcastOptions,
            ) => void
          )(prefix(event), payload, options);
      }
      if (key === 'sendTo') {
        return (tag: string, event: string, payload: unknown) =>
          (
            Reflect.get(target, 'sendTo', receiver) as (
              tag: string,
              event: string,
              payload: unknown,
            ) => void
          )(tag, prefix(event), payload);
      }
      if (key === 'sendToConnection') {
        return (connectionId: string, event: string, payload: unknown) =>
          (
            Reflect.get(target, 'sendToConnection', receiver) as (
              connectionId: string,
              event: string,
              payload: unknown,
            ) => boolean
          )(connectionId, prefix(event), payload);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * Attach module API objects to the hidden module API map on a context.
 */
export function attachModuleApis(
  moduleRuntimes: readonly ModuleRuntime[],
  ctx: Record<PropertyKey, unknown>,
  connection?: RuntimeConnection,
): void {
  const apiMap: Record<PropertyKey, unknown> = {};

  for (const runtime of moduleRuntimes) {
    const moduleCtx = createModuleScopedContext(runtime.instance.id, ctx);
    const api = runtime.contextFactory(moduleCtx);
    apiMap[(runtime.instance as Primitive).__identity[0]] = api;

    if (connection) {
      apiMap[runtime.instance.id] = api;
    }
  }

  Object.defineProperty(ctx, MODULE_API_MAP, {
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
  connection: RuntimeConnection,
): ConnectionInfo<Record<string, unknown>> {
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
export function persistAttachment(connection: RuntimeConnection): void {
  const wsLike = connection.wsKey as { serializeAttachment?: (value: unknown) => void };
  if (typeof wsLike.serializeAttachment === 'function') {
    wsLike.serializeAttachment({
      id: connection.id,
      meta: connection.meta,
      tags: [...connection.tags],
      channels: [...connection.channels],
    });
  }
}
