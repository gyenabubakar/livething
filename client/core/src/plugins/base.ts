import type { TypeFn } from '@/plugins/types.ts';

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

  /** Called when the connection closes. */
  onClose?(code: number, reason: string): void;

  /** Decide whether to reconnect. Return `false` to suppress, `true` to force, `void` to defer. */
  shouldReconnect?(code: number, reason: string): boolean | void;

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
