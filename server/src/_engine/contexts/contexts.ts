import { buildChannelsApi, buildChannelScopeExtra } from '~/channel/context.ts';
import { frameMatches, frameUnsafeCast } from '~/intercept/frame-match.ts';
import { scopePluginContext } from '~/plugin-scope.ts';
import * as TagsRuntime from '~/tags/runtime.ts';
import type * as PublicApi from '~/context.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
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
  'broadcast' | 'close' | 'send' | 'sendToConnection'
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

    close: (code, reason) => connection.descriptor.close(code, reason),
  };
}

/**
 * Build the per-connection handler context.
 *
 * Top-level send/broadcast live on the root object. The scoped channel
 * API is attached under `ctx.channel`.
 */
export function buildConnectionContext(
  deps: EngineContextTypes.BuildConnectionContextDeps,
  connection: EngineContextTypes.RuntimeConnection,
  scope?: {
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
      // Quality has no meaning until the first ping/pong lands; mirror `latency`,
      // which stays null until measured. Also null in hibernation (no pings sent).
      if (deps.hibernationEnabled || connection.latency === null) return null;
      return connection.quality;
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
      void deps.getTimers()?.setAlarm?.(time);
    },

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

    matches(key: string, frame: InterceptFrame) {
      return frameMatches(deps.compiled, key, frame);
    },

    unsafeCast(key: string, frame: InterceptFrame) {
      return frameUnsafeCast(deps.compiled, key, frame);
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
            getTagGroupSchema: deps.getTagGroupSchema,
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

  // ctx.plugin(id) — runs the registered plugin's API factory against a
  // plugin-scoped context (sends prefixed with the plugin namespace), cached
  // per connection context so repeated calls return the same API object.
  const pluginApiCache = new Map<string, unknown>();
  (base as Record<PropertyKey, unknown>).plugin = (id: string, registrationId?: string) => {
    const cacheKey = registrationId ? `${id}#${registrationId}` : id;
    if (pluginApiCache.has(cacheKey)) return pluginApiCache.get(cacheKey);
    const factory = deps.getPluginApiFactory(id);
    if (!factory) {
      throw new Error(
        `[wskit] ctx.plugin('${id}') — no plugin with id '${id}' is registered. ` +
          'List the plugin in define({ capabilities: [...] }).',
      );
    }
    const api = factory(scopePluginContext(id, base));
    pluginApiCache.set(cacheKey, api);
    return api;
  };

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
    quality: hibernationEnabled || connection.latency === null ? null : connection.quality,
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
