/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin args/api stay generic across call sites */
import type { SendResult, WireMessage } from '~/internal/runtime.ts';
import type { SendOptions } from '~/messaging.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';
import type { ConnectionState } from '~/types.ts';

/**
 * A primitive factory you can name as a plugin dependency, e.g. `dependencies: [channels]`.
 * The static `tag` is required: dependency resolution reads it without running the
 * factory, so a factory that needs options can't throw or fire side effects here.
 */
export type PrimitiveFactory = {
  (...args: any[]): Primitive<any, any>;
  readonly tag: string;
};

/**
 * The lifecycle callbacks a plugin registers in `setup`. They follow the same
 * lifecycle as a built-in primitive. Each hook can only be set once — registering
 * the same one twice throws, so a plugin can't accidentally overwrite its own
 * handler. These only register callbacks that fire later; to read state or ask
 * the kernel to do something now, use {@link PluginTools} (the third `setup` arg).
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
}

/**
 * The things a plugin can call right now in `setup` — reading state or asking
 * the kernel to act. Unlike {@link PluginHooks}, none of these register a
 * callback: you call one and get an answer (or an effect) back. Handed to
 * `setup` as its third argument, so a plugin that only wires hooks can leave it
 * out.
 */
export interface PluginTools {
  /** Make a unique id, sharing the kernel's counter so ids never clash. */
  generateId(prefix?: string): string;

  /** The current connection state. */
  getState(): ConnectionState;

  /** Send a message the normal way (`onOutgoing` → fallback → wire). */
  send(message: WireMessage, options?: SendOptions): SendResult;

  /**
   * Send straight to the wire, skipping `onOutgoing` so a hook can't loop back on
   * its own frame.
   */
  rawSend(message: WireMessage): SendResult;

  /** Whether a primitive with this `_tag` is installed (e.g. `'keepalive'`). */
  hasPrimitive(tag: string): boolean;

  /** Open the connection now if it's lazy and not yet connected. */
  ensureConnected(): void;
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

  /**
   * Wire up the hooks and return a factory for the plugin's per-socket API.
   * `hooks` registers lifecycle callbacks; `tools` reads state or drives the
   * kernel now. A plugin that only wires hooks can leave `tools` out.
   */
  setup(args: TArgs, hooks: PluginHooks, tools: PluginTools): (socket: any) => TApi;
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
