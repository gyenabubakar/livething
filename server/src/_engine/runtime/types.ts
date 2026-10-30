/* oxlint-disable @typescript-eslint/no-explicit-any */
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as PublicApi from '~/context.ts';
import type { TagRef } from '~/context.ts';
import type * as InterceptPrimitive from '~/intercept/intercept.ts';
import type * as LifecycleTypes from '~/lifecycle/lifecycle.ts';
import type { SharedSend, SharedSendOptions } from '~/outgoing/runtime.ts';
import type * as ValidationTypes from '~/types.ts';

type MessageParameter = { event: string; payload: unknown };
type FrameParameter = {
  event: string;
  payload: unknown;
  livething: Protocol.LiveThingProtocol | undefined;
};
type OptsParameter2 = { routing: RoutingTarget | undefined; event: string; payload: unknown };

/**
 * One `check` hook plus its optional payload validator.
 *
 * The validator runs first so the hook receives a typed, already-checked
 * subscription payload. The handler may return any value; that value is
 * forwarded to the paired `commit` hook.
 *
 * @declarationEmit
 */
export interface ChannelCheckHook {
  handler: (ctx: any, data?: unknown) => unknown | Promise<unknown>;
  validator?: ValidationTypes.Validator<any>;
}

/**
 * One `commit` hook — the synchronous side of the two-phase subscribe guard.
 *
 * Receives the value returned by the paired `check` handler. Must be
 * synchronous; the engine throws if the handler returns a Promise.
 *
 * @declarationEmit
 */
export interface ChannelCommitHook {
  handler: (ctx: any, checkResult: unknown) => void;
}

/**
 * Every channel lifecycle hook map, keyed by channel key.
 *
 * Shared by the runtime surfaces that dispatch channel hooks: the channel
 * capability's own runtime and the engine's channel-frame helpers both carry
 * this exact shape.
 */
export interface ChannelHooks {
  checkHooks: ReadonlyMap<string, readonly ChannelCheckHook[]>;
  revalidateHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;
  commitHooks: ReadonlyMap<string, readonly ChannelCommitHook[]>;
  subscribeHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;
  unsubscribeHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;
  sessionEndHooks: ReadonlyMap<string, readonly ((ctx: any) => void | Promise<void>)[]>;
}

/**
 * One outgoing frame, seen once before (or after) it goes out to its recipients.
 *
 * It is addressed one of three ways:
 *
 * - to a whole audience: every connection (`ctx.broadcast`) or every member of
 *   one channel (`ctx.channel.broadcast`). Neither `userId` nor `recipients` is
 *   set, and it shows up even when no connection receives it live.
 * - to one user (`ctx.users.get(id).broadcast`): `userId` is set.
 * - to chosen connections (`ctx.send`, a tag or group, a connection ref):
 *   `recipients` lists them.
 */
export interface WireBroadcastMessage {
  event: string;
  payload: Record<string, unknown>;
  livething: Record<string, unknown>;
  /** The user this frame was addressed to. */
  userId?: string;
  /** The connections this frame was sent to, when it went to chosen connections. */
  recipients?: readonly FrameRecipient[];
}

/** One connection a frame was sent to: its user (`''` when anonymous) and its resume token. */
export interface FrameRecipient {
  userId: string;
  resumeToken: string;
}

/**
 * One plugin lifecycle handler, tagged with its plugin id. Hooks run in the
 * order they were registered. The handler already receives a plugin-scoped
 * context (sends are prefixed).
 *
 * @declarationEmit
 */
export interface PluginLifecycleEntry {
  readonly pluginId: string;
  readonly handler: (ctx: any, ...rest: any[]) => void | Promise<void>;
}

/** Plugin lifecycle hooks, one ordered list per kind. */
interface PluginLifecycleHooks {
  init: PluginLifecycleEntry[];
  connect: PluginLifecycleEntry[];
  disconnect: PluginLifecycleEntry[];
  shutdown: PluginLifecycleEntry[];
  error: PluginLifecycleEntry[];
  ping: PluginLifecycleEntry[];
  pong: PluginLifecycleEntry[];
}

