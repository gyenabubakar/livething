import type { Engine as EngineClass } from '~/_engine/engine.ts';
import type {
  AsyncContextFactory,
  Logger,
  StorageProvider,
  TagRef,
  TimerProvider,
} from '~/context.ts';

/**
 * The low-level send/close callbacks an adapter provides for each WebSocket.
 *
 * When you build a custom platform adapter, you create one of these for every
 * accepted connection so the engine can push data to the client.
 */
export interface ConnectionDescriptor {
  /**
   * Returning `false` means the descriptor deliberately did not put the frame
   * on the wire. The outgoing pipeline uses this to skip `afterSend` hooks.
   */
  send(data: string): unknown;

  close(code?: number, reason?: string): void;

  bufferedAmount(): number;

  /**
   * Whether this platform exposes real outbound buffer pressure through
   * `bufferedAmount()`. When `true` (Node/Bun/Deno adapters), `ctx.stream.drain()`
   * paces the generator against the live buffer. When `false` or absent
   * (Cloudflare, which does not expose buffer fullness), `bufferedAmount()` is
   * treated as unsupported and `drain()` resolves immediately as a no-op. This is
   * a documented Cloudflare limitation, not a hidden difference.
   */
  backpressureSupported?: boolean;

  /**
   * The user this socket belongs to, forwarded from the `onUpgrade` result.
   * Required because the descriptor is only built for an accepted upgrade — by
   * then the answer is known. An empty string means the upgrade returned no
   * user id, so the connection is anonymous.
   */
  userId: string;

  meta?: Record<string, unknown>;

  tags?: readonly TagRef[];
}

/**
 * Callbacks the engine returns after accepting a connection.
 *
 * The adapter calls these when the underlying WebSocket receives a message,
 * closes, or encounters an error.
 */
export interface ConnectionHandle {
  handleMessage(data: string): Promise<void>;

  handleClose(code: number, reason: string): Promise<void>;

  handleError(error: unknown): Promise<void>;
}

/**
 * The result of the `onUpgrade` hook — tells the adapter whether to accept or
 * reject the WebSocket upgrade request, along with any initial metadata and tags.
 */
export interface UpgradeDecision {
  reject?: boolean;

  code?: number;

  reason?: string;

  /**
   * The user this socket belongs to. Set when `reject` is falsy — every
   * accepted upgrade carries it. Omitted on reject decisions, where there is no
   * connection to attach it to.
   */
  userId?: string;

  meta?: Record<string, unknown>;

  tags?: readonly TagRef[];
}

/**
 * The pluggable mechanism an adapter provides for persisting and restoring
 * per-socket state across hibernation cycles. The engine writes a snapshot to
 * `persist(wsKey, snapshot)` whenever connection state changes; on wake,
 * `restore(wsKey)` returns the most recent snapshot the platform held onto.
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
export interface HibernationApi {
  persist(wsKey: unknown, snapshot: unknown): void;

  restore(wsKey: unknown): unknown;
}

/** Runtime surfaces a platform adapter must provide for each engine instance. */
export interface EngineRuntimeOptions {
  /** Adapter-provided SQL and key-value storage surface. Every adapter provides this. */
  storage: StorageProvider;

  /** Env bindings exposed to every runtime context. */
  env: Record<string, unknown>;

  /** Adapter-specific platform object exposed as `ctx.platform`. */
  platform: unknown;

  /** Adapter-provided durable alarm implementation. Every adapter provides this. */
  timers: TimerProvider;

  /** Platform hook for background work that may outlive the current callback. */
  waitUntil: (promise: Promise<unknown>) => void;

  /** Structured logger exposed as `ctx.log`. */
  logger: Logger;
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
   * `initialize()` that this is present whenever the contract set
   * `hibernation: true` and throws a clear error if the combination is
   * unsupported.
   */
  hibernation?: HibernationApi;

  /** Factory for the async-context implementation used by this runtime. */
  asyncContextFactory: AsyncContextFactory;
}

/**
 * The runtime engine created by the adapter from a compiled server definition.
 * Handles connections, message routing, and lifecycle. `TApi` carries the
 * handler's `api` type through to {@link EngineClass.admin}. An adapter with
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
   */
  asyncContextFactory: AsyncContextFactory;

  /**
   * Wire the platform's WebSocket lifecycle to an engine instance.
   *
   * `TApi` is the handler's `api` type, so `engine.admin()` is already typed
   * here. TypeScript cannot make `TService` itself depend on `TApi`, so an
   * adapter whose service should carry the app's admin methods exports a thin
   * generic `server(handler)` of its own on top of this.
   */
  setup<TApi>(
    createEngine: (runtimeOptions: EngineRuntimeOptions) => Engine<TApi>,
    options: TOptions,
  ): TService;
}
