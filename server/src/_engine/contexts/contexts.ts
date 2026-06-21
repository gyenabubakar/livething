import { buildConnectionHandle } from '~/_engine/runtime/refs.ts';
import { connectionTagRefs } from '~/_engine/runtime/tag-index.ts';
import { buildChannelFamilyExtra, buildChannelsApi } from '~/channel/context.ts';
import type * as PublicApi from '~/context.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { LocalKey } from '~/local-key/local-key.ts';
import { createLazyStorageView } from './lazy-storage.ts';
import * as EngineContextTypes from './types.ts';

export { createInitContext, createShutdownContext } from '~/lifecycle/context.ts';
export { buildChannelHandle } from '~/channel/context.ts';
export { persistAttachment } from '~/persistence/context.ts';

type MessagingDeps = Pick<
  EngineContextTypes.BuildConnectionContextDeps,
  'broadcastToConnections' | 'connections' | 'instanceId' | 'logger' | 'sendThroughPipeline'
>;

/** Build the top-level send/broadcast/close messaging surface for a connection ctx. */
function buildMessagingApi(
  connection: EngineContextTypes.RuntimeConnection,
  deps: MessagingDeps,
): Pick<
  EngineContextTypes.ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown>,
  'broadcast' | 'close' | 'connection' | 'send'
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

    ...buildConnectionHandle(deps),

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
    channelFamily?: string | null;
  },
): EngineContextTypes.ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown> &
  Record<PropertyKey, unknown> {
  const { sql, kv } = createLazyStorageView(deps.requireStorage);

  const locals = new Map<LocalKey<unknown>, unknown>();

  let channelsApi: ReturnType<typeof buildChannelsApi> | undefined;

  const base: Omit<
    EngineContextTypes.ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown>,
    'latency' | 'quality' | 'schedule' | 'cancelScheduled'
  > &
    Record<PropertyKey, unknown> = {
    [EngineContextTypes.ENGINE_CHANNEL_META]: {
      channelName: scope?.channelName,
      channelFamily: scope?.channelFamily,
    } satisfies EngineContextTypes.EngineChannelMeta,

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

    // Built on first access — most handlers never touch `ctx.channels`.
    get channels() {
      return (channelsApi ??= buildChannelsApi(connection, deps));
    },

    setAlarm: (time) => {
      void deps.getTimers()?.setAlarm?.(time);
    },

    ...buildChannelFamilyExtra(connection, scope, deps),

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
      if (!deps.frameMatch) {
        throw new Error('[wskit] ctx.matches(...) requires the intercepts() capability.');
      }
      return deps.frameMatch.matches(deps.compiled, key, frame);
    },

    unsafeCast(key: string, frame: InterceptFrame) {
      if (!deps.frameMatch) {
        throw new Error('[wskit] ctx.unsafeCast(...) requires the intercepts() capability.');
      }
      return deps.frameMatch.unsafeCast(deps.compiled, key, frame);
    },
  };

  // `ctx.tags` exists only on tag-enabled servers, and is built on first
  // access — most handlers never touch it.
  const buildTags = deps.buildTagsApi;
  if (deps.usesTags && buildTags) {
    let tagsApi: ReturnType<typeof buildTags> | undefined;
    Object.defineProperty(base, 'tags', {
      configurable: true,
      enumerable: true,
      get() {
        return (tagsApi ??= buildTags(
          {
            tagMembers: deps.tagMembers,
            isTagGroupDeclared: deps.isTagGroupDeclared,
            getTagGroupSchema: deps.getTagGroupSchema,
            toConnectionInfo: deps.toConnectionInfo,
            sendThroughPipeline: (
              target: EngineContextTypes.RuntimeConnection,
              event: string,
              payload: unknown,
            ) => deps.sendThroughPipeline(target, { routing: undefined, event, payload }),
            persistAttachment: deps.persistAttachment,
            persistenceEnabled: deps.persistenceEnabled,
            requireStorage: deps.requireStorage,
          },
          connection,
        ));
      },
    });
  }

  for (const extend of deps.contextExtenders ?? []) {
    Object.defineProperties(base, Object.getOwnPropertyDescriptors(extend(base)));
  }

  return base as EngineContextTypes.ConnectionContext<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown
  > &
    Record<PropertyKey, unknown>;
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
    tags: connectionTagRefs(connection),
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