/**
 * One plugin `upgrade` hook. Runs before the app's upgrade in the
 * inbound onion. It may own `userId` — but only one upgrade hook (a
 * plugin's or the app's) may, enforced at runtime.
 */
interface PluginUpgradeEntry {
  readonly pluginId: string;
  /** The id of the plugin's own `base`, so `context.upgrade(pluginBase)` finds its hook. */
  readonly baseId?: symbol;
  readonly handler: (
    request: Request,
    helpers: LifecycleTypes.UpgradeHelpers,
  ) =>
    | { userId?: string; meta?: Record<string, unknown>; tags?: readonly TagRef[] }
    | Promise<{ userId?: string; meta?: Record<string, unknown>; tags?: readonly TagRef[] }>;
}

/** One registered outgoing hook and its owner. */
export interface OutgoingHookEntry {
  handler: (frame: InterceptPrimitive.OutgoingFrame) => void | Promise<void>;
  owner: InterceptPrimitive.FrameOwner;
}

/**
 * All hook registries the engine fills during primitive setup.
 *
 * These are the runtime lists and maps the engine dispatches later while
 * processing messages, connections, shutdown, and alarms.
 */
export interface RegisteredEngineHooks {
  /** Fires on every text frame — used by keepalive to reset idle timers. */
  activity: ((connectionId: string) => void | Promise<void>)[];

  /**
   * Fires on every valid event frame the client sends — protocol frames like
   * `__subscribe__` / `__received__` and app events — but not on transport
   * keepalive pings. Used by last-seen to stamp real activity, not just the fact
   * that the connection is still alive.
   */
  messageActivity: ((connectionId: string) => void | Promise<void>)[];

  /**
   * Fires when a client sends a bare `ping` frame. The engine registers the
   * first handler itself, and that handler replies `pong`, so every server
   * answers a probing client whether or not `keepalive()` is listed.
   */
  ping: ((connectionId: string) => void | Promise<void>)[];

  /**
   * Fires when a client sends a bare `pong` frame — its reply to a ping the
   * server sent. `keepalive()` registers a handler here to measure the
   * round-trip time. The engine records nothing on its own.
   */
  pong: ((connectionId: string) => void | Promise<void>)[];

  /**
   * The app's own `base.onPing` hooks, kept apart from the engine and capability
   * `ping` hooks so the dispatch can run them last — after `keepalive()` and any
   * plugin observers, matching the capability → plugin → app order.
   */
  appPing: ((connectionId: string) => void | Promise<void>)[];

  /** The app's own `base.onPong` hooks, kept apart for the same ordering reason. */
  appPong: ((connectionId: string) => void | Promise<void>)[];

  /**
   * Fires once per closed connection, during the engine's own teardown and
   * after every `disconnect` hook has had its turn. Unlike `disconnect`, this
   * always runs — a throwing user hook cannot skip it — so it is where a
   * capability releases per-connection resources such as timers.
   */
  connectionCleanup: ((connectionId: string) => void)[];

  /** Runs before routing — can observe or rewrite the payload (event is locked). */
  incoming: ((message: MessageParameter) => unknown | void)[];

  /**
   * Settle a server→client request answer. A user-event frame carrying a
   * `correlationId` is offered to each hook before normal routing; a hook
   * returns `true` when the id matches a pending server-initiated request it
   * owns (validating the answer and resolving/rejecting the server promise),
   * which stops routing. Owned by the `serverRequests()` capability so the core never
   * imports the pending-request map.
   */
  answerFrame: ((connectionId: string, frame: FrameParameter) => boolean)[];

  /**
   * The `onOutgoing` watchers. Each runs once per app send, after the frame
   * went out. Each entry carries its owner so its own event names can be
   * presented in short form.
   */
  outgoing: OutgoingHookEntry[];

