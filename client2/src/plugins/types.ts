/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin args/api stay generic across call sites */
import type { WireMessage } from '~/internal/runtime.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';
import type { ConnectionState } from '~/types.ts';

/** A primitive factory you can name as a plugin dependency, e.g. `dependencies: [ack]`. */
export type PrimitiveFactory = {
  (...args: any[]): Primitive<any, any>;
  /** Optional static tag, read in place of constructing the primitive to learn it. */
  readonly tag?: string;
};

/**
 * The hooks a plugin wires into during `setup`. They mirror a primitive's
 * lifecycle. Each slot takes one callback — registering the same hook twice
 * throws, so a plugin can't silently shadow its own behavior.
 */
export interface PluginHooks {
  /** See an incoming message. Return it (maybe changed) to pass on; throw `Block` to drop. */
  onIncoming(handler: (message: WireMessage) => WireMessage | void): void;

  /** See an outgoing message. Return it (maybe changed) to send; throw `Block` to cancel. */
  onOutgoing(handler: (message: WireMessage) => WireMessage | void): void;

  /** Runs on every open. Return `{ event, payload }[]` to send right away. */
  onOpen(handler: () => WireMessage[] | void): void;

  /** Runs only on reconnects. Same return as `onOpen`. */
  onReconnect(handler: () => WireMessage[] | void): void;

  /** Runs when the socket closes, with the close code and reason. */
  onClose(handler: (code: number, reason: string) => void): void;

  /** Make a unique id, sharing the kernel's counter so ids never clash. */
  generateId(prefix?: string): string;

  /** The current connection state. */
  getState(): ConnectionState;
}

/** What you pass to `plugin()`. */
export interface PluginDef<TArgs, TApi> {
  /**
   * The plugin's human-readable name, shown in logs and errors. A colon form
   * like `'acme:metrics'` is recommended to keep it clear of primitive names.
   * It is NOT the identity — that's `key` (+ `registrationId`). Two *different*
   * plugins sharing an id only warns.
   */
  id: string;

  /**
   * The plugin's identity — the `Symbol` that `key`s its API on each socket and
   * decides duplicates. The same plugin can't be registered twice under one key
   * unless it also supplies a `registrationId` (see below).
   */
  key: symbol;

  /**
   * Makes the plugin repeatable. Given the same args the developer passed, it
   * returns a stable string id, so the same plugin can be registered more than
   * once (e.g. two analytics configs). Two registrations that compute the same
   * id throw; different ids are kept as separate instances. Omit for a singleton.
   */
  registrationId?: (args: TArgs) => string;

  /** Primitives this plugin needs registered — asserted and ordered before it. */
  dependencies?: readonly PrimitiveFactory[];

  /** Wire up the hooks and return a factory for the plugin's per-socket API. */
  setup(args: TArgs, hooks: PluginHooks): (socket: any) => TApi;
}

/**
 * What `plugin()` returns: call it with args to register (flat, alongside
 * primitives), and read its API off a socket with `.use(socket)`. For a
 * repeatable plugin, pass the `registrationId` to pick which instance.
 */
export interface PluginFactory<TArgs, TApi> {
  (args: TArgs): Primitive<EmptyTypeFn>;

  /** Get this plugin's API for a socket it was registered on. */
  use(socket: object, registrationId?: string): TApi;
}
