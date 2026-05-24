import { buildChannelsApi, buildChannelScopeExtra } from '~/channel/context.ts';
import { buildNamespaceScopeExtra } from '~/namespace/context.ts';
import * as TagsRuntime from '~/tags/runtime.ts';
import type * as PublicApi from '~/context.ts';
import type { LocalKey } from '~/local-key/local-key.ts';
import { createLazyStorageView } from './lazy-storage.ts';
import * as EngineContextTypes from './types.ts';

export { createInitContext, createShutdownContext } from '~/lifecycle/context.ts';
export { createTaskContext } from '~/scheduled/context.ts';
export { buildChannelHandle } from '~/channel/context.ts';
export { attachPluginApis, createPluginScopedContext } from '~/plugins/context.ts';
export { persistAttachment } from '~/persistence/context.ts';

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
  'broadcast' | 'broadcastBinary' | 'close' | 'send' | 'sendBinary' | 'sendToConnection'
> {
  return {
    send: (event, payload) =>
      deps.sendThroughPipeline(connection, { routing: undefined, event, payload }),

    broadcast: (event, payload, options) => {
      deps.broadcastToConnections([...deps.connections.values()], {
        event,
        payload,
        options,
        excludeConnectionId: connection.id,
      });
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
      deps.sendThroughPipeline(target, { routing: undefined, event, payload });
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
    channelScope?: string | null;
  },
): EngineContextTypes.ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown> &
  Record<PropertyKey, unknown> {
  const { sql, kv } = createLazyStorageView(deps.requireStorage);

  const locals = new Map<LocalKey<unknown>, unknown>();

  let channelsApi: ReturnType<typeof buildChannelsApi> | undefined;

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
      channelScope: scope?.channelScope,
    } satisfies EngineContextTypes.EngineScopeMeta,

    [EngineContextTypes.ENGINE_INTERNAL_CONNECTION]: connection,

    id: connection.id,

    identity: connection.identity,

    self: buildConnectionRef(connection.id, connection.identity, deps.instanceId),

    meta: connection.meta,

    ...buildMessagingApi(connection, deps),

    getConnections: () => {
      return [...deps.connections.values()].map((target) => deps.toConnectionInfo(target));
    },

    // Live reads, not snapshots — so a context reused across a dispatch's
    // intercepts and handler always reflects current values.
    get connectionCount() {
      return deps.connections.size;
    },

    get bufferedAmount() {
      return connection.descriptor.bufferedAmount();
    },

    get latency() {
      return connection.latency;
    },

    get quality() {
      return deps.hibernationEnabled ? null : connection.quality;
    },

    // Built on first access — most handlers never touch `ctx.channels`.
    get channels() {
      return (channelsApi ??= buildChannelsApi(connection, deps));
    },

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

    ...buildNamespaceScopeExtra(connection, scope, deps),
    ...buildChannelScopeExtra(connection, scope, deps),

    sql,
    kv,
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,

    provide<T>(key: LocalKey<T>, value: T): void {
      locals.set(key, value);
    },

    inject<T>(key: LocalKey<T>): T | undefined {
      return locals.get(key) as T | undefined;
    },
  };

  // `ctx.tags` exists only on tag-enabled servers, and is built on first
  // access — most handlers never touch it.
  if (deps.usesTags) {
    let tagsApi: ReturnType<typeof TagsRuntime.buildTagsApi> | undefined;
    Object.defineProperty(base, 'tags', {
      configurable: true,
      enumerable: true,
      get() {
        return (tagsApi ??= TagsRuntime.buildTagsApi(
          {
            tagMembers: deps.tagMembers,
            isTagGroupDeclared: deps.isTagGroupDeclared,
            toConnectionInfo: deps.toConnectionInfo,
            sendThroughPipeline: (target, event, payload) =>
              deps.sendThroughPipeline(target, { routing: undefined, event, payload }),
            persistAttachment: deps.persistAttachment,
            persistenceEnabled: deps.persistenceEnabled,
            requireStorage: deps.requireStorage,
          },
          connection,
        ));
      },
    });
  }

  // User extension hook — extenders see the assembled ctx and return a
  // partial that gets merged in.
  for (const extend of deps.contextExtenders ?? []) {
    Object.assign(base, extend(base));
  }

  // Adds a hidden non-enumerable plugin API map via defineProperty. Runs
  // last because spread can't preserve non-enumerable properties.
  deps.attachPluginApis(base, connection);
  return base;
}

/**
 * Convert mutable runtime connection state into the stable public info shape.
 */
export function toConnectionInfo(
  connection: EngineContextTypes.RuntimeConnection,
  instanceId: string | undefined,
  hibernationEnabled?: boolean,
): EngineContextTypes.ConnectionInfo<Record<string, unknown>> {
  return {
    id: connection.id,
    identity: connection.identity,
    meta: connection.meta,
    tags: TagsRuntime.buildConnectionTagRefs(connection),
    channels: [...connection.channelMemberships.values()].map((m) => m.channelName),
    latency: connection.latency,
    quality: hibernationEnabled ? null : connection.quality,
    bufferedAmount: connection.descriptor.bufferedAmount(),
    ref: () => buildConnectionRef(connection.id, connection.identity, instanceId),
  };
}

/**
 * Build a `ConnectionRef` for one connection. Captured by `ConnectionInfo.ref()`
 * and used directly for `ctx.self`. `instanceId` carries the engine's instance
 * id when one is configured — the broker (future) reads this field to decide
 * whether the target lives locally or on another instance.
 */
export function buildConnectionRef(
  connectionId: string,
  identity: string,
  instanceId: string | undefined,
): PublicApi.ConnectionRef {
  return {
    __wskit: 'connection-ref',
    id: connectionId,
    instance: instanceId,
    identity,
  };
}
