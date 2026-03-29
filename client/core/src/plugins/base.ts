import type { TypeFn } from '@/plugins/types.ts';

/**
 * Utilities passed to `Plugin.install()`. Provides access to socket internals
 * that plugins need to function (e.g., sending raw messages over the wire).
 */
export interface PluginHelpers {
  /** Send a raw message over the WebSocket. Bypasses plugin `onOutgoing` hooks to avoid infinite loops. */
  rawSend: (event: string, payload: unknown) => void;
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
   * @param socket The socket instance. Use `Record<string, unknown>` to attach
   *   arbitrary properties. The type system already guarantees the developer can
   *   only call methods that the plugin's type function declared.
   * @param helpers Utilities the plugin may need to interact with the socket
   *   internals (e.g., sending raw messages, accessing the send function).
   */
  install?(socket: Record<string, unknown>, helpers: PluginHelpers): void;

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
