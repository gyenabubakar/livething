import { userKeyOf } from '~/_engine/runtime/connection.ts';
import { buildConnectionHandle } from '~/_engine/runtime/refs.ts';
import { connectionTagRefs } from '~/_engine/runtime/tag-index.ts';
import { frameMatches, frameUnsafeCast } from '~/intercept/frame-match.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { LocalKey } from '~/local-key/local-key.ts';
import type * as EngineContextTypes from './types.ts';

type BuildConnectionContextScopeParameter = {
  channel?: EngineCompileTypes.CompiledChannel;
  channelName?: string;
  channelFamily?: string | null;
  isSubscribeGate?: boolean;
};
type ToConnectionInfoOptsParameter = {
  hibernationEnabled?: boolean;
  lastSeenAt?: (userId: string) => number | null;
  lastSeen?: number | null;
};

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

  const channels = new Set<string>();
  const tagsByKey = new Map<string, PublicApi.TagRef>();
  for (const connection of connections) {
    for (const membership of connection.channelMemberships.values())
      channels.add(membership.channelName);
    for (const tag of connectionTagRefs(connection)) {
      tagsByKey.set(JSON.stringify([tag.kind, tag.group, tag.key]), tag);
    }
  }

  // Every connection here belongs to the same user, so `toConnectionInfo`'s
  // last-seen lookup (a storage read) would return the same answer for each
  // one of them — probe it through a single connection instead of once per
  // tab. `lastSeen` is only present on a `ConnectionInfo` at all when the
  // `lastSeen()` capability is installed, so the field is omitted here too
  // when it's absent from the probe.
  const lastSeenProbe = deps.toConnectionInfo(connections[0]!);
  const sawLastSeen = 'lastSeen' in lastSeenProbe;
  const lastSeen = sawLastSeen ? (lastSeenProbe.lastSeen ?? null) : undefined;

  return {
    id: userId,
    online: true,
    connections: () =>
      connections.map((target) =>
        deps.toConnectionInfo(target, sawLastSeen ? { lastSeen } : undefined),
      ),
    channels: [...channels],
    tags: [...tagsByKey.values()],
    ...(sawLastSeen ? { lastSeen: lastSeenProbe.lastSeen ?? null } : {}),
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

/**
 * Attach the top-level send/broadcast/close/user/connection messaging surface
 * to a connection ctx. Written onto the target rather than returned so the
 * per-frame context build never pays for an object spread.
 */
function assignMessagingApi(
  target: Record<PropertyKey, unknown>,
  connection: EngineRuntimeTypes.RuntimeConnection,
  deps: MessagingDeps,
): void {
  target.send = (event: string, payload: unknown) =>
    deps.sendThroughPipeline(connection, { routing: undefined, event, payload });

  target.broadcast = (event: string, payload: unknown, options?: PublicApi.BroadcastOptions) => {
    deps.broadcastToConnections(deps.connections.values(), {
      event,
      payload,
      options,
      excludeConnectionId: connection.id,
    });
  };

  target.connection = buildConnectionRef(connection.id, connection.userId, deps.instanceId);

  target.connections = buildConnectionsManager(deps);

  // Anonymous connections have no user identity — `ctx.user` still exists so
  // handler code never has to null-check it, but it addresses no live
  // connection (usersByKey never indexes an anonymous connection under '').
  target.user = buildUserHandle(userKeyOf(connection) ?? '', deps);

  target.users = { get: (id: string) => buildUserHandle(id, deps) };

  target.setMeta = (patch: Record<string, unknown>) => {
    Object.assign(connection.meta, patch);
    deps.persistAttachment(connection);
  };

  target.close = (code?: number, reason?: string) => connection.descriptor.close(code, reason);
}

/**
 * Per-instance slots the lazily-built `ctx.channels` / `ctx.tags` accessors
 * memoize into. Symbol-keyed so they stay invisible to the public ctx type and
 * to any enumeration of the context.
 */
const CHANNELS_API = Symbol('wskit-ctx-channels');
const TAGS_API = Symbol('wskit-ctx-tags');

/**
 * The shared prototype every context built from one dep bag inherits.
 *
 * Defining an accessor on an object is an order of magnitude more expensive
 * than writing a data property, and these four are the same for every context
 * the engine builds, so they are created once per engine rather than once per
 * frame. Each reads the connection back off the instance, keeping the live-read
 * semantics an inline getter had.
 */
const contextPrototypes = new WeakMap<EngineContextTypes.BuildConnectionContextDeps, object>();

function contextPrototype(deps: EngineContextTypes.BuildConnectionContextDeps): object {
  const cached = contextPrototypes.get(deps);
  if (cached) return cached;

  function connectionOf(ctx: unknown): EngineRuntimeTypes.RuntimeConnection {
    return (ctx as Record<PropertyKey, unknown>)[
      ENGINE_INTERNAL_CONNECTION
    ] as EngineRuntimeTypes.RuntimeConnection;
  }

  const proto: Record<PropertyKey, unknown> = {
    // Live reads, not snapshots — so a context reused across a dispatch's
    // intercepts and handler always reflects current values.
    get connectionCount() {
      return deps.connections.size;
    },

    get bufferedAmount() {
      return connectionOf(this).descriptor.bufferedAmount();
    },
  };

  // `ctx.channels` exists only when the `channels()` capability is listed, and
  // is built on first access. Defined conditionally (not a throwing getter) so a
  // channel-less handler simply has no `channels` property — enumerating the
  // context never trips it.
  const channelContext = deps.channelContext;
  if (channelContext) {
    Object.defineProperty(proto, 'channels', {
      configurable: true,
      enumerable: true,
      get(this: Record<PropertyKey, unknown>) {
        const scope = this[ENGINE_CHANNEL_META] as EngineContextTypes.EngineChannelMeta | undefined;
        return (this[CHANNELS_API] ??= channelContext.buildChannelsApi(connectionOf(this), deps, {
          isSubscribeGate: scope?.isSubscribeGate,
        }));
      },
    });
  }

  // `ctx.tags` exists only on tag-enabled servers, and is built on first
  // access — most handlers never touch it.
  const buildTags = deps.buildTagsApi;
  if (deps.usesTags && buildTags) {
    const tagsRuntime = {
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
    };
    Object.defineProperty(proto, 'tags', {
      configurable: true,
      enumerable: true,
      get(this: Record<PropertyKey, unknown>) {
        return (this[TAGS_API] ??= buildTags(tagsRuntime, connectionOf(this)));
      },
    });
  }

  contextPrototypes.set(deps, proto);
  return proto;
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
  scope?: BuildConnectionContextScopeParameter,
): PublicApi.ConnectionContext<Record<string, unknown>, unknown> & Record<PropertyKey, unknown> {
  const { sql, kv } = deps.getStorageView();

  // Allocated on the first `provide()` — most handlers never touch locals.
  let locals: Map<LocalKey<unknown>, unknown> | undefined;

  const base = Object.create(contextPrototype(deps)) as Record<PropertyKey, unknown>;

  base[ENGINE_CHANNEL_META] = {
    channelName: scope?.channelName,
    channelFamily: scope?.channelFamily,
    isSubscribeGate: scope?.isSubscribeGate,
  } satisfies EngineContextTypes.EngineChannelMeta;

  base[ENGINE_INTERNAL_CONNECTION] = connection;

  base.meta = connection.meta;

  assignMessagingApi(base, connection, deps);

  const channelExtra = deps.channelContext?.buildChannelFamilyExtra(connection, scope, deps);
  if (channelExtra?.channel) base.channel = channelExtra.channel;

  base.sql = sql;
  base.kv = kv;
  base.log = deps.logger;
  base.platform = deps.platform;

  base.provide = <T>(key: LocalKey<T>, value: T): void => {
    (locals ??= new Map()).set(key, value);
  };

  base.inject = <T>(key: LocalKey<T>): T | undefined => locals?.get(key) as T | undefined;

  base.matches = (key: string, frame: InterceptFrame) => frameMatches(deps.compiled, key, frame);

  base.unsafeCast = (key: string, frame: InterceptFrame) =>
    frameUnsafeCast(deps.compiled, key, frame);

  for (const extend of deps.contextExtenders ?? []) {
    Object.defineProperties(base, Object.getOwnPropertyDescriptors(extend(base)));
  }

  return base as PublicApi.ConnectionContext<Record<string, unknown>, unknown> &
    Record<PropertyKey, unknown>;
}

/**
 * Convert mutable runtime connection state into the stable public info shape.
 */
export function toConnectionInfo(
  connection: EngineRuntimeTypes.RuntimeConnection,
  instanceId: string | undefined,
  opts?: ToConnectionInfoOptsParameter,
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
  if ('lastSeen' in (opts ?? {})) {
    return { ...info, lastSeen: opts!.lastSeen ?? null };
  }
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
