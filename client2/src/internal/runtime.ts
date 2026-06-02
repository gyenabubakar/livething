import type { SocketConfig } from '~/internal/config.ts';
import type { WSKitSocket } from '~/socket/socket.ts';
import type { ConnectionQuality, ConnectionState } from '~/types.ts';

/**
 * The routing and correlation fields the framework carries beside a message, in
 * its `__wskit` block — kept separate from `payload` so they never clash with
 * your data. Every field is optional; a plain event has no envelope at all.
 *
 * These values come off the wire untyped, so this describes the *expected* shape
 * — code that reads them still guards against malformed input (e.g. a `seq`
 * that isn't really a number).
 */
export interface WSKitEnvelope {
  /** Links a `request()` to its reply. */
  correlationId?: string;

  /** Links a `sendWithAck()` to its `__ack__`. */
  ackId?: string;

  /** Names the namespace a message belongs to (routing only). */
  namespace?: string;

  /** Names the channel a message belongs to. */
  channel?: string;

  /** The dynamic channel-family key, paired with `channel`. */
  channelScope?: string;

  /** Per-message sequence number from the server, used by replay. */
  seq?: number;

  /** Unique id from the server, used by dedup. */
  messageId?: string;

  /** Groups the chunks of one stream. */
  streamId?: string;

  /** Whether a stream is resumable (`persistent`) or dies on disconnect (`ephemeral`). */
  streamKind?: 'ephemeral' | 'persistent';

  /** Correlates a nudge with its `__nudgeOk__` / `__error__` reply. */
  streamNudgeId?: string;

  /** On a stream `__error__`: false means non-terminal (a rejected nudge). */
  streamTerminated?: boolean;
}

/**
 * One message as it travels through the library. `payload` is your data;
 * everything the framework needs for routing lives separately in `__wskit`.
 */
export interface WireMessage {
  event: string;
  payload: unknown;
  __wskit?: WSKitEnvelope;
}

/**
 * A function that sees every incoming message before your `on()` handlers do.
 * Return nothing to pass it through, return a new message to change it, or throw
 * `Block` to drop it.
 */
export type InterceptFn = (message: WireMessage) => WireMessage | void;

/**
 * A platform signal one primitive publishes and another reacts to. `platform()`
 * emits these from its adapter; `reconnection()` consumes `online`. The kernel
 * just relays them, so neither primitive has to import the other.
 *
 * - `online` — `true` when the device is online, `false` when offline.
 * - `visibility` — `true` when the app/tab is visible, `false` when hidden.
 */
export type PlatformSignal = 'online' | 'visibility';

/**
 * Debug logging for primitives. Every call is gated on whether `debug()` is on
 * and prefixed with `[wskit]`, so call sites never repeat that check. The three
 * levels map to `console.log` / `console.warn` / `console.error`.
 */
export interface PrimitiveLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * The running half of a primitive. A primitive's `setup` returns one of these,
 * and the kernel calls these hooks at the right moments.
 */
export interface PrimitiveRuntime {
  /** A name for debug logs. */
  id: string;

  /** See an incoming message. Return it (maybe changed), or `null` to swallow it. */
  onIncoming?(message: WireMessage): WireMessage | null;

  /** See an outgoing message. Return it (maybe changed), or `null` to cancel the send. */
  onOutgoing?(message: WireMessage): WireMessage | null;

  /** Runs every time the socket opens. Return messages to send right away. */
  onOpen?(): WireMessage[] | null;

  /** Runs only on reconnects (not the first open). Return messages to send. */
  onReconnect?(): WireMessage[] | null;

  /**
   * Runs when the socket closes. `intentional` is `true` for a `disconnect()`
   * call and `false` for an unexpected drop — useful for deciding whether to
   * throw away queued state.
   */
  onClose?(code: number, reason: string, intentional: boolean): void;

  /** Vote on whether to reconnect: `true`/`false` is final, `void` means "no opinion." */
  shouldReconnect?(code: number, reason: string): boolean | void;

  /** Add methods to the socket object (e.g. `socket.channel`). */
  install?(socket: WSKitSocket): void;
}

/**
 * Everything a primitive can ask the kernel to do. Behavior primitives
 * (reconnection, keepalive, buffering, …) keep their own logic and drive the
 * kernel through these calls. Because the kernel never imports those primitives,
 * the ones you don't use are dropped from your bundle.
 */
export interface PrimitiveHelpers {
  /** Read-only view of the resolved config. */
  readonly config: Readonly<SocketConfig>;

  /** Send a message straight to the wire, skipping `onOutgoing` (so you don't loop). */
  rawSend(message: WireMessage): void;

  /** Send a message through the normal path (`onOutgoing` → fallback → wire). */
  send(message: WireMessage, options?: { ttl?: number }): boolean;

  /** Make a unique id. The counter is shared, so ids never clash across primitives. */
  generateId(prefix?: string): string;

  /** The current connection state. */
  getState(): ConnectionState;

  /** Open the connection now if it's lazy and not yet connected. */
  ensureConnected(): void;

  /** Tell the socket someone needs it (keeps a lazy socket open). */
  lazyAcquire(): void;

  /** Tell the socket you're done; a lazy socket may close after the idle timeout. */
  lazyRelease(): void;

  /** Start a fresh connection attempt (the reconnection backoff loop uses this). */
  reopen(): void;

  /** Move the socket into the `reconnecting` state. */
  enterReconnecting(): void;

  /** Go to `closed` quietly (reconnection was suppressed). */
  giveUp(): void;

  /** Go to `closed` and fire `onReconnectFailed` (out of retries). */
  failReconnect(): void;

  /** Close the live socket with a code/reason (keepalive uses this for a dead link). */
  forceClose(code: number, reason: string): void;

  /** Register who handles an unexpected close — this is how reconnection takes over. */
  onUnexpectedClose(handler: (code: number, reason: string) => void): void;

  /** Ask every primitive's `shouldReconnect`; the first real `true`/`false` wins. */
  runShouldReconnect(code: number, reason: string): boolean | undefined;

  /** Get told when a `pong` arrives (keepalive measures latency from this). */
  onPong(handler: () => void): void;

  /** Report measured quality + latency so the socket can emit `qualityChange`. */
  reportQuality(quality: ConnectionQuality, latency: number): void;

  /**
   * Register what to do with a `send()` that runs while the socket is closed.
   * Return `true` if you took the message (e.g. buffered it), `false` to drop it.
   * With no fallback registered, such sends are dropped.
   */
  registerOutgoingFallback(handler: (message: WireMessage, ttl?: number) => boolean): void;

  /** Debug logging, gated on `debug()` and prefixed — use freely, no guard needed. */
  readonly log: PrimitiveLogger;

  /** Publish a platform signal (e.g. `platform()` reporting online/offline). */
  emitSignal(name: PlatformSignal, value: boolean): void;

  /** React to a platform signal. Returns an unsubscribe. */
  onSignal(name: PlatformSignal, handler: (value: boolean) => void): () => void;

  /** Close the connection and stop everything (the public `disconnect()`). */
  disconnect(code?: number, reason?: string): void;

  /** Open the connection (the public `connect()`). */
  connect(): void;
}
