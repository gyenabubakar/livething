import type { SocketConfig } from '~/internal/config.ts';
import type { WSKitSocket } from '~/socket/socket.ts';
import type { ConnectionState } from '~/types.ts';

/**
 * The internal fields the library attaches to each message inside a `__wskit`
 * block — kept separate from `payload` so they never clash with your data.
 * Every field is optional; a plain event has no envelope at all.
 *
 * These values come off the wire untyped, so this describes the *expected* shape
 * — code that reads them still guards against malformed input (e.g. a `seq`
 * that isn't really a number).
 */
export interface WSKitEnvelope {
  /** Links a `request()` to its reply. */
  correlationId?: string;

  /**
   * The side that originated this exchange: `'server'` or `'client'`. One field
   * shared by every two-way flow (requests, replies, subscribe). It lets
   * the client tell a server-initiated request (`'server'`) apart from a reply to
   * its own request (`'client'`), so it can fast-fail with `request-no-response`
   * when it has no handler instead of leaving the server's pending promise to
   * hang to timeout.
   */
  source?: 'server' | 'client';

  /** Names the channel a message belongs to. */
  channel?: string;

  /** The dynamic channel-family key, paired with `channel`. */
  channelFamily?: string;

  /** Correlates an `__unsubscribe__` with its `__unsubscribeOk__` confirmation. */
  unsubscribeId?: string;

  /** Set to `true` on `__subscribeOk__` when the server manages rejoining the channel on reconnect, so the client should not re-subscribe it. */
  channelPersistent?: boolean;

  /** Set to `true` on `__subscribeOk__` when the channel is inbox-backed, so the client acks its messages with `__received__` and stays quiet on other channels. */
  inbox?: boolean;

  /** Set to `true` on `__subscribeOk__` when the channel enabled read receipts. */
  readReceipts?: boolean;

  /** Per-message sequence number from the server, used by replay. */
  seq?: number;

  /** Unique id from the server, used by dedup. */
  messageId?: string;

  /** Groups the chunks of one stream. */
  streamId?: string;

  /** The user event a broadcast stream carries, so an end/error frame that
   * arrives before any chunk can still be routed to the right subscriber. */
  eventName?: string;

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
 * Where a send ended up. Returned by the internal send paths so a caller that
 * owns a Promise can act precisely instead of guessing from a lossy boolean:
 *
 * - `sent` — written to the open socket.
 * - `buffered` — a buffering primitive kept it to flush on the next open.
 * - `connecting` — not open yet (connecting/reconnecting); a Promise-bearing
 *   caller should hold the frame and let `onOpen`/`onReconnect` flush it.
 * - `closed` — the socket is closed with no reconnect coming; a Promise-bearing
 *   caller must fail fast with `Disconnected` instead of hanging.
 * - `blocked` — a primitive's `onOutgoing` cancelled the send.
 *
 * The public `socket.send()` collapses this back to a boolean (`sent`/`buffered`
 * → true), so only primitives see the full detail.
 */
export type SendResult = 'sent' | 'buffered' | 'connecting' | 'closed' | 'blocked';

/**
 * The pending operation that owns a buffered or outboxed frame. A request,
 * subscribe, stream trigger, resume, or nudge whose frame is held off-wire keeps
 * an owner so the holding layer can settle it: skip its frame once it has already
 * settled (timed out, disconnected, resolved), and reject it if the frame can
 * never be delivered (eviction, TTL expiry, clear, or a serialization failure on
 * flush). A plain fire-and-forget `send()` has no owner.
 */
export interface FrameOwner {
  /** Still waiting? A frame whose owner is no longer pending is dropped, not sent. */
  isPending(): boolean;
  /** Settle the owning Promise with a failure (the frame will never reach the wire). */
  reject(error: unknown): void;
}

/** Internal send options: the public `ttl`, plus the owner a Promise-bearing op attaches. */
export interface InternalSendOptions {
  ttl?: number;
  owner?: FrameOwner;
}

/**
 * A function that sees every incoming message before your `on()` handlers do.
 * Return nothing to pass it through, return a new message to change it, or throw
 * `Block` to drop it.
 */
export type InterceptFn = (message: WireMessage) => WireMessage | void;

/**
 * A signal that one primitive can broadcast and another can listen to.
 * The socket just passes them through, so neither primitive has to import the other.
 *
 * - `online` — `true` when the device is online, `false` when offline.
 * - `visibility` — `true` when the app/tab is visible, `false` when hidden.
 */
export type PlatformSignal = 'online' | 'visibility';

/**
 * A logger for primitives. `info` / `warn` / `error` are debug breadcrumbs:
 * gated on whether debug mode is on and prefixed with `[wskit]`, so call sites
 * never repeat that check. They map to `console.log` / `console.warn` / `console.error`.
 */
export interface PrimitiveLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /**
   * Surface a value thrown by user code (a handler, listener, or hook) on the
   * public `error` event so it isn't swallowed. Not gated by debug mode; when no
   * `error` listener is registered it is rethrown out-of-band to the host's
   * global error handler rather than logged.
   */
  report(error: unknown): void;
}

/**
 * The runtime hooks a primitive exposes. A primitive's `setup` returns one of
 * these, and the socket calls each hook at the right moment.
 */
