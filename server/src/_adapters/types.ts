import type * as EngineModule from '~/_engine/engine.ts';
import type { TagRef } from '~/context.ts';

/**
 * The low-level send/close callbacks an adapter provides for each WebSocket.
 *
 * When you build a custom platform adapter, you create one of these for every
 * accepted connection so the engine can push data to the client.
 */
export interface ConnectionDescriptor {
  send(data: string): void;
  sendBinary(data: ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  bufferedAmount(): number;
  /**
   * Stable string identifying the user-equivalent entity for this socket.
   * Forwarded from the `onUpgrade` result. Required because the descriptor is
   * only built for an accepted upgrade — by that point identity is known.
   */
  identity: string;
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
  handleBinary(data: ArrayBuffer): Promise<void>;
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
   * Stable string identifying the user-equivalent entity behind this socket.
   * Set when `reject` is falsy — every accepted upgrade carries it. Omitted
   * on reject decisions because there is no connection to attach it to.
   */
  identity?: string;
  meta?: Record<string, unknown>;
  tags?: readonly TagRef[];
}

/**
 * The pluggable mechanism an adapter provides for persisting and restoring
 * per-socket state across hibernation cycles. The engine writes a snapshot to
 * `persist(wsKey, snapshot)` whenever connection state changes; on wake,
 * `restore(wsKey)` returns the most recent snapshot the platform held onto.
 *
 * Adapters that support hibernation declare this object on their
 * `defineServerAdapter` config; adapters that don't omit it. The presence of
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

/** Configuration the adapter passes when creating an engine instance. */
export interface EngineOptions {
  /**
   * Stable identifier for the adapter, used for wake/hibernate routing on
   * platforms that need to look up the right engine after a cold start.
   */
  adapterId: string;
  /**
   * Adapter-provided hibernation persistence mechanism. Present when the
   * adapter supports hibernation; omitted otherwise. The engine validates at
   * `initialize()` that this is present whenever the handler called
   * `.hibernation()` and throws a clear error if the combination is
   * unsupported.
   */
  hibernation?: HibernationApi;
}

/** The runtime engine created by the adapter from a compiled server definition. Handles connections, message routing, and lifecycle. */
export type Engine = EngineModule.Engine;

/**
 * The configuration object returned by `defineServerAdapter`.
 *
 * Platform adapters (like the Cloudflare adapter) use this to wire up the
 * engine to the platform's WebSocket lifecycle.
 */
export interface AdapterConfig<TOptions, TService> {
  id: string;
  /**
   * Adapter-provided hibernation persistence. Adapters that don't support
   * hibernation omit this field; the engine then rejects any handler that
   * registered `.hibernation()` at `initialize()` time.
   */
  hibernation?: HibernationApi;
  setup(createEngine: () => Engine, options: TOptions): TService;
}
