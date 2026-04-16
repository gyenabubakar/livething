/* oxlint-disable @typescript-eslint/no-explicit-any */
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as PublicApi from '~/context.ts';
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
 * At this point sequence, dedup, routing markers, and other engine-owned
 * metadata have already been attached to `payload`.
 */
export interface WireOutgoingMessage {
  connectionId: string;
  event: string;
  payload: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/**
 * Reserved websocket events that can arrive from the client into the engine.
 *
 * These are the protocol-level messages wskit itself understands before app
 * handlers run. Built-in primitives can hook into these names through
 * `onProtocolMessage(...)`.
 */
export type IncomingProtocolEvent =
  | 'ping'
  | '_subscribe'
  | '_unsubscribe'
  | '_streamCancel'
  | '_replay';

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

  /** Runs before routing — can rewrite or observe raw incoming messages. */
  incoming: ((message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void)[];

  /** Runs before wire serialization — can rewrite or observe outgoing messages. */
  outgoing: ((message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void)[];

  /** Runs after wire metadata is attached but before the frame is sent. */
  beforeSend: ((message: WireOutgoingMessage) => void)[];

  /** Runs after a frame is sent — for best-effort side effects like replay storage. */
  afterSend: ((message: WireOutgoingMessage) => void | Promise<void>)[];

  /** Handlers for reserved client protocol events (subscribe, replay, etc.). */
  protocol: Map<
    IncomingProtocolEvent,
    ((
      ctx: any,
      payload: Record<string, unknown> | undefined,
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

  /** Observes unrecognized runtime errors before the client gets `_error`. */
  error: ((ctx: any, error: unknown, event?: string) => void | Promise<void>)[];

  /** Runs before the WebSocket handshake — for auth and connection limiting. */
  upgrade: ((request: Request) =>
    | { meta?: Record<string, unknown>; tags?: readonly string[] }
    | Promise<{
        meta?: Record<string, unknown>;
        tags?: readonly string[];
      }>)[];

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
  /** Opaque key the adapter uses to identify the underlying WebSocket. */
  wsKey: unknown;
  /** Low-level send/close callbacks provided by the adapter. */
  descriptor: EngineAdapterTypes.ConnectionDescriptor;
  /** Arbitrary metadata attached during onUpgrade (e.g. username, role). */
  meta: Record<string, unknown>;

  // -- Channel state --
  /** Tags currently assigned to this connection (used for sendTo/getConnectionsByTag). */
  tags: Set<string>;
  /** Set of channel names this connection has subscribed to. */
  channels: Set<string>;
  /** Map of membership keys to channel details, including optional scope. */
  channelMemberships: Map<string, { channelName: string; channelScope?: string }>;

  // -- Ephemeral runtime state --
  /** Most recent measured round-trip latency in milliseconds, or null if not yet measured. */
  latency: number | null;
  /** Connection quality tier derived from recent latency samples. */
  quality: 'excellent' | 'good' | 'degraded' | 'poor';
  /** Resolves once the onConnect lifecycle hook has finished running. */
  lifecycleReady?: Promise<void>;
  /** The _ackId of the message currently being handled, if ack is enabled. */
  activeAckId?: string;
  /** Handle for the heartbeat timeout timer. */
  heartbeatTimer?: unknown;
  /** Handle for the next scheduled ping timer. */
  pingTimer?: unknown;
  /** Timestamp (ms) when the last ping was sent, used to compute latency. */
  pendingPingSentAt?: number;
  /** Sliding window of recent latency samples for quality calculation. */
  recentLatencies?: number[];
}

/**
 * Runtime bookkeeping for one active stream generator.
 *
 * This tracks the live generator, any queued nudges, and whether the stream
 * has been closed.
 */
export interface ActiveStream {
  id: string;
  connectionId: string;
  generator: AsyncGenerator<unknown, void, unknown>;
  nudges: { event: string; payload: unknown }[];
  nudgeValidators: Map<string, unknown>;
  closed: boolean;
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
  onIncoming?: (message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void;
  onOutgoing?: (message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void;
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
  channelScope?: string;
  correlationId?: string;
  streamId?: string;
}

/**
 * The resolved scope for one incoming message.
 *
 * This is the engine's parsed view of `_namespace`, `_channel`, and
 * `_channelScope` markers from the incoming payload.
 */
export interface ResolvedScope {
  namespace?: EngineCompileTypes.CompiledNamespace;
  channel?: EngineCompileTypes.CompiledChannel;
  channelName?: string;
  channelScope?: string;
}

/**
 * Shared dependency bag for helpers that need connection lookup and channel
 * membership data.
 */
export interface ConnectionMembersRuntime {
  connections: Map<string, RuntimeConnection>;
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
