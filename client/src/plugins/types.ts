/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin api/contract stay generic across call sites */
import type { PluginSocket } from '~/plugins/plugin-socket.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';
import type { SocketContract } from '~/types.ts';

/**
 * A primitive factory you can name as a plugin dependency, e.g.
 * `dependencies: [requestResponse]`. The static `tag` is read without running the
 * factory, so a factory that needs options can't throw or fire side effects here.
 */
export type PrimitiveFactory = {
  (...args: any[]): Primitive<any, any>;
  readonly tag: string;
};

/**
 * What a plugin's `setup` returns. Both fields are optional: a plugin that only
 * taps the pipeline needs neither, one with an API sets `api`, one holding
 * resources sets `dispose`.
 */
export interface PluginInstance<TApi = void> {
  /**
   * Builds the object reached with `Plugin.use(socket)`. It runs once, the first
   * time `use()` is called, and the same object is returned after. Omit it for a
   * plugin that only observes or acts through hooks.
   */
  api?: () => TApi;

  /**
   * Runs once when the socket is finished for good — reconnection has been given
   * up, or the app closed the socket on purpose. It does NOT run on a normal drop
   * that will reconnect. Use it to release timers or other outside resources; a
   * plugin holding only in-memory state doesn't need it.
   */
  dispose?: () => void;
}

/** What you pass to `plugin()`. */
export interface PluginDef<P extends SocketContract, TApi> {
  /**
   * The plugin's namespace and log label. It owns every `__<id>::…` name on the
   * wire, so no two plugins on one socket may share an `id`. A namespaced form
   * like `'acme:chat'` is the convention.
   */
  id: string;

  /**
   * Primitives the host must register for this plugin to work — e.g.
   * `[requestResponse]` for a plugin that makes requests. Checked when the socket
   * is built; a missing one throws with a message naming what to add.
   */
  dependencies?: readonly PrimitiveFactory[];

  /**
   * Wire up handlers and hooks on the scoped socket, then return the plugin's API
   * and cleanup. It runs once, when the socket is built.
   */
  setup(socket: PluginSocket<P>): PluginInstance<TApi>;
}

/**
 * What `plugin()` returns. Call it to register the plugin (pass the result to
 * `client()`), and call `.use(socket)` to get its API from a socket it was
 * registered on. `TId` carries the plugin's id as a literal so the app socket
 * knows which namespace this plugin claims.
 */
export interface PluginFactory<TApi, TId extends string = string> {
  (): Primitive<EmptyTypeFn> & { readonly _plugin: { readonly id: TId } };

  /** The plugin's id — its namespace and log label. */
  readonly id: TId;

  /** Get this plugin's API from a socket it was registered on. */
  use(socket: object): TApi;
}
