import type { Engine as EngineClass } from '~/_engine/engine.ts';
import type {
  AsyncContextFactory,
  Logger,
  StorageProvider,
  TagRef,
  TimerProvider,
} from '~/context.ts';
import type { ServerDefinition } from '~/server-definition.ts';

/**
 * One frame the engine hands a transport. A WebSocket sends a `text` frame as a text
 * message and a `bytes` frame as a binary message. The bytes are always backed by a plain
 * `ArrayBuffer`, which is what a web `WebSocket.send()` accepts.
 *
 * `shared` marks a text frame that the engine hands to many sockets as the same object, as a
 * broadcast does. A transport can turn its text into bytes once and reuse them for each socket.
 */
export type TransportFrame =
  | { kind: 'text'; text: string; shared?: boolean }
  | { kind: 'bytes'; bytes: Uint8Array<ArrayBuffer> };

/** The low-level send/close callbacks of one accepted WebSocket. */
export interface SocketDescriptor {
  /**
   * Returning `false` means the descriptor deliberately did not put the frame
   * on the wire. The outgoing pipeline does not count it as delivered.
   */
  send(frame: TransportFrame): unknown;

  close(code?: number, reason?: string): void;

  /**
   * Drop the connection at once, with no close handshake. Optional. The engine calls it one
   * second after it closes a client that reads too slowly (`1013`), because that client may never
   * read the close frame queued behind its unsent data. Without it, the platform's own close
   * timeout decides when the socket goes away.
   */
  terminate?(): void;

  bufferedAmount(): number;

  /**
   * Whether this connection exposes real outbound buffer pressure through
   * `bufferedAmount()`. When `true` (Node, and SSE on Cloudflare), `ctx.stream.drain()`
   * paces the generator against the live buffer. When `false` or absent (a WebSocket on
   * Cloudflare, which does not expose buffer fullness), `bufferedAmount()` is treated as
   * unsupported and `drain()` resolves immediately as a no-op.
   */
  backpressureSupported?: boolean;
}

/**
 * The low-level send/close callbacks an adapter provides for each WebSocket,
 * plus the identity its authenticate gave the connection.
 *
 * When you build a custom platform adapter, you create one of these for every
 * accepted connection so the engine can push data to the client.
 */
export interface ConnectionDescriptor extends SocketDescriptor {
  /**
   * The user this socket belongs to, forwarded from the `onAuthenticate` result.
   * Required because the descriptor is only built for an accepted connection — by
   * then the answer is known. An empty string means the authenticate returned no
   * user id, so the connection is anonymous.
   */
  userId: string;

  meta?: Record<string, unknown>;

  tags?: readonly TagRef[];

  /**
   * Whether the platform holds this connection while the server sleeps, as a Cloudflare
   * socket accepted through the hibernation API does. Default: `false`. When `true`, the
   * engine runs no keepalive timers for the connection, sends `null` ping timings in its
   * `__connected__` frame, and saves its state through `hibernation.persist` so a wake can
   * rebuild it. When `false`, the engine runs the timers and saves nothing for a wake.
   */
  survivesHibernation?: boolean;

  /**
   * The secret a client sends with each POST to this connection, or `null` (the default)
   * when the transport has none. The engine puts it in the `__connected__` frame.
   */
  secret?: string | null;

  /**
   * The largest POST body this connection accepts, in bytes, or `null` (the default) when
   * it receives no POSTs. The engine puts it in the `__connected__` frame.
   */
  maxPostBytes?: number | null;
}

/**
 * Callbacks the engine returns after accepting a connection.
 *
 * The adapter calls these when the underlying WebSocket receives a message,
 * closes, or encounters an error.
 */
export interface ConnectionHandle {
  handleMessage(data: string): Promise<void>;

  /** A binary message, as a plain `Uint8Array` view of its bytes. */
  handleBinaryMessage(data: Uint8Array): Promise<void>;

  handleClose(code: number, reason: string): Promise<void>;

  handleError(error: unknown): Promise<void>;
}

/**
 * The result of the `onAuthenticate` hook — tells the adapter whether to accept or
 * reject the connection, along with any initial metadata and tags.
 */
export interface AuthDecision {
  reject?: boolean;

  code?: number;

  reason?: string;

  /**
   * The user this socket belongs to. Set when `reject` is falsy — every
   * accepted authenticate carries it. Omitted on reject decisions, where there is no
   * connection to attach it to.
   */
  userId?: string;

  meta?: Record<string, unknown>;

  tags?: readonly TagRef[];
}