  /**
   * Contributors of `__livething` metadata on outgoing user frames — the delivery sequence
   * number and the dedup id. Each returns a partial `__livething` object merged
   * into the frame. Skipped for protocol frames.
   */
  livethingStamp: ((event: string) => Record<string, unknown>)[];

  /** Runs once per broadcast, before any recipient is sent the frame. */
  beforeBroadcast: ((message: WireBroadcastMessage) => void)[];

  /** Runs once per broadcast, after every recipient was sent the frame. */
  afterBroadcast: ((message: WireBroadcastMessage) => void | Promise<void>)[];

  /** Handlers for reserved client protocol events (subscribe, replay, etc.). */
  protocol: Map<
    Protocol.IncomingProtocolEvent,
    ((
      ctx: any,
      frame: Protocol.IncomingProtocolFrame,
    ) => boolean | void | Promise<boolean | void>)[]
  >;

  /** Factories that add extra fields/methods to every connection context. */
  contextExtenders: ((ctx: any) => Record<string, unknown>)[];

  /** Runs during primitive setup, before `init` hooks — for internal bootstrap. */
  boot: (() => void | Promise<void>)[];

  /**
   * Like `boot`, but for `ensure*Schema` calls that issue `CREATE TABLE IF
   * NOT EXISTS`. These hooks run on every boot so a capability added after
   * storage was initialized still creates its tables on the next wake.
   */
  bootSchema: (() => void | Promise<void>)[];

  /**
   * Per-user durable cleanup for `admin().purgeUser()`. Registered by a
   * capability that owns per-user durable rows (channel membership,
   * persistent tags, ...). Runs before the user's live sockets are closed.
   * The `core` argument is the live engine core, opaque here. `options` carries
   * the caller's purge options; a hook that has no use for them takes fewer
   * parameters and ignores it.
   */
  purgeUser: ((core: any, userId: string, options?: any) => void | Promise<void>)[];

  /** Runs once during `engine.initialize()` — for framework-level startup. */
  init: ((ctx: any) => void | Promise<void>)[];

  /** Runs after each new connection is accepted. */
  connect: ((ctx: any) => void | Promise<void>)[];

  /** Runs after a connection closes. */
  disconnect: ((ctx: any) => void | Promise<void>)[];

  /** Runs during graceful engine shutdown. */
  shutdown: ((ctx: any) => void | Promise<void>)[];

  /** Observes unrecognized runtime errors before the client gets `__error__`. */
  error: ((ctx: any, error: unknown, event?: string) => void | Promise<void>)[];

  /**
   * Internal-primitive upgrade hooks. Run before the user-facing builder
   * hook so the user's hook always wins on meta key conflict. Tag results
   * union across all hooks (no conflict possible).
   */
  upgrade: ((
    request: Request,
    helpers: LifecycleTypes.UpgradeHelpers,
  ) =>
    | { meta?: Record<string, unknown>; tags?: readonly TagRef[] }
    | Promise<{
        meta?: Record<string, unknown>;
        tags?: readonly TagRef[];
      }>)[];

  /**
   * The single user-facing `.onUpgrade(...)` hook from the builder.
   * Runs last in the upgrade phase; its meta keys override any internal
   * hook on conflict. The lifecycle primitive registers through
   * `setBuilderUpgradeHook`, which throws if called twice.
   */
  builderUpgrade:
    | ((
        request: Request,
        helpers: LifecycleTypes.UpgradeHelpers,
      ) =>
        | { userId?: string; meta?: Record<string, unknown>; tags?: readonly TagRef[] }
        | Promise<{
            userId?: string;
            meta?: Record<string, unknown>;
            tags?: readonly TagRef[];
          }>)
    | undefined;

