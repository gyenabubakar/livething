import type { LiveThingError, LiveThingMetadata, Message } from '@livething/core';
import type { SocketConfig } from '~/internal/config.ts';
import type { ScopeMarkers } from '~/internal/scoped.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';
import type { ConnectionState, StreamHandlers } from '~/types.ts';

export type { Message, LiveThingMetadata };

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
 * - `dropped` — the buffer refused it (too big to queue); a Promise-bearing
 *   caller must reject with `Dropped` at once.
 *
 * The public `socket.send()` collapses this back to a boolean (`sent`/`buffered`
 * → true), so only primitives see the full detail.
 */
export type SendResult = 'sent' | 'buffered' | 'connecting' | 'closed' | 'blocked' | 'dropped';

/**
 * The pending operation that owns a buffered or outboxed frame. A request,
 * subscribe, stream trigger, continue, or nudge whose frame is held off-wire keeps
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
 * The hooks `binary()` gives the socket. Without `binary()` the socket has none, and it
 * reports each binary message to `onError` and drops it.
 */
export interface BinaryHooks {
  /** Read one binary message from the WebSocket, and pass it on as a `Message` with `bytes`. */
  receive(data: unknown): void;
  /** Deliver a binary message that went through the whole incoming pipeline. */
  route(message: Message): void;
  /** Encode an outgoing message: a binary frame when it has `bytes`, else JSON text. */
  encode(message: Message): string | Uint8Array<ArrayBuffer>;
}

/** How a request is sent: its scope and timeout, and the hooks `binary.request` adds. */
export interface RequestCallOptions {
  markers: ScopeMarkers;
  timeout?: number;
  /**
   * Turn the request frame into the one to send. It runs before the socket is touched, and
   * a throw comes out of the send call itself, so the caller turns it into a rejection.
   */
  prepare?(frame: Message): Message;
  /** Settle the request from a reply that is not a text `__error__`. */
  answer?(
    reply: Message,
    settle: { resolve(value: unknown): void; reject(reason: unknown): void },
  ): void;
}

/**
 * `clientRequests()` shares its send under this key, so `binary()` sends binary requests
 * with the same pending map, timeout, buffering and close handling.
 */
export const REQUESTS_KEY = 'requests';
export type SendRequest = (
  event: string,
  payload: unknown,
  options: RequestCallOptions,
) => Promise<unknown>;

/** How a stream is started: its scope, its options, and the hook `binary.stream` adds. */
export interface StreamStartContext {
  markers: ScopeMarkers;
  options?: { streamId?: string };
  /** A binary stream: its chunks are binary, and each item is `{ info, bytes }`. */
  binary?: boolean;
  /**
   * Turn the start frame into the one to send. It runs before the socket is touched, and a
   * throw comes out of the start call itself, so the caller turns it into a rejection.
   */
  prepare?(frame: Message): Message;
}

/** How a recorded stream is continued: its scope, its options, and whether it is binary. */
export interface StreamContinueContext {
  markers: ScopeMarkers;
  options?: { lastKnownSeq?: number };
  /** A binary stream: its chunks are binary, and each item is `{ info, bytes }`. */
  binary?: boolean;
}

/** `stream()` shares these under {@link STREAM_KEY}, so `binary()` can add binary streams. */
export const STREAM_KEY = 'stream';
export interface StreamHooks {
  start(event: string, payload: unknown, context: StreamStartContext): Promise<unknown>;
  continue(event: string, streamId: string, context: StreamContinueContext): unknown;
  listen(
    event: string,
    handlers: StreamHandlers<unknown>,
    scope: ScopeMarkers | undefined,
    binary: boolean,
  ): () => void;
}

/**
 * A function that sees every incoming message before your `on()` handlers do.
 * Return nothing to pass it through, return a new message to change it, or throw
 * `Block` to drop it.
 */
export type InterceptFn = (message: Message) => Message | void;

/**
 * A logger for primitives. `info` / `warn` / `error` are debug breadcrumbs:
 * gated on whether debug mode is on and prefixed with `[livething]`, so call sites
 * never repeat that check. They map to `console.log` / `console.warn` / `console.error`.
 */
