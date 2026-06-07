/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin args/api stay generic across call sites */
import type { WireMessage } from '~/internal/runtime.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';
import type { ConnectionState } from '~/types.ts';

/** A primitive factory you can name as a plugin dependency, e.g. `dependencies: [ack]`. */
export type PrimitiveFactory = {
  (...args: any[]): Primitive<any, any>;
  /** Optional static tag. When present, the tag is read from here instead of creating a throwaway instance. */
  readonly tag?: string;
};

/**
 * The hooks a plugin can register in `setup`. They follow the same lifecycle as
 * a built-in primitive. Each hook can only be set once — registering the same
 * one twice throws, so a plugin can't accidentally overwrite its own handler.
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
   * A human-readable name shown in logs and errors. A namespaced form like
   * `'acme:metrics'` is recommended to avoid clashing with primitive names.
   * This is NOT what uniquely identifies a plugin — that's `key` (+ `registrationId`).
   * Two different plugins sharing the same `id` only produces a warning.
   */
  id: string;

  /**
   * A `Symbol` that uniquely identifies this plugin. The socket uses it to
   * store and look up the plugin's API. The same plugin can't be registered
   * twice on one socket unless it also provides a `registrationId` (see below).
   */
  key: symbol;

  /**
   * Makes the plugin repeatable. Given the args the caller passes, return a
   * stable string that identifies this particular instance, so the same plugin
   * can be registered more than once (e.g. two analytics configs). Two
   * registrations with the same computed id throw; different ids are kept as
   * separate instances. Leave this out for a one-per-socket (singleton) plugin.
   */
  registrationId?: (args: TArgs) => string;

  /** Primitives this plugin needs registered — asserted and ordered before it. */
  dependencies?: readonly PrimitiveFactory[];

  /** Wire up the hooks and return a factory for the plugin's per-socket API. */
  setup(args: TArgs, hooks: PluginHooks): (socket: any) => TApi;
}

/**
 * What `plugin()` returns. Call it with args to register the plugin (passed
 * alongside primitives to `client()`), and call `.use(socket)` to get its API
 * from a socket it was registered on. For a repeatable plugin, pass the
 * `registrationId` to `.use()` to pick a specific instance.
 */
export interface PluginFactory<TArgs, TApi> {
  (args: TArgs): Primitive<EmptyTypeFn>;

  /** Get this plugin's API for a socket it was registered on. */
  use(socket: object, registrationId?: string): TApi;
}
