import { userKeyOf } from '~/_engine/runtime/connection.ts';
import { buildConnectionHandle } from '~/_engine/runtime/refs.ts';
import { connectionTagRefs } from '~/_engine/runtime/tag-index.ts';
import { frameMatches, frameUnsafeCast } from '~/intercept/frame-match.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { LocalKey } from '~/local-key/local-key.ts';
import { createLazyStorageView } from './lazy-storage.ts';
import type * as EngineContextTypes from './types.ts';

/**
 * Symbol key used to attach channel metadata (channel name) to a handler context.
 *
 * @internal
 */
export const ENGINE_CHANNEL_META = Symbol('wskit-engine-scope-meta');

/**
 * Symbol key under which engine internals stash the runtime connection on a
 * handler context. Engine-installed protocol handlers read this to perform
 * connection-state checks (membership, etc.). Product handlers cannot see
 * this field — symbol keys do not appear in the public ctx type, in
 * `Object.keys`, or in `JSON.stringify`.
 *
 * @internal
 */
export const ENGINE_INTERNAL_CONNECTION = Symbol('wskit-engine-internal-connection');

type MessagingDeps = Pick<
  EngineContextTypes.BuildConnectionContextDeps,
  | 'broadcastToConnections'
  | 'connections'
  | 'usersByKey'
  | 'instanceId'
  | 'logger'
  | 'sendThroughPipeline'
  | 'toConnectionInfo'
  | 'persistAttachment'
>;

/** Reach any specific connection by ref, or list every live connection. */
export function buildConnectionsManager(
  deps: MessagingDeps,
): PublicApi.ConnectionsManager<Record<string, unknown>> {
  const { connection: getConnectionHandle } = buildConnectionHandle(deps);
  return {
    get: (ref) => getConnectionHandle(ref),
    all: () => [...deps.connections.values()].map((target) => deps.toConnectionInfo(target)),
  };
}

/** Reach any user by id — the connectionless `ctx.users` surface. */
export function buildUsersManager(
  deps: MessagingDeps,
): PublicApi.UsersManager<Record<string, unknown>> {
  return { get: (id) => buildUserHandle(id, deps) };
}

/** Build a `UserRef` for one user id. */
function buildUserRef(userId: string, instanceId: string | undefined): PublicApi.UserRef {
  return { __wskit: 'user-ref', id: userId, instance: instanceId };
}

/** Snapshot of one user's currently-live connections, via the `usersByKey` fan-out index. */
function userConnections(
  userId: string,
  deps: MessagingDeps,
): EngineRuntimeTypes.RuntimeConnection[] {
  return [...(deps.usersByKey.get(userId) ?? [])];
}

/** Build a `UserInfo` snapshot for one user, or `null` when they have no live connections. */
function buildUserInfo(
  userId: string,
  deps: MessagingDeps,
): PublicApi.UserInfo<Record<string, unknown>> | null {
  const connections = userConnections(userId, deps);
  if (connections.length === 0) return null;

  const infos = connections.map((target) => deps.toConnectionInfo(target));
  const channels = new Set<string>();
  const tagsByKey = new Map<string, PublicApi.TagRef>();
  // `lastSeen` is only present on a `ConnectionInfo` when `lastSeen()` is
  // installed — track whether we saw it at all, separately from the running
  // max, so the field can be omitted entirely without the capability.
  let sawLastSeen = false;
  let lastSeen: number | null = null;
  for (const info of infos) {
    for (const channel of info.channels) channels.add(channel);
    for (const tag of info.tags) tagsByKey.set(`${tag.kind}:${tag.group}:${tag.key}`, tag);
    if ('lastSeen' in info) {
      sawLastSeen = true;
      const seenAt = info.lastSeen ?? null;
      if (seenAt !== null && (lastSeen === null || seenAt > lastSeen)) lastSeen = seenAt;
    }
  }

  return {
    id: userId,
    online: true,
    connections: () => connections.map((target) => deps.toConnectionInfo(target)),
    channels: [...channels],
    tags: [...tagsByKey.values()],
    ...(sawLastSeen ? { lastSeen } : {}),
    ref: () => buildUserRef(userId, deps.instanceId),
  };
}

/** Build a `UserHandle` addressing every live connection of one user id. */
function buildUserHandle(
  userId: string,
  deps: MessagingDeps,
): PublicApi.UserHandle<Record<string, unknown>> {
  return {
    id: userId,

    ref: () => buildUserRef(userId, deps.instanceId),

    send: (event, payload) => {
      let delivered = 0;
      for (const connection of userConnections(userId, deps)) {
        if (deps.sendThroughPipeline(connection, { routing: undefined, event, payload })) {
          delivered += 1;
        }
      }
      return delivered;
    },

    setMeta: (patch) => {
      for (const connection of userConnections(userId, deps)) {
        Object.assign(connection.meta, patch);
        deps.persistAttachment(connection);
      }
    },

    connections: () => userConnections(userId, deps).map((target) => deps.toConnectionInfo(target)),

    close: (code, reason) => {
      for (const connection of userConnections(userId, deps)) {
        connection.descriptor.close(code, reason);
      }
    },

    info: () => buildUserInfo(userId, deps),
  };
}

