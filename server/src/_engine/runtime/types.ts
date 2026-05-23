/* oxlint-disable @typescript-eslint/no-explicit-any */
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as PublicApi from '~/context.ts';
import type { TagRef } from '~/context.ts';
import type * as LifecycleTypes from '~/lifecycle/lifecycle.ts';
import type * as ValidationTypes from '~/types.ts';

/**
 * One `onBeforeSubscribe` hook plus its optional validator.
 *
 * The validator runs first so the hook can receive a typed, already-checked
 * subscription payload.
 */
export interface ChannelBeforeSubscribeHook {
  handler: (ctx: any, data?: unknown) => void | Promise<void>;
  validator?: ValidationTypes.Validator<any>;
}

/**
 * One finalized outgoing wire message.
 *
 * At this point the outgoing hooks have run and the framework metadata —
 * routing markers, sequence number, dedup id — has been collected into
 * `wskit`, the frame's `__wskit` sibling. `payload` is pure user data.
 */
export interface WireOutgoingMessage {
  connectionId: string;
  event: string;
  payload: Record<string, unknown>;
  wskit: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/**
 * Reserved websocket events that can arrive from the client into the engine.
 *
 * These are the protocol-level messages wskit itself understands before app
 * handlers run. Built-in primitives can hook into these names through
 * `onProtocolMessage(...)`.
 */
export type IncomingProtocolEvent = Protocol.IncomingProtocolEvent;

/**
 * All hook registries the engine fills during primitive setup.
 *
 * These are the runtime lists and maps the engine dispatches later while
 * processing messages, connections, shutdown, and alarms.
 */
export interface RegisteredEngineHooks {
  // -- Message pipeline hooks -------------------------------------------------

  /** Fires on every text/binary frame — used by heartbeat to reset idle timers. */
  activity: ((connectionId: string) => void | Promise<void>)[];

  /** Runs before routing — can observe or rewrite the payload (event is locked). */
  incoming: ((message: { event: string; payload: unknown }) => unknown | void)[];

  /** Runs before wire serialization — can observe or rewrite the payload (event is locked). */
  outgoing: ((message: { event: string; payload: unknown }) => unknown | void)[];

  /**
   * Contributors of `__wskit` metadata on outgoing user frames — the sequence
   * number and the dedup id. Each returns a partial `__wskit` object merged
   * into the frame. Skipped for protocol frames.
   */
  wskitStamp: ((event: string) => Record<string, unknown>)[];

  /** Runs after wire metadata is attached but before the frame is sent. */
  beforeSend: ((message: WireOutgoingMessage) => void)[];

  /** Runs after a frame is sent — for best-effort side effects like replay storage. */
  afterSend: ((message: WireOutgoingMessage) => void | Promise<void>)[];

  /** Handlers for reserved client protocol events (subscribe, replay, etc.). */
  protocol: Map<
    IncomingProtocolEvent,
    ((
      ctx: any,
      frame: Protocol.IncomingProtocolFrame,
    ) => boolean | void | Promise<boolean | void>)[]
  >;

  // -- Context extension ------------------------------------------------------

  /** Factories that add extra fields/methods to every connection context. */
  contextExtenders: ((ctx: any) => Record<string, unknown>)[];

  // -- Lifecycle hooks --------------------------------------------------------

  /** Runs during primitive setup, before `init` hooks — for internal bootstrap. */
  boot: (() => void | Promise<void>)[];

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
        | { identity?: string; meta?: Record<string, unknown>; tags?: readonly TagRef[] }
        | Promise<{
            identity?: string;
            meta?: Record<string, unknown>;
            tags?: readonly TagRef[];
          }>)
    | undefined;

  /** Handles raw binary frames that bypass the JSON pipeline. */
  binary: ((ctx: any, data: ArrayBuffer) => void | Promise<void>)[];

  /** Observes incoming payloads that fail schema validation. */
  validationError: ((ctx: any, event: string, validationError: unknown) => void | Promise<void>)[];

  // -- Scheduled work ---------------------------------------------------------

  /** Runs when the adapter fires a scheduled alarm. */
  alarm: (() => void | Promise<void>)[];

  // -- Channel membership -----------------------------------------------------

  /** Auth gates per channel key — runs before a subscription is confirmed. */
  beforeSubscribe: Map<string, ChannelBeforeSubscribeHook[]>;

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
  // -- Identity --
  /** Unique connection ID assigned by the engine. */
  id: string;
  /**
   * Stable string identifying the user-equivalent entity behind this socket.
   * Returned from `onUpgrade` and reused as the row key for any per-user
   * durable state. Required even when no persistence wrapper is active so
   * the engine can index live connections by identity in storage and logs.
   */
  identity: string;
  /** Opaque key the adapter uses to identify the underlying WebSocket. */
  wsKey: unknown;
  /** Low-level send/close callbacks provided by the adapter. */
  descriptor: EngineAdapterTypes.ConnectionDescriptor;
  /** Arbitrary metadata attached during onUpgrade (e.g. username, role). */
  meta: Record<string, unknown>;