  /**
   * Plugin lifecycle hooks, kept apart from the app's so they run in
   * the onion order: inbound (`init`/`connect`) runs plugins → app, and
   * outbound (`disconnect`/`shutdown`) runs app → plugins (LIFO). Each entry
   * carries its plugin id and a global registration index so the engine can sort
   * deterministically. Handlers are already wrapped in a plugin-scoped ctx.
   */
  pluginLifecycle: PluginLifecycleHooks;

  /**
   * Plugin `upgrade` hooks, in registration order. Run before the
   * app's builder upgrade hook; meta is shallow-merged (the app wins on key
   * conflict), tags concatenated, and at most one hook (these or the app's) may
   * return `userId`.
   */
  pluginUpgrade: PluginUpgradeEntry[];

  /** Runs when the adapter fires a scheduled callback. */
  alarm: (() => void | Promise<void>)[];

  /** Async check phase per channel key — runs before a subscription is confirmed. */
  check: Map<string, ChannelCheckHook[]>;
  /** Re-authorization phase per channel key — runs only on auto-rejoin, for revocation. */
  revalidate: Map<string, ((ctx: any) => void | Promise<void>)[]>;
  /** Sync commit phase per channel key — runs immediately before membership is written. */
  commit: Map<string, ChannelCommitHook[]>;

  /** Runs after a channel subscription succeeds, keyed by channel key. */
  subscribe: Map<string, ((ctx: any) => void | Promise<void>)[]>;

  /** Runs after a channel unsubscription completes, keyed by channel key. */
  unsubscribe: Map<string, ((ctx: any) => void | Promise<void>)[]>;

  /**
   * Runs whenever this connection's view of a channel ends — true leave OR
   * plain disconnect. Keyed by channel key. Use for per-session cleanup.
   */
  sessionEnd: Map<string, ((ctx: any) => void | Promise<void>)[]>;
}

/**
 * Mutable in-memory state for one live connection.
 *
 * This is the engine's private record for a websocket connection while it is
 * active.
 */
export interface RuntimeConnection {
  /** Unique connection ID assigned by the engine. */
  id: string;

  /**
   * Stable string identifying the user-equivalent entity behind this socket.
   * Returned from `onUpgrade` and reused as the row key for any per-user
   * durable state. Empty string means "no user id supplied" — an anonymous
   * connection has no user identity at all. Runtime code that needs a storage
   * key for such a connection must use `connectionStorageKeyOf(connection)`,
   * which falls back to the connection's own id so two anonymous connections
   * never share a row.
   */
  userId: string;

  /** Opaque key the adapter uses to identify the underlying WebSocket. */
  wsKey: unknown;

  /** Low-level send/close callbacks provided by the adapter. */
  descriptor: EngineAdapterTypes.SocketDescriptor;

  /** Arbitrary metadata attached during onUpgrade (e.g. username, role). */
  meta: Record<string, unknown>;

  /**
   * A secret, random token the client gets in `__resume__` when replay is on.
   * Frames sent to this connection are recorded under it, and the client shows
   * it in a later `__replay__` to get them back on a new connection.
   */
  resumeToken?: string;

  /**
   * Per-group tag storage. Outer key is the group name, inner Set is the
   * keys held under that group. The `(kind, group)` split is enforced at
   * the API surface via separate `ctx.tags.ephemeral()` and
   * `ctx.tags.persistent()` group handles — at the connection level the
   * same group name can appear under both kinds because the engine
   * separates the two storage areas.
   */
  tags: { ephemeral: Map<string, Set<string>>; persistent: Map<string, Set<string>> };

  /**
   * Map of membership keys to channel details, with an explicit family marker.
   *
   * `channelFamily` is `null` for static channels and the family key for
   * dynamic channel families. Encoding the marker as a tuple key keeps the
   * same concrete channel name in two families (or a static channel and a
   * family that share a name) isolated. Scope-aware lookups (membership
   * checks, member listings, kick filters, broadcasts) all read this map.
   */
  channelMemberships: Map<string, { channelName: string; channelFamily: string | null }>;