/**
 * The pluggable mechanism an adapter provides for persisting and restoring
 * per-socket state across hibernation cycles. The engine writes a snapshot to
 * `persist(socketKey, snapshot)` whenever connection state changes; on wake,
 * `restore(socketKey)` returns the most recent snapshot the platform held onto.
 * Both callbacks must finish synchronously. The engine rejects a Promise or
 * thenable from either callback because a hibernation wake cannot safely defer
 * its attachment or index updates.
 *
 * Adapters that support hibernation declare this object on their
 * `adapter` config; adapters that don't omit it. The presence of
 * the object is the capability signal — there is no separate boolean flag.
 *
 * Cloudflare implementation:
 * ```ts
 * {
 *   persist: (ws, snapshot) => (ws as WebSocket).serializeAttachment(snapshot),
 *   restore: (ws)            => (ws as WebSocket).deserializeAttachment(),
 * }
 * ```
 */
interface HibernationApi {
  persist(socketKey: unknown, snapshot: unknown): void;

  restore(socketKey: unknown): unknown;
}

/** Runtime surfaces a platform adapter must provide for each engine instance. */
export interface EngineRuntimeOptions {
  /** Adapter-provided SQL and key-value storage surface. Every adapter provides this. */
  storage: StorageProvider;

  /** Adapter-specific platform object exposed as `ctx.platform`. */
  platform: unknown;

  /** Adapter-provided durable alarm implementation. Every adapter provides this. */
  timers: TimerProvider;

  /** Structured logger exposed as `ctx.log`. */
  logger: Logger;

  /**
   * The largest message, in bytes, the platform can receive and send. The engine closes a
   * connection with `1009` (`CloseCodes.MESSAGE_TOO_BIG`) for a bigger incoming message, and
   * throws instead of sending a bigger one. Default: 32 MiB each.
   */
  messageLimits?: MessageLimits;
}

/** An adapter's message limits, in bytes. See `EngineRuntimeOptions.messageLimits`. */
export interface MessageLimits {
  receiveBytes: number;
  sendBytes: number;
  /**
   * The largest POST body, when the adapter takes messages over POST (server-sent events).
   * At most half of `receiveBytes`, so one POST of frames fits the connection's budget.
   */
  postBytes?: number;
}

/** Complete configuration passed to the engine constructor by the adapter factory. */
export interface EngineOptions extends EngineRuntimeOptions {
  /**
   * Stable identifier for the adapter, used for wake/hibernate routing on
   * platforms that need to look up the right engine after a cold start.
   */
  adapterId: string;

  /**
   * Adapter-provided hibernation persistence mechanism. Present when the
   * adapter supports hibernation; omitted otherwise. The engine validates at
   * `initialize()` that this is present whenever the server definition sets
   * `hibernation: true` and throws a clear error if the combination is
   * unsupported.
   */
  hibernation?: HibernationApi;

  /**
   * Factory for the async-context implementation used by this runtime. It must
   * return a new store on every call.
   */
  asyncContextFactory: AsyncContextFactory;
}

/**
 * The runtime engine created by the adapter from a compiled server definition.
 * Handles connections, message routing, and lifecycle. `TApi` carries the
 * server definition's `api` type through to {@link EngineClass.admin}. An adapter with
 * multiple addressable instances should call `setInstanceId(...)` before
 * accepting connections so refs cannot be confused across instances.
 */
export type Engine<TApi = unknown> = EngineClass<TApi>;

/**
 * The configuration object returned by `adapter`.
 *
 * Platform adapters (like the Cloudflare adapter) use this to wire up the
 * engine to the platform's WebSocket lifecycle.
 */
export interface AdapterConfig<TOptions, TService> {
  id: string;

  /**
   * Adapter-provided hibernation persistence. Adapters that don't support
   * hibernation omit this field; the engine then rejects any contract that
   * set `hibernation: true` at `initialize()` time.
   */
  hibernation?: HibernationApi;

  /**
   * Factory for the async-context implementation this runtime uses. Declared
   * here, alongside `hibernation`, because it is a static capability of the
   * adapter — it does not depend on any per-instance state, so it is set once
   * at definition time rather than rebuilt inside every `createEngine` call.
   * It must return a new store on every call: the engine also calls it once for
   * the store that the `context.*` accessors share across the process.
   */
  asyncContextFactory: AsyncContextFactory;

  /**
   * Wire the platform's WebSocket lifecycle to an engine instance.
   *
   * `TApi` is the server definition's `api` type, so `engine.admin()` is already typed
   * here. TypeScript cannot make `TService` itself depend on `TApi`, so an
   * adapter whose service should carry the app's admin methods exports a thin
   * generic `bind(definition)` of its own on top of this.
   */
  setup<TApi>(
    createEngine: (runtimeOptions: EngineRuntimeOptions) => Engine<TApi>,
    options: TOptions,
    /** The definition being bound, for startup checks such as `resolveTransports`. */
    definition: ServerDefinition,
  ): TService;
}
