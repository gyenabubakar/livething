import type { WSKitError } from '@wskit/core';
import type { WireMessage } from '~/internal/runtime.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { Messaging } from '~/messaging.ts';
import type { AugmentedChannelMethod } from '~/primitives/channels/types.ts';
import type { InboxPrimitive, ReadReceiptsPrimitive } from '~/primitives/inbox/types.ts';
import type { ServerRequestsTypeFn } from '~/primitives/server-requests/types.ts';
import type { StreamTypeFn } from '~/primitives/stream/types.ts';
import type { Apply } from '~/primitives/types.ts';
import type {
  ChannelsOf,
  ClientRequestsOf,
  ConnectionState,
  ErrorsOf,
  IncomingOf,
  OutgoingOf,
  RequestMethod,
  SocketContract,
} from '~/types.ts';

/**
 * The channel-scoped primitives every plugin channel handle is typed with,
 * whatever the plugin declares. `inbox()` and `readReceipts()` gate their own
 * surface on the channel's contract (`inbox: true` / `readReceipts: true`), so
 * listing them here doesn't add methods to a channel that doesn't opt in — it
 * only makes the surface reachable when the channel does. A plugin that
 * declares such a flag is still responsible for listing the matching primitive
 * in its `dependencies`, the same way it lists `channels` for `channel` itself.
 */
type PluginChannelPrimitives = readonly [InboxPrimitive, ReadReceiptsPrimitive];

/**
 * The plugin's `channel` — the same three forms the top-level socket has,
 * (`channel(name)`, `channel(family, name)`, and `channel.family(family)`), typed
 * from the plugin's own channels and only present when it declares channels. The
 * plugin uses plain names; the framework prefixes them with its namespace on the
 * wire, so a plugin can own dynamic families (rooms) just like the app can.
 * Each handle also carries the channel-scoped primitive surface (e.g. `inbox()`'s
 * `receivers`) — at runtime a plugin's channels go through the same channel
 * machinery as the app's, so their types match.
 */
type PluginChannels<P extends SocketContract> =
  ChannelsOf<P> extends infer C extends Record<string, unknown>
    ? keyof C extends never
      ? {}
      : { channel: AugmentedChannelMethod<C, PluginChannelPrimitives> }
    : {};

/**
 * The parts of the plugin socket that are always there, whatever the plugin's
 * contract. Two groups: raw message handlers that see every frame (for
 * cross-cutting work), and small tools that read state or ask the socket to act now.
 */
export interface PluginBase {
  /**
   * See incoming frames in this plugin's namespace. Return one (maybe changed) to
   * pass it on; throw `Block` to drop it. Wrap the plugin in `observeHost(...)` to
   * see the whole app's frames instead of only its own.
   */
  onIncoming(handler: (message: WireMessage) => WireMessage | void): void;

  /**
   * See outgoing frames in this plugin's namespace. Return one (maybe changed) to
   * send it; throw `Block` to cancel it. Wrap the plugin in `observeHost(...)` to
   * see the whole app's frames instead of only its own.
   */
  onOutgoing(handler: (message: WireMessage) => WireMessage | void): void;

  /** Runs on every open (first connect and reconnects). Return frames to send right away. */
  onOpen(handler: () => WireMessage[] | void): void;

  /** Runs only on reconnects. Return frames to send right away. */
  onReconnect(handler: () => WireMessage[] | void): void;

  /**
   * Runs on every close, with the close code and reason. `suspended` is `true`
   * for a platform pause that will resume the same session (not a real end), so a
   * handler can skip teardown it should only do on a true close.
   */
  onClose(handler: (code: number, reason: string, suspended: boolean) => void): void;

  /** Make a unique id that shares the socket's counter, so it never clashes. */
  generateId(prefix?: string): string;

  /** Whether a primitive with this tag is installed (e.g. `'channels'`). */
  hasPrimitive(tag: string): boolean;

  /** Open the connection now if it's lazy and not yet connected. */
  ensureConnected(): void;

  /**
   * The connection state as a store — the same one the app socket exposes. Read
   * the current value with `state.get()`, or `state.subscribe(cb)` to react to
   * every change (`'connecting'`, `'open'`, `'reconnecting'`, `'closed'`), so a
   * plugin can surface live connection status to its own consumers.
   */
  state: ReadableStore<ConnectionState>;
}

/** `{}` unless `TMap` has at least one key — so an empty section adds no method. */
type WhenPresent<TMap, TThen> = keyof TMap extends never ? {} : TThen;

type PluginErrorCode<P extends SocketContract> = keyof ErrorsOf<P> & string;

/**
 * A plugin with declared errors gets `onServerError`, which sees the server-pushed
 * errors in its namespace that no request or stream claimed. Present only when the
 * plugin declares an `errors` section. Local setup and handler throws still reach
 * the host's `onError`.
 */
type PluginErrorHandling<P extends SocketContract> = WhenPresent<
  ErrorsOf<P>,
  {
    onServerError(handler: (error: WSKitError<string, unknown>) => void): () => void;
    onServerError<K extends PluginErrorCode<P>>(
      code: K,
      handler: (error: WSKitError<K, ErrorsOf<P>[K]>) => void,
    ): () => void;
  }
>;

/**
 * The socket a plugin's `setup` receives. It has the same verbs as the app socket
 * — `on`, `send`, `request`, `channel`, `stream`, `onStream`, `resumeStream`,
 * `onRequest` — but typed to the plugin's own contract and scoped to its
 * namespace: you use plain names and the socket writes `__<id>::<name>` on the
 * wire for you. A verb only appears when the contract has that section, so a
 * plugin with no requests has no `request`. On top of the verbs it always has the
 * raw message handlers and tools from {@link PluginBase}.
 */
export type PluginSocket<P extends SocketContract = {}> = PluginBase &
  Messaging<IncomingOf<P> & object, OutgoingOf<P> & object> &
  WhenPresent<ClientRequestsOf<P>, RequestMethod<P, 'request'>> &
  PluginChannels<P> &
  PluginErrorHandling<P> &
  Apply<StreamTypeFn, P> &
  Apply<ServerRequestsTypeFn, P>;