export interface PrimitiveLogger {
  /**
   * Whether debug mode is on right now. `info`/`warn`/`error` already check it,
   * so read this only to skip building a message that would be thrown away —
   * worth it on a per-frame path, pointless anywhere else.
   */
  debug: boolean;

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
/** The values the server sends in its first frame, `__connected__`. The client follows them. */
export interface ConnectedInfo {
  /** How often the server pings, or `null` when it sends no pings. */
  pingIntervalMs: number | null;
  /** How long the server waits for any frame before it closes the connection, or `null`. */
  idleTimeoutMs: number | null;
  /** The most resume tokens one `__replay__` may list. */
  maxResumeTokens: number;
  connectionId: string;
  /** The server features a client primitive needs: `replay`, `binary` and `uploads`. */
  features: readonly string[];
  /** This connection's resume token and starting seq, or `null` when replay is off. */
  resume: { token: string; seq: number | null } | null;
}

export interface PrimitiveRuntime {
  /** A name for debug logs. */
  id: string;

  /** See an incoming message. Return it (maybe changed), or `null` to swallow it. */
  onIncoming?(message: Message): Message | null;

  /**
   * Run `onIncoming` before the app's `intercept()` functions. For a primitive
   * that drops messages the app must never see, such as a duplicate.
   */
  beforeIntercepts?: boolean;

  /** See an outgoing message. Return it (maybe changed), or `null` to cancel the send. */
  onOutgoing?(message: Message): Message | null;

  /**
   * Runs just before the socket opens, on every reconnect (skipped on the first connect).
   * Awaited, so a primitive can finish any async work it needs before the
   * socket opens — e.g. `channels` can refresh a rotating auth token
   * so the re-subscribe message carries a fresh one.
   */
  onBeforeReopen?(): void | Promise<void>;

  /**
   * Runs when the server's `__connected__` frame arrives, with the values it sent,
   * before `onOpen` and `onReconnect`. The socket is still `connecting` here.
   */
  onConnected?(info: ConnectedInfo): void;

  /** Runs every time the socket opens. Return messages to send right away. */
  onOpen?(): Message[] | null;

  /** Runs only on reconnects (not the first open). Return messages to send. */
  onReconnect?(): Message[] | null;

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
   * reconnect: `stream` ends durable streams with `Disconnected`, `channels`
   * releases the idle-prevention holds it held for active channels.
   */
  onReconnectFailed?(): void;

  /** Add methods to the socket object (e.g. `socket.channel`). */
  install?(socket: LiveThingSocket): void;
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
  rawSend(message: Message, owner?: FrameOwner): SendResult;

  /**
   * Send a bare `"ping"` text frame straight to the wire. Sent as plain text
   * (not JSON) so the server's pong handler and Cloudflare's built-in ping/pong
   * response both recognize it — a JSON-encoded ping would not match those paths.
   */
  sendPing(): void;

  /** Send a message through the normal path (`onOutgoing` → fallback → wire). */
  send(message: Message, options?: InternalSendOptions): SendResult;

  /** Surface an unclaimed server error without routing it through local onError. */
  reportServerError(error: LiveThingError): void;

  /** The current connection state. */
  getState(): ConnectionState;

  /** The connection state as a store, for reacting to changes over time. */
  state: ReadableStore<ConnectionState>;

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

  /** True if an unexpected close leads to a reconnect attempt (a reconnection module is installed). */
  willReconnect(): boolean;

  /** Register a callback that runs when a `pong` frame arrives. */
  onPong(handler: () => void): void;

  /**
   * Register a handler that is offered every outgoing message. Return `'buffered'` if you
   * kept it, `'dropped'` if you refused it, or `null` to let the
   * socket send it as normal.
   */
  registerOutgoingFallback(
    handler: (message: Message, options?: InternalSendOptions) => 'buffered' | 'dropped' | null,
  ): void;

  /** Debug logger, already gated on debug mode and prefixed — use freely, no guard needed. */
  readonly log: PrimitiveLogger;

  /**
   * A per-socket key/value store for primitives that must share one instance
   * without importing each other — e.g. `platform()` and `reconnection()` both
   * reach the same signal bus through it. The socket never reads it; it only
   * hands out the same map to every primitive's `setup`.
   */
  readonly shared: Map<string, unknown>;

  /** Temporarily close the transport while keeping reconnectable primitive state. */
  suspend(): void;

  /** Reopen a suspended transport as a reconnect. */
  resume(): void;
}