  // -- Channel state --
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
   * Map of membership keys to channel details, with an explicit scope marker.
   *
   * `channelScope` is `null` for static channels and the family key for
   * dynamic channel families. Encoding the marker as a tuple key keeps the
   * same concrete channel name in two families (or a static channel and a
   * family that share a name) isolated. Scope-aware lookups (membership
   * checks, member listings, kick filters, broadcasts) all read this map.
   */
  channelMemberships: Map<string, { channelName: string; channelScope: string | null }>;

  // -- Ephemeral runtime state --
  /** Most recent measured round-trip latency in milliseconds, or null if not yet measured. */
  latency: number | null;
  /** Connection quality tier derived from recent latency samples. */
  quality: 'excellent' | 'good' | 'degraded' | 'poor';
  /** Resolves once the onConnect lifecycle hook has finished running. */
  lifecycleReady?: Promise<void>;
  /** Handle for the heartbeat timeout timer. */
  heartbeatTimer?: unknown;
  /** Handle for the next scheduled ping timer. */
  pingTimer?: unknown;
  /** Timestamp (ms) when the last ping was sent, used to compute latency. */
  pendingPingSentAt?: number;
  /** Sliding window of recent latency samples for quality calculation. */
  recentLatencies?: number[];
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
   * While set and `active`, the engine is inside the connection-accept window
   * (initial row already inserted, `onConnect` running). Per-state-change row
   * writes are skipped so a single flush at the end of the hook commits the
   * full state in one statement. Cleared after the flush.
   */
  pendingWrites?: { active: boolean };
}

/**
 * What the framework does to a durable stream's generator when the owning
 * connection drops.
 *
 * - `'cancel-but-buffer'` (default) — stop the generator; keep the cursor /
 *   buffered chunks for resume.
 * - `'keep-running'` — leave the generator producing into storage with no
 *   client attached. Server resources stay open until it ends on its own.
 */
export type OnDisconnect = 'cancel-but-buffer' | 'keep-running';

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
   * connection by default) unless the stream opted in via `.allowConcurrent()`.
   */
  event: string;
  generator: AsyncGenerator<unknown, void, unknown>;
  nudges: { event: string; payload: unknown }[];
  nudgeValidators: Map<string, unknown>;
  closed: boolean;
  /**
   * `'cancel-but-buffer'` (default for durable, only value for non-durable) or
   * `'keep-running'`. Drives whether `cancelActiveStreamsForConnection` calls
   * `generator.return()` on the owning connection's close.
   */
  onDisconnect?: OnDisconnect;
  /**
   * True when the owning connection has dropped on a `keep-running` stream and
   * the generator is still producing into storage with no client attached. The
   * runtime skips wire sends to the dropped connection while this is set.
   */
  detached?: boolean;
  /**
   * The live connection the generator should send chunks to. Mutated when a
   * resuming client adopts a previously-detached `keep-running` stream so the
   * generator's next yield lands on the new wire.
   */
  connection?: RuntimeConnection;
}

/**
 * Runtime hooks and context factory for one installed module.
 *
 * Each installed module gets one of these records so the engine can call the
 * module's hooks and build its scoped helper API when needed.
 */
export interface ModuleRuntime {
  instance: EngineCompileTypes.AnyModule;
  onInit?: (ctx: any) => void | Promise<void>;
  onIncoming?: (message: { event: string; payload: unknown }) => unknown | void;
  onOutgoing?: (message: { event: string; payload: unknown }) => unknown | void;
  onConnect?: (ctx: any) => void | Promise<void>;
  onDisconnect?: (ctx: any) => void | Promise<void>;
  onShutdown?: () => void | Promise<void>;
  contextFactory: (ctx: any) => unknown;
}

/**
 * Extra routing metadata attached to one outgoing message.
 *
 * The engine uses this to carry namespace, channel, correlation, and stream
 * routing information through the send pipeline.
 */
export interface RoutingTarget {
  namespace?: string;
  channel?: string;
  /**
   * Channel scope marker. `null` for static channels (no scope), a non-empty
   * family key for dynamic channel families, `undefined` when the route does
   * not target a channel at all (e.g. a top-level or namespace send).
   */
  channelScope?: string | null;
  correlationId?: string;
  streamId?: string;
  /**
   * Sequence number to stamp on the outgoing frame as `__wskit.seq`. Used by
   * durable streams to give resume a stable cursor; plain streams rely on
   * the `sequence` primitive to inject this via onOutgoing instead.
   */
  seq?: number;
}

/**
 * The resolved scope for one incoming message.
 *
 * This is the engine's parsed view of `__wskit.namespace`, `__wskit.channel`,
 * and `__wskit.channelScope` markers from the incoming frame.
 */
export interface ResolvedScope {
  namespace?: EngineCompileTypes.CompiledNamespace;
  channel?: EngineCompileTypes.CompiledChannel;
  channelName?: string;
  /**
   * Scope marker for channel-scoped frames: `null` when the frame targets a
   * static channel, the family key when it targets a dynamic family, and
   * `undefined` when no channel is in scope at all.
   */
  channelScope?: string | null;
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
  sendThroughPipeline(
    connection: RuntimeConnection,
    routing: RoutingTarget | undefined,
    event: string,
    payload: unknown,
  ): boolean;
}