  /**
   * Most recent round-trip latency in milliseconds, or `null` when nothing has
   * measured one. Only `keepalive()` measures; without it this stays `null`.
   */
  latency: number | null;

  /** Connection quality tier derived from recent latency samples. */
  quality: 'excellent' | 'good' | 'degraded' | 'poor';

  /** Resolves once the onConnect lifecycle hook has finished running. */
  lifecycleReady?: Promise<void>;

  /** Ordered app work waiting for this connection. */
  workQueue?: ConnectionWorkQueue;

  /** Handle for the idle timer armed by `refreshConnectionIdleTimeout`. */
  keepaliveTimer?: unknown;

  /**
   * Bounded ring of `messageId` values already seen on this connection, used
   * by `dedup()` to drop duplicate incoming frames before they reach handlers.
   * Lazy-initialized on first seen id; `undefined` when dedup is off or the
   * connection has not yet received an id-bearing frame.
   */
  seenIncomingIds?: { buf: string[]; writePtr: number; set: Set<string>; cap: number };

  /**
   * IDs of streams currently in-flight for this connection. Written into the
   * hibernation attachment so orphaned streams can be signalled with `__error__`
   * on wake. Lazy-initialized when the first stream starts.
   */
  activeStreamIds?: Set<string>;

  /**
   * `__streamCancel__` frames still running, by stream ID. A reconnect for the
   * same stream waits for its cancel, so it cannot restart a cancelled stream.
   */
  cancellingStreams?: Map<string, Promise<void>>;

  /**
   * `__subscribe__` frames still running, by channel key. A later frame for the
   * same channel waits for its subscribe, so the server handles it in the
   * order the client sent it.
   */
  pendingSubscribes?: Map<string, Promise<void>>;

  /**
   * While set and `active`, the engine is inside the connection-accept window
   * (initial row already inserted, `onConnect` running). Per-state-change row
   * writes are skipped so a single flush at the end of the hook commits the
   * full state in one statement. Cleared after the flush.
   */
  pendingWrites?: { active: boolean };

  /**
   * Set once close cleanup starts. After this flips to true, attachment
   * persistence must no-op so channel/session teardown cannot recreate a
   * hibernation row for a dead connection.
   */
  closing?: boolean;

  /**
   * Fingerprint of the last connection row written to durable storage. The
   * hibernation persist path stringifies the next row, compares against this
   * value, and skips the SQL write when they match — eliminating redundant
   * `INSERT OR REPLACE` calls for state-change sequences that produce the
   * same row twice in a row (no-op tag toggles, idempotent re-subscribes,
   * etc). `undefined` before the first persist.
   */
  lastPersistedFingerprint?: string;
}

/** Admitted but unfinished ordered app work for one connection. */
interface ConnectionWorkQueue {
  tail: Promise<void>;
  pending: number;
}

/**
 * Runtime bookkeeping for one active stream generator.
 *
 * Tracks the live generator, any queued nudges, and whether the stream has
 * been closed.
 */
export interface ActiveStream {
  id: string;

  connectionId: string;

  /**
   * The trigger event name that started this stream. Used to enforce
   * per-connection per-event exclusivity (one active stream per event per
   * connection by default) unless the stream set `allowConcurrent: true`.
   */
  event: string;

  generator: AsyncGenerator<unknown, void, unknown>;

  nudges: { event: string; payload: unknown }[];

  nudgeValidators: Map<string, unknown>;

  closed: boolean;

  /**
   * True when the owning connection of a recorded stream has dropped and the
   * generator is still producing into storage with no client attached. The
   * runtime skips wire sends to the dropped connection while this is set.
   */
  detached?: boolean;

  /**
   * The live connection the generator should send chunks to. Mutated when a
   * continuing client adopts a running recorded stream so the generator's next
   * yield lands on the new wire.
   */
  connection?: RuntimeConnection;

  /**
   * The scope the stream was started in. A nudge must resolve to this exact
   * scope and the connection must still hold its membership — a nudge that
   * claims a different (or no) scope is rejected, not silently accepted.
   */
  scope?: ResolvedChannel;