export interface PrimitiveRuntime {
  /** A name for debug logs. */
  id: string;

  /** See an incoming message. Return it (maybe changed), or `null` to swallow it. */
  onIncoming?(message: WireMessage): WireMessage | null;

  /** See an outgoing message. Return it (maybe changed), or `null` to cancel the send. */
  onOutgoing?(message: WireMessage): WireMessage | null;

  /**
   * Rewrite the connection URL before each connect (first connect and every
   * reconnect). Gets the URL so far and returns the next one — primitives chain,
   * each seeing the previous result. `query()` uses this to append params. Async
   * is awaited, so a basic connect with no URL hooks stays synchronous.
   */
  resolveUrl?(url: string): string | Promise<string>;

  /**
   * Runs just before the socket opens, on every reconnect (skipped on the first connect).
   * Awaited, so a primitive can finish any async work it needs before the
   * socket opens — e.g. `channels` can refresh a rotating auth token
   * so the re-subscribe message carries a fresh one.
   */
  onBeforeReopen?(): void | Promise<void>;

  /** Runs every time the socket opens. Return messages to send right away. */
  onOpen?(): WireMessage[] | null;

  /** Runs only on reconnects (not the first open). Return messages to send. */
  onReconnect?(): WireMessage[] | null;

  /**
   * Runs when the socket closes. `intentional` is `true` for a public
   * `disconnect()` call. `suspended` is `true` for a temporary platform pause
   * that will resume as the same client session.
   */
  onClose?(code: number, reason: string, intentional: boolean, suspended?: boolean): void;

  /**
   * Runs when reconnection is permanently abandoned — out of retries, or the
   * close was non-retryable. The socket is settling on `closed` for good, so a
   * primitive must finish anything it kept alive across the drop expecting a
   * reconnect: `stream` ends resumable streams with `Disconnected`, `channels`
   * releases the idle-prevention holds it held for active channels.
   */
  onReconnectFailed?(): void;

  /** Vote on whether to reconnect: `true`/`false` is final, `void` means "no opinion." */
  shouldReconnect?(code: number, reason: string): boolean | void;

  /** Add methods to the socket object (e.g. `socket.channel`). */
  install?(socket: WSKitSocket): void;
}

/**
 * Everything a primitive can ask the socket to do. Behavior primitives
 * (reconnection, keepalive, buffering, …) keep their own logic and drive the
 * socket through these calls. Because the socket never imports those primitives,
 * the ones you don't use are dropped from your bundle.
 */
export interface PrimitiveHelpers {
  /** Read-only view of the resolved config. */
  readonly config: Readonly<SocketConfig>;

  /**
   * Send straight to the wire, skipping `onOutgoing` (so you don't loop). Returns
   * where it went so a Promise-bearing protocol op can queue or fail fast. Pass an
   * `owner` to flush a held frame: a serialization throw then rejects that owner
   * and is reported instead of escaping.
   */
  rawSend(message: WireMessage, owner?: FrameOwner): SendResult;

  /**
   * Send a bare `"ping"` text frame straight to the wire. Sent as plain text
   * (not JSON) so the server's pong handler and Cloudflare's built-in ping/pong
   * response both recognize it — a JSON-encoded ping would not match those paths.
   */
  sendPing(): void;

  /** Send a message through the normal path (`onOutgoing` → fallback → wire). */
  send(message: WireMessage, options?: InternalSendOptions): SendResult;

  /** Make a unique id. The counter is shared across all primitives, so ids never collide. */
  generateId(prefix?: string): string;

  /** The current connection state. */
  getState(): ConnectionState;

  /** Whether a primitive with this `_tag` is installed (e.g. `'keepalive'`). */
  hasPrimitive(tag: string): boolean;

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

  /** Ask each primitive whether to reconnect; the first `true` or `false` answer wins. */
  runShouldReconnect(code: number, reason: string): boolean | undefined;

  /** True if an unexpected close with this code would lead to a reconnect attempt
   * (a reconnection module is installed and no primitive vetoes the code). */
  willReconnect(code: number, reason: string): boolean;

  /** Register a callback that runs when a `pong` frame arrives. */
  onPong(handler: () => void): void;

  /**
   * Register a handler for sends that happen while the socket is closed.
   * Return `true` if you kept the message (e.g. added it to a buffer), `false` to drop it.
   * If no fallback is registered, those sends are silently dropped.
   */
  registerOutgoingFallback(
    handler: (message: WireMessage, options?: InternalSendOptions) => boolean,
  ): void;

  /** Debug logger, already gated on debug mode and prefixed — use freely, no guard needed. */
  readonly log: PrimitiveLogger;

  /** Publish a platform signal (e.g. `platform()` reporting online/offline). */
  emitSignal(name: PlatformSignal, value: boolean): void;

  /** React to a platform signal. Returns an unsubscribe. */
  onSignal(name: PlatformSignal, handler: (value: boolean) => void): () => void;

  /** Close the connection and stop everything (the public `disconnect()`). */
  disconnect(code?: number, reason?: string): void;

  /** Open the connection (the public `connect()`). */
  connect(): void;

  /** Temporarily close the transport while keeping reconnectable primitive state. */
  suspend(code?: number, reason?: string): void;

  /** Reopen a suspended transport as a reconnect. */
  resume(): void;
}
