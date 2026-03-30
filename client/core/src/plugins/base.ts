import type { SocketOptions } from '@/options.ts';
import type { TypeFn } from '@/plugins/types.ts';
import type { ConnectionState } from '@/types.ts';

/**
 * Utilities for interacting with the socket internals. Set on the plugin
 * instance by `createSocket` before `install()` is called, and available
 * in all lifecycle hooks via `this.helpers`.
 */
export interface PluginHelpers {
  /** Send a raw message over the WebSocket. Bypasses plugin `onOutgoing` hooks to avoid infinite loops. */
  rawSend: (event: string, payload: unknown) => void;

  /**
   * Generate a unique ID, optionally prefixed for traceability.
   * Uses a single monotonic counter shared across all plugins on this socket,
   * so IDs never collide.
   *
   * ```ts
   * this.helpers.generateId('req')  // 'req-1'
   * this.helpers.generateId('ack')  // 'ack-2'
   * this.helpers.generateId()       // '3'
   * ```
   */
  generateId: (prefix?: string) => string;

  /** Current connection state. Useful for conditional plugin behavior. */
  getState: () => ConnectionState;

  /** Read-only, frozen copy of the socket options. Plugins can read config but not mutate it. */
  getOptions: () => Readonly<SocketOptions>;

  /**
   * Trigger a lazy connection if the socket is in lazy mode and not yet
   * connected. No-op if the socket is already open, connecting, or not lazy.
   *
   * Call this in plugin-installed methods (e.g., `request()`, `send.withAck()`,
   * `channel.on()`) so they work on a lazy socket that hasn't connected yet.
   */
  ensureConnected: () => void;

  /**
   * Send a message through the full pipeline: onOutgoing hooks → buffer
   * fallback → WebSocket. Unlike `rawSend`, this respects the buffer and
   * plugin hooks. Use this for plugin-installed methods that should behave
   * like `socket.send()` (e.g., channel send).
   */
  send: (event: string, payload: unknown, options?: { ttl?: number }) => boolean;

  /**
   * Increment the lazy consumer count and trigger connection if needed.
   * Call when registering a listener or starting a pending operation
   * (request, ack) that requires the socket to stay open.
   */
  lazyAcquire: () => void;

  /**
   * Decrement the lazy consumer count. When it reaches 0 and the socket
   * is in lazy mode, the idle disconnect timer starts.
   */
  lazyRelease: () => void;
}

/**
 * Base class for all plugins. Subclass this to create built-in or custom plugins.
 *
 * Type parameters:
 * - `F` — the plugin's type function (determines what API it adds to the socket).
 *         Use `StaticApi<{ ... }>` for APIs that don't depend on the contract.
 *         Omit for plugins that only use hooks and add no API.
 * - `TRequires` — contract constraints. Use `Requires<{ ... }>` to declare which
 *                 events must exist. Omit if the plugin works with any contract.
 */
export abstract class Plugin<F extends TypeFn = TypeFn, TRequires = {}> {
  /** Unique plugin identifier (e.g., `'channels'`, `'request-response'`). Used for debug logging. */
  abstract id: string;

  /**
   * Socket utilities available in all hooks and `install()`. Set by `createSocket`
   * before any hooks are called — never `undefined` during normal usage.
   *
   * Access `this.helpers.rawSend(event, payload)` to send messages directly
   * over the wire, bypassing plugin `onOutgoing` hooks.
   * @internal
   */
  // Set by createSocket before install() is called. The `!` (definite assignment
  // assertion) tells TypeScript "trust me, this will be set before use" — it's
  // never undefined during normal plugin usage.
  helpers!: PluginHelpers;

  /** Intercept incoming messages. Return the message, a modified message, or `null` to drop. */
  onIncoming?(message: {
    event: string;
    payload: unknown;
  }): { event: string; payload: unknown } | null;

  /** Intercept outgoing messages. Return the message, a modified message, or `null` to cancel. */
  onOutgoing?(event: string, payload: unknown): { event: string; payload: unknown } | null;

  /** Called on every connection open (first connect and reconnects). Return messages to send. */
  onOpen?(): { event: string; payload: unknown }[] | null;

  /** Called on reconnection only (not first connect), after `onOpen`. Return messages to send. */
  onReconnect?(): { event: string; payload: unknown }[] | null;

  /** Called when the connection closes. Receives the close code and reason. Use for cleanup (e.g., rejecting pending promises, clearing state). */
  onClose?(code: number, reason: string): void;

  /** Decide whether to reconnect. Return `false` to suppress, `true` to force, `void` to defer. */
  shouldReconnect?(code: number, reason: string): boolean | void;

  /**
   * Called once during `createSocket` to attach runtime methods to the socket.
   *
   * This is how plugins add their API to the socket object. The type function
   * (`_typeFn`) tells TypeScript the methods exist; `install` actually puts them
   * there at runtime. `createSocket` does not know about any specific plugin —
   * it just calls `install` on each one.
   *
   * `this.helpers` is available here — use `this.helpers.rawSend` to send
   * messages over the wire.
   *
   * @param socket The socket instance. Attach methods as properties. The type
   *   system guarantees the developer can only call methods that the plugin's
   *   type function declared.
   */
  install?(socket: Record<string, unknown>): void;

  /**
   * Phantom type that carries the type function. Never assigned at runtime —
   * only exists for TypeScript to extract the plugin's API shape.
   * @internal
   */
  declare _typeFn: F;

  /**
   * Phantom type that carries contract requirements. Never assigned at runtime.
   * @internal
   */
  declare _requires: TRequires;
}
