/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin api/contract stay generic across call sites */
import type { NamespacedContract } from '~/plugins/contract.ts';
import type { PluginSocket } from '~/plugins/plugin-socket.ts';
import type { EmptyTypeFn, IsUnion, Primitive, PrimitiveIdentity } from '~/primitives/types.ts';
import type { SocketContract } from '~/types.ts';

/**
 * A primitive factory you can name as a plugin dependency, e.g.
 * `dependencies: [clientRequests]`. The static `tag` is read without running the
 * factory, so a factory that needs options can't throw or fire side effects here.
 */
export type PrimitiveFactory = {
  (...args: any[]): Primitive<any, any>;
  readonly tag: string;
};

/**
 * The literal tags of a plugin's `dependencies`. A factory whose `tag` is a plain
 * `string` is left out, so the runtime check covers it and the type still checks
 * the others. A list typed as an array, not a tuple, can't say which factories it
 * holds, and a list that could be one of several tuples (such as `flag ? [a] : [b]`)
 * needs only one of them at runtime. Neither gives tags, so the runtime check covers
 * all of it. One item that could be either of several factories (such as
 * `[flag ? a : b]`) is skipped the same way, and the other items are still checked.
 */
export type LiteralDependencyTags<TDependencies extends readonly PrimitiveFactory[]> =
  number extends TDependencies['length']
    ? never
    : true extends IsUnion<TDependencies>
      ? never
      : {
          [I in keyof TDependencies]: string extends TDependencies[I]['tag']
            ? never
            : true extends IsUnion<TDependencies[I]['tag']>
              ? never
              : TDependencies[I]['tag'];
        }[number];
/**
 * What a plugin's `setup` returns. Both fields are optional: a plugin that only
 * runs hooks needs neither, one with an API sets `api`, one holding
 * resources sets `dispose`.
 */
export interface PluginInstance<TApi = void> {
  /**
   * Builds the object reached with `Plugin.use(socket)`. It runs once, the first
   * time `use()` is called, and the same object is returned after. Omit it for a
   * plugin that only acts through hooks.
   */
  api?: () => TApi;

  /**
   * Runs once when the socket is finished for good — reconnection has been given
   * up, or the app closed the socket on purpose. It does NOT run on a normal drop
   * that will reconnect. Use it to release timers or other outside resources; a
   * plugin holding only in-memory state doesn't need it.
   *
   * A lazy socket is the exception: it reopens on demand, so no close is ever
   * final and `dispose` does not run automatically — an idle-close and an explicit
   * `disconnect()` are indistinguishable, and both may reopen. On a lazy socket,
   * tie cleanup to your own listeners (the unsubscribe an `on(...)` returns), not
   * to `dispose`.
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
   * Primitives the host must register for this plugin to work. Any scoped verb
   * that comes from a primitive needs its primitive listed here: `request` needs
   * `clientRequests`, `stream`/`onStream`/`continueStream` need `stream`,
   * `channel` needs `channels`, `onRequest` needs `serverRequests`. The scoped
   * socket types these verbs from the plugin's contract, not from this list, so
   * calling one whose primitive is neither listed here nor registered by the app
   * fails at runtime — list it here and a missing one is caught when the socket
   * is built, with a message naming what to add.
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
 * knows which namespace this plugin claims, and `P` becomes the primitive's
 * `_requires` so `client()` rejects a socket whose contract lacks that namespace.
 * `TDependency` carries the tags of the plugin's `dependencies`, so `client()` also
 * rejects a socket that does not register one of them. Its default, `string`, means
 * "not known": a plugin with dependencies still fits a `PluginFactory` written
 * without this argument, and the runtime check covers those dependencies.
 */
export interface PluginFactory<
  TApi,
  TId extends string = string,
  P extends SocketContract = {},
  TDependency extends string = string,
> {
  (): Primitive<EmptyTypeFn, NamespacedContract<P, TId>> &
    PrimitiveIdentity<TId, TDependency> & {
      readonly _plugin: { readonly id: TId };
    };

  /** The plugin's id — its namespace and log label. */
  readonly id: TId;

  /** Get this plugin's API from a socket it was registered on. */
  use(socket: object): TApi;
}