/** Build the top-level send/broadcast/close/user/connection messaging surface for a connection ctx. */
function buildMessagingApi(
  connection: EngineRuntimeTypes.RuntimeConnection,
  deps: MessagingDeps,
): Pick<
  PublicApi.ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown>,
  'broadcast' | 'close' | 'connection' | 'connections' | 'send' | 'setMeta' | 'user' | 'users'
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

    connection: buildConnectionRef(connection.id, connection.userId, deps.instanceId),

    connections: buildConnectionsManager(deps),

    user: buildUserHandle(userKeyOf(connection), deps),

    users: { get: (id) => buildUserHandle(id, deps) },

    setMeta: (patch) => {
      Object.assign(connection.meta, patch);
      deps.persistAttachment(connection);
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
  connection: EngineRuntimeTypes.RuntimeConnection,
  scope?: {
    channel?: EngineCompileTypes.CompiledChannel;
    channelName?: string;
    channelFamily?: string | null;
    isSubscribeGate?: boolean;
  },
): PublicApi.ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown> &
  Record<PropertyKey, unknown> {
  const { sql, kv } = createLazyStorageView(deps.getStorage());

  const locals = new Map<LocalKey<unknown>, unknown>();

  const base: Omit<
    PublicApi.ConnectionContext<Record<string, unknown>, Record<string, unknown>, unknown>,
    'channels' | 'latency' | 'quality' | 'schedule' | 'cancelScheduled'
  > &
    Record<PropertyKey, unknown> = {
    [ENGINE_CHANNEL_META]: {
      channelName: scope?.channelName,
      channelFamily: scope?.channelFamily,
      isSubscribeGate: scope?.isSubscribeGate,
    } satisfies EngineContextTypes.EngineChannelMeta,

    [ENGINE_INTERNAL_CONNECTION]: connection,

    meta: connection.meta,

    ...buildMessagingApi(connection, deps),

    // Live reads, not snapshots — so a context reused across a dispatch's
    // intercepts and handler always reflects current values.
    get connectionCount() {
      return deps.connections.size;
    },

    get bufferedAmount() {
      return connection.descriptor.bufferedAmount();
    },

    setAlarm: (time) => {
      void deps.getTimers().setAlarm(time);
    },

    ...(deps.channelContext?.buildChannelFamilyExtra(connection, scope, deps) ?? {}),

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

  // `ctx.channels` exists only when the `channels()` capability is listed, and
  // is built on first access. Defined conditionally (not a throwing getter) so a
  // channel-less handler simply has no `channels` property — enumerating the
  // context never trips it.
  const channelContext = deps.channelContext;
  if (channelContext) {
    let channelsApi: ReturnType<typeof channelContext.buildChannelsApi> | undefined;
    Object.defineProperty(base, 'channels', {
      configurable: true,
      enumerable: true,
      get() {
        return (channelsApi ??= channelContext.buildChannelsApi(connection, deps));
      },
    });
  }

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
              target: EngineRuntimeTypes.RuntimeConnection,
              event: string,
              payload: unknown,
            ) => deps.sendThroughPipeline(target, { routing: undefined, event, payload }),
            persistAttachment: deps.persistAttachment,
            getStorage: deps.getStorage,
          },
          connection,
        ));
      },
    });
  }

  for (const extend of deps.contextExtenders ?? []) {
    Object.defineProperties(base, Object.getOwnPropertyDescriptors(extend(base)));
  }

  return base as PublicApi.ConnectionContext<
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
  connection: EngineRuntimeTypes.RuntimeConnection,
  instanceId: string | undefined,
  opts?: { hibernationEnabled?: boolean; lastSeenAt?: (userId: string) => number | null },
): PublicApi.ConnectionInfo<Record<string, unknown>> {
  const hibernationEnabled = opts?.hibernationEnabled;
  const info: PublicApi.ConnectionInfo<Record<string, unknown>> = {
    id: connection.id,
    userId: connection.userId,
    meta: connection.meta,
    tags: connectionTagRefs(connection),
    channels: [...connection.channelMemberships.values()].map((m) => m.channelName),
    latency: connection.latency,
    quality: hibernationEnabled || connection.latency === null ? null : connection.quality,
    bufferedAmount: connection.descriptor.bufferedAmount(),
    ref: () => buildConnectionRef(connection.id, connection.userId, instanceId),
  };
  if (opts?.lastSeenAt) {
    return { ...info, lastSeen: opts.lastSeenAt(connection.userId) };
  }
  return info;
}

/**
 * Build a `ConnectionRef` for one connection. Captured by `ConnectionInfo.ref()`
 * and used directly for `ctx.connection`. `instanceId` carries the engine's
 * instance id when one is configured — the broker (future) reads this field
 * to decide whether the target lives locally or on another instance.
 */
export function buildConnectionRef(
  connectionId: string,
  userId: string,
  instanceId: string | undefined,
): PublicApi.ConnectionRef {
  return {
    __wskit: 'connection-ref',
    id: connectionId,
    instance: instanceId,
    userId,
  };
}
