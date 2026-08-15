import type { WSKitError } from '@wskit/core';
import type { WireMessage } from '~/internal/runtime.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { Messaging } from '~/messaging.ts';
import type { ChannelMethod } from '~/primitives/channels/types.ts';
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
 * The plugin's `channel` — the same three forms the top-level socket has,
 * (`channel(name)`, `channel(family, name)`, and `channel.family(family)`), typed
 * from the plugin's own channels and only present when it declares channels. The
 * plugin uses plain names; the framework prefixes them with its namespace on the
 * wire, so a plugin can own dynamic families (rooms) just like the app can.
 */
type PluginChannels<P extends SocketContract> =
  ChannelsOf<P> extends infer C extends Record<string, unknown>
    ? keyof C extends never
      ? {}
      : { channel: ChannelMethod<C> }
    : {};

/**
 * The parts of the plugin socket that are always there, whatever the plugin's
 * contract. Two groups: raw message taps that see every frame (for cross-cutting
 * work), and small tools that read state or ask the socket to act now.
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

/**
 * A typed union of the plugin's declared errors as real `WSKitError` instances,
 * one member per declared error code — `WSKitError<'room-full', { limit: number }>
 * | …`. What an `onError` handler receives: `switch (err.code)` types `err.detail`
 * per case. It is a real `WSKitError` instance (so `err instanceof WSKitError`
 * holds), carrying the plain name — the framework strips the plugin's `__<id>::`
 * prefix before handing it over.
 */
type PluginError<P extends SocketContract> = {
  [K in keyof ErrorsOf<P> & string]: WSKitError<K, ErrorsOf<P>[K]>;
}[keyof ErrorsOf<P> & string];

/**
 * A plugin with declared errors gets `onError`, which sees the server-pushed
 * errors in its namespace that no request or stream claimed. Present only when the
 * plugin declares an `errors` section.
 */
type PluginErrorHandling<P extends SocketContract> = WhenPresent<
  ErrorsOf<P>,
  { onError(handler: (error: PluginError<P>) => void): () => void }
>;

/**
 * The socket a plugin's `setup` receives. It has the same verbs as the app socket
 * — `on`, `send`, `request`, `channel`, `stream`, `onStream`, `resumeStream`,
 * `onRequest` — but typed to the plugin's own contract and scoped to its
 * namespace: you use plain names and the socket writes `__<id>::<name>` on the
 * wire for you. A verb only appears when the contract has that section, so a
 * plugin with no requests has no `request`. On top of the verbs it always has the
 * raw taps and tools from {@link PluginBase}.
 */
export type PluginSocket<P extends SocketContract = {}> = PluginBase &
  Messaging<IncomingOf<P> & object, OutgoingOf<P> & object> &
  WhenPresent<ClientRequestsOf<P>, RequestMethod<P, 'request'>> &
  PluginChannels<P> &
  PluginErrorHandling<P> &
  Apply<StreamTypeFn, P> &
  Apply<ServerRequestsTypeFn, P>;
