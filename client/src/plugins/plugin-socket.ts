import type { WireMessage } from '~/internal/runtime.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { Messaging } from '~/messaging.ts';
import type { ChannelMessaging } from '~/primitives/channels/types.ts';
import type { ServerRequestTypeFn } from '~/primitives/server-request/types.ts';
import type { StreamTypeFn } from '~/primitives/stream/types.ts';
import type { Apply } from '~/primitives/types.ts';
import type {
  ChannelsOf,
  ConnectionState,
  IncomingOf,
  OutgoingOf,
  RequestMethod,
  RequestsOf,
  SocketContract,
} from '~/types.ts';

/**
 * The plugin's `channel(name)` — the same rich channel handle the top-level
 * socket gives (subscribe, members, presence, and the scoped verbs), typed from
 * the plugin's own channels, and only present when the plugin declares channels.
 */
type PluginChannels<P extends SocketContract> =
  ChannelsOf<P> extends infer C extends Record<string, unknown>
    ? keyof C extends never
      ? {}
      : { channel<K extends keyof C & string>(name: K): ChannelMessaging<C[K]> }
    : {};

/**
 * The parts of the plugin socket that are always there, whatever the plugin's
 * contract. Two groups: raw message taps that see every frame (for cross-cutting
 * work), and small tools that read state or ask the socket to act now.
 */
export interface PluginBase {
  /** See every incoming frame. Return it (maybe changed) to pass it on; throw `Block` to drop it. */
  onIncoming(handler: (message: WireMessage) => WireMessage | void): void;

  /** See every outgoing frame. Return it (maybe changed) to send it; throw `Block` to cancel it. */
  onOutgoing(handler: (message: WireMessage) => WireMessage | void): void;

  /** Runs on every open (first connect and reconnects). Return frames to send right away. */
  onOpen(handler: () => WireMessage[] | void): void;

  /** Runs only on reconnects. Return frames to send right away. */
  onReconnect(handler: () => WireMessage[] | void): void;

  /** Runs on every close, with the close code and reason. */
  onClose(handler: (code: number, reason: string) => void): void;

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
  WhenPresent<RequestsOf<P>, RequestMethod<P, 'request'>> &
  PluginChannels<P> &
  Apply<StreamTypeFn, P> &
  Apply<ServerRequestTypeFn, P>;