  /**
   * In-memory chunk count for a recorded stream with a `maxChunks` cap. Seeded
   * from storage on the first chunk (so a reconnect stays correct) and incremented
   * per append, so the cap check skips a `COUNT(*)` on every chunk.
   */
  recordedChunkCount?: number;

  /**
   * Per-stream stop signal. Its `.signal` is exposed as `ctx.stream.signal` so
   * generator code can pass it into slow awaited work (`fetch`, timers, …). The
   * runtime aborts it on client cancel, owning-connection disconnect, and server
   * shutdown — always before `generator.return()` so in-flight work stops first.
   */
  abortController: AbortController;

  /**
   * True for a plain broadcast stream (`broadcast: true`). Cancel uses it to fan
   * a terminal `__streamEnd__` out to the fan-out peers, so a creator cancel
   * doesn't leave their `onStream` runs open until timeout.
   */
  broadcast?: boolean;

  /**
   * True for a recorded stream. It keeps running when its owner disconnects,
   * and leaving the stream's channel hands it to the durable runtime so its
   * stored row is removed too.
   */
  durable?: boolean;
}

/**
 * Extra routing metadata attached to one outgoing message.
 *
 * The engine uses this to carry channel, correlation, and stream
 * routing information through the send pipeline.
 */
export interface RoutingTarget {
  channel?: string;

  /**
   * Channel family marker. `null` for static channels (no family), a non-empty
   * family key for dynamic channel families, `undefined` when the route does
   * not target a channel at all (e.g. a top-level send).
   */
  channelFamily?: string | null;

  correlationId?: string;

  /**
   * The side that originated the exchange this outgoing frame belongs to,
   * stamped as `__livething.source`. A server→client request sets `'server'`; the
   * server's reply to a client's request sets `'client'`. It lets the client
   * tell a server-initiated request apart from a reply to its own request, so it
   * can fast-fail (`__error__` `request-no-response`) when it has no handler for
   * the event instead of leaving the server's pending promise to hang to timeout.
   */
  source?: 'server' | 'client';

  streamId?: string;

  /**
   * Delivery sequence number to stamp on normal outgoing frames as
   * `__livething.deliverySeq`.
   */
  deliverySeq?: number;

  /** Stream chunk/end sequence number used by continue and replay. */
  streamSeq?: number;

  /**
   * Stamped on a stream's outgoing frames as `__livething.streamDurability`: `ephemeral`
   * for a plain stream, `persistent` for a durable one. Lets a subscriber know
   * whether the stream is durable regardless of when it joined.
   */
  streamDurability?: 'ephemeral' | 'persistent';
}

/**
 * The resolved channel for one incoming message.
 *
 * This is the engine's parsed view of `__livething.channel` and
 * `__livething.channelFamily` markers from the incoming frame.
 */
export interface ResolvedChannel {
  channel?: EngineCompileTypes.CompiledChannel;

  channelName?: string;

  /**
   * Family marker for channel-scoped frames: `null` when the frame targets a
   * static channel, the family key when it targets a dynamic family, and
   * `undefined` when no channel is in scope at all.
   */
  channelFamily?: string | null;
}

/**
 * Shared dependency bag for helpers that need connection lookup and channel
 * membership data.
 */
export interface ConnectionMembersRuntime {
  connections: Map<string, RuntimeConnection>;

  channelMembers: Map<string, Set<RuntimeConnection>>;

  compiled: EngineCompileTypes.CompiledServer;

  toConnectionInfo(
    connection: RuntimeConnection,
  ): PublicApi.ConnectionInfo<Record<string, unknown>>;

  sendThroughPipeline(connection: RuntimeConnection, opts: OptsParameter2): boolean;

  /** Open one send to many connections: one stamp, one frame, one `onOutgoing` call. */
  openSharedSend(opts: SharedSendOptions): SharedSend;
}
