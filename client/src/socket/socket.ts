import {
  Block,
  CloseCodes,
  decodeMessage,
  encodeMessage,
  isLiveThingSubprotocol,
  LiveThingConfigError,
  tokenSubprotocols,
  utf8ByteLength,
} from '@livething/core';
import { assertValidTtl } from '~/internal/config.ts';
import { parseConnectedInfo } from '~/internal/connected.ts';
import { dispatchToHandlers, keepFrameKind, runMessageHook } from '~/internal/dispatch.ts';
import { toLiveThingError } from '~/internal/error-frame.ts';
import { NAMESPACE_DELIMITER } from '~/internal/namespace.ts';
import { createStore } from '~/internal/store.ts';
import { isProtocolFrameEvent, isReservedEventName } from '~/internal/wire-validation.ts';
import { Emitter } from '~/socket/emitter.ts';
import { websocket } from '~/transports/websocket.ts';
import type { LiveThingError } from '@livething/core';
import type { SocketConfig } from '~/internal/config.ts';
import type {
  BinaryHooks,
  FrameOwner,
  InterceptFn,
  InternalSendOptions,
  Message,
  PrimitiveHelpers,
  PrimitiveLogger,
  PrimitiveRuntime,
  SendResult,
} from '~/internal/runtime.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { SendOptions } from '~/messaging.ts';
import type { Transport, TransportFactory, TransportName } from '~/transports/transport.ts';
import type { ConnectionState } from '~/types.ts';

/** What an `onClose` handler receives. */
export interface CloseEvent {
  /** The numeric close code (e.g. 1000 normal, 4001 app-defined). */
  code: number;

  /** The reason text from the server, if any. */
  reason: string;

  /** Whether the close finished cleanly. */
  wasClean: boolean;
}

type SocketEvents = {
  open: [];
  reconnect: [];
  reconnectFailed: [];
  close: [event: CloseEvent];
  error: [error: unknown];
  serverError: [error: LiveThingError];
};

type ServerErrorRegistration = { code?: string };

interface TeardownOptions {
  intentional: boolean;
  suspended: boolean;
}

function isValidCloseCode(code: unknown): code is number {
  return (
    typeof code === 'number' &&
    Number.isInteger(code) &&
    (code === CloseCodes.NORMAL || (code >= 3000 && code <= 4999))
  );
}

function isValidCloseReason(reason: unknown): reason is string {
  return typeof reason === 'string' && utf8ByteLength(reason) <= 123;
}

const DEFAULT_TRANSPORT = websocket();

/** How long a transport that failed is skipped, so one slow start cannot keep a page on the fallback. */
const FAILED_TRANSPORT_MS = 5 * 60_000;

/** A close with no close frame, as a dropped connection reports it. */
const ABNORMAL_CLOSE = 1006;

/** Where the transports of one open connect, and with which token. */
interface TransportTarget {
  url: string;
  token: string | null;
}

/** The URL safe for a log line: no userinfo, query string or hash, which can carry credentials such as an auth token. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split(/[?#]/, 1)[0]!.replace(/\/\/[^/]*@/, '//');
  }
}

/**
 * The core connection class behind every socket. It owns the WebSocket, the
 * connection state, sending, receiving, and lazy connecting.
 *
 * Reconnection, keepalive, and buffering are separate add-on modules (primitives)
 * that plug in through `_helpers()`. This keeps code you don't use out of your
 * bundle. You never create this directly — `client()` creates it and returns a
 * typed `Socket`.
 */
export class LiveThingSocket {
  /** The open transport, or `null` when not connected. Every send and close goes through it. */
  private _transport: Transport | null = null;

  /** The native WebSocket, or `null` when not connected or on another transport. */
  get ws(): WebSocket | null {
    return this._transport?.webSocket ?? null;
  }

  private _transportStore = createStore<TransportName | null>(null, (error) =>
    this._reportError(error),
  );

  /** The transport in use, as a reactive store: its name, or `null` when not connected. */
  readonly transport: ReadableStore<TransportName | null> = this._transportStore.store;

  /** The subprotocol the server picked, or `null`. */
  protocol: string | null = null;

  /** @internal */
  _config: SocketConfig;

  /** @internal — set after construction, once add-on modules are ready. */
  _primitives: readonly PrimitiveRuntime[] = [];

  // The send and receive loops run on every frame and only call onIncoming or
  // onOutgoing. Most primitives don't have those hooks, so we pick the ones that
  // do just once here and let the loops skip the rest.
  private _incomingBeforeIntercepts: readonly PrimitiveRuntime[] = [];
  private _incoming: readonly PrimitiveRuntime[] = [];
  private _outgoing: readonly PrimitiveRuntime[] = [];

  private _knownTags: ReadonlySet<string> = new Set();

  /** @internal — the writable half; `_setState` drives it and `state` exposes it. */
  private _stateStore = createStore<ConnectionState>('closed', (error) => this._reportError(error));

  /**
   * The connection state as a reactive store: `state.get()` reads it now
   * (`'closed'` | `'connecting'` | `'open'` | `'reconnecting'`), and
   * `state.subscribe(listener)` runs `listener` with the new state on every
   * change and returns an unsubscribe.
   */
  readonly state: ReadableStore<ConnectionState> = this._stateStore.store;

  /** @internal — mirrors `state.get()` for fast internal reads and guards. */
  _state: ConnectionState = 'closed';

  /** @internal — if a listener throws, the error is caught and surfaced (never
   * re-thrown). A throwing `error` listener can't re-enter the error path, so it
   * goes straight to the console instead of looping. */
  _emitter = new Emitter<SocketEvents>((error, event) => {
    if (event === 'error') {
      queueMicrotask(() => {
        throw error;
      });
      return;
    }

    this._reportError(error);
  });

  /** @internal */
  _debug = false;

  /** @internal */
  _isFirstConnect = true;

  /** @internal — true once disconnect() is called, so we don't reconnect. */
  _intentionalClose = false;

  /** @internal — incremented to cancel an in-progress connect attempt (e.g. still resolving the URL). */
  _connectAttemptId = 0;

  /** @internal */
  _lazy: boolean;

  _lazyIdleTimer: ReturnType<typeof setTimeout> | null = null;

  _lazyConsumers = 0;

  /** @internal — listeners by event name. */
  _messageHandlers = new Map<string, Set<(payload: unknown) => void>>();

  /** @internal — set by `binary()`; `null` means binary messages are reported and dropped. */
  _binary: BinaryHooks | null = null;

  private _unexpectedCloseHandler: ((code: number, reason: string) => void) | null = null;

  private _pongHandlers: (() => void)[] = [];

  /** Runs out when the transport of the current attempt sends no `__connected__` frame in time. */
  private _connectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Until when each transport that failed recently is skipped. Memory only, never stored. */
  private readonly _failedUntil = new Map<TransportName, number>();

  /** The transports this open has not tried yet, in list order. */
  private _untried: TransportFactory[] = [];

  /** The transports this open gave up on, marked failed only if a later one connects. */
  private _failedThisOpen: TransportName[] = [];

  /** Where this open's transports connect, and with which token. */
  private _target: TransportTarget | null = null;

  private readonly _warnedFeatures = new Set<string>();

  private _outgoingFallback:
    | ((message: Message, options?: InternalSendOptions) => 'buffered' | 'dropped' | null)
    | null = null;

  private readonly _shared = new Map<string, unknown>();

  // One shared error callback, so the send loop doesn't make a new one per message.
  private readonly _reportBound = (error: unknown): void => this._reportError(error);

  private readonly _serverErrorRegistrations = new Set<ServerErrorRegistration>();

  private readonly _intercepts: readonly InterceptFn[];

  private readonly _logger: PrimitiveLogger = {
    debug: false,
    info: (...args) => this._logAt('log', ...args),
    warn: (...args) => this._logAt('warn', ...args),
    error: (...args) => this._logAt('error', ...args),
    report: (error) => this._reportError(error),
  };

  /** @internal */
  constructor(config: SocketConfig) {
    this._config = config;
    this._lazy = config.lazy ?? false;
    this._intercepts = config.intercepts ?? [];
  }

  /** @internal — attach the primitive runtimes after they're set up. */
  _setPrimitives(primitives: readonly PrimitiveRuntime[]): void {
    this._primitives = primitives;
    this._incomingBeforeIntercepts = primitives.filter((p) => p.onIncoming && p.beforeIntercepts);
    this._incoming = primitives.filter((p) => p.onIncoming && !p.beforeIntercepts);
    this._outgoing = primitives.filter((p) => p.onOutgoing);
  }

  /** @internal — the set of installed primitive tags, for `helpers.hasPrimitive`. */
  _setKnownTags(tags: ReadonlySet<string>): void {
    this._knownTags = tags;
  }

  /** Open the connection. Calling it again while open or connecting does nothing. */
  connect(): void {
    if (this._state === 'open' || this._state === 'connecting') return;

    this._intentionalClose = false;
    this._openConnection();
  }

  /**
   * Close the connection on purpose. This is a full stop: no reconnection, the
   * outgoing buffer is cleared, and add-on modules clean up. Your `on()` handlers
   * stay, so calling `connect()` later picks up where you left off.
   */
  disconnect(code = 1000, reason = ''): void {
    const validCode = isValidCloseCode(code);
    if (!validCode || !isValidCloseReason(reason)) {
      this._teardown(CloseCodes.NORMAL, '', {
        intentional: true,
        suspended: false,
      });
      const error = !validCode
        ? new RangeError(`[livething] invalid client close code: ${String(code)}`)
        : new RangeError('[livething] invalid client close reason: exceeds 123 UTF-8 bytes');
      this._reportError(error);
      return;
    }

    this._teardown(code, reason, { intentional: true, suspended: false });
  }

  /**
   * The shared teardown behind `disconnect()` and `suspend()`. `intentional` is
   * a deliberate full stop (`disconnect`), which resets the session so the next
   * connect is a first connect, not a reconnect. `suspended` is a temporary
   * platform pause (`suspend`) that will resume as the same session — both are
   * passed to each primitive's `onClose`.
   */
  private _teardown(code: number, reason: string, options: TeardownOptions): void {
    const { intentional, suspended } = options;
    this._intentionalClose = true;
    this._connectAttemptId++;
    if (intentional) this._isFirstConnect = true;
    this._clearLazyIdleTimer();

    this._clearConnectTimer();

    // Was there anything to tear down? A teardown on an already-closed socket
    // must not fire a second onClose. Closing a connecting/reconnecting socket
    // still counts (matches native close-during-connecting).
    const wasActive = this._state !== 'closed';

    if (this._transport) {
      this._transport.dispose(code, reason);
      this._setTransport(null);
    }

    this.protocol = null;

    // Add-on modules always clean up here — clear the buffer, reject pending
    // request/ack promises — even when already closed, since work may have
    // been queued since then. We do NOT zero `_lazyConsumers`: `on()` handlers
    // survive a disconnect, so they still count as consumers. Wiping the count
    // would let a later unsubscribe wrongly idle-close a socket that still has
    // live listeners.
    for (const primitive of this._primitives) {
      try {
        primitive.onClose?.({ code, reason, intentional, suspended });
      } catch (error) {
        this._reportError(error);
      }
    }

    // Clear again in case a pending-op release above started an idle timer.
    this._clearLazyIdleTimer();

    // Fire the user-facing close only once: skip it when we were already closed
    // so a redundant teardown doesn't emit a second onClose.
    if (wasActive) {
      this._setState('closed');
      this._emitter.emit('close', { code, reason, wasClean: true });
    }
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    this._lazyAcquire();

    if (!this._messageHandlers.has(event)) {
      this._messageHandlers.set(event, new Set());
    }

    const handlers = this._messageHandlers.get(event)!;
    handlers.add(handler);

    // Guard so calling this unsubscribe more than once releases the lazy hold
    // only once — a second call must not steal another listener's hold.
    let released = false;

    return () => {
      if (released) return;

      released = true;
      handlers.delete(handler);

      if (handlers.size === 0) this._messageHandlers.delete(event);

      this._lazyRelease();
    };
  }

  send(event: string, payload: unknown, options?: SendOptions): boolean {
    if (isReservedEventName(event)) {
      this._log(`send('${event}') dropped — reserved event name`);
      return false;
    }

    const result = this._send({ event, payload, metadata: null }, options);
    return result === 'sent' || result === 'buffered';
  }

  /**
   * Wait until the transport's buffered bytes are below 256 KiB, checking every 25 ms. It
   * resolves at once when the socket is not open, and stops waiting after about 50 seconds.
   */
  async drain(): Promise<void> {
    for (
      let poll = 0;
      poll < 2000 &&
      this._transport?.isOpen() === true &&
      this._transport.bufferedAmount() >= 256 * 1024;
      poll++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Runs on every open — the first connect and every reconnect. */
  onOpen(callback: () => void): () => void {
    return this._emitter.on('open', callback);
  }

  /** Runs only on reconnects, not the first connect. */
  onReconnect(callback: () => void): () => void {
    return this._emitter.on('reconnect', callback);
  }

  /** Runs once when reconnection gives up for good. */
  onReconnectFailed(callback: () => void): () => void {
    return this._emitter.on('reconnectFailed', callback);
  }

  /** Runs on every close, including ones that lead to a reconnect. */
  onClose(callback: (event: CloseEvent) => void): () => void {
    return this._emitter.on('close', callback);
  }

  /**
   * A transport-level event or a value thrown by a handler, listener, primitive,
   * or plugin hook. With no listener, it is rethrown out of band.
   */
  onError(callback: (error: unknown) => void): () => void {
    return this._emitter.on('error', callback);
  }

  /** Listen for every unclaimed server error, including codes this client does not know. */
  onServerError(callback: (error: LiveThingError<string, unknown>) => void): () => void;
  /** Listen only for an unclaimed server error with one code. */
  onServerError(
    code: string,
    callback: (error: LiveThingError<string, unknown>) => void,
  ): () => void;
  onServerError(
    codeOrCallback: string | ((error: LiveThingError<string, unknown>) => void),
    maybeCallback?: (error: LiveThingError<string, unknown>) => void,
  ): () => void {
    const code = typeof codeOrCallback === 'string' ? codeOrCallback : undefined;
    const callback = typeof codeOrCallback === 'function' ? codeOrCallback : maybeCallback;
    if (!callback) throw new TypeError('[livething] onServerError requires a callback.');

    const registration: ServerErrorRegistration = { code };
    this._serverErrorRegistrations.add(registration);
    const off = this._emitter.on('serverError', (error) => {
      if (registration.code === undefined || registration.code === error.code) callback(error);
    });

    return () => {
      this._serverErrorRegistrations.delete(registration);
      off();
    };
  }

  setDebug(enabled: boolean): void {
    this._debug = enabled;
    this._logger.debug = enabled;
  }

  /** @internal — the set of actions a primitive can call on the socket. */
  _helpers(): PrimitiveHelpers {
    return {
      config: this._config,

      log: this._logger,

      rawSend: (message, owner) => this._rawSend(message, owner),

      sendPing: () => this._transport?.sendControl('ping'),

      send: (message, options) => this._send(message, options),

      getState: () => this._state,

      state: this.state,

      hasPrimitive: (tag) => this._knownTags.has(tag),

      ensureConnected: () => this._ensureConnected(),

      lazyAcquire: () => this._lazyAcquire(),

      lazyRelease: () => this._lazyRelease(),

      reopen: () => this._openConnection(),

      enterReconnecting: () => this._setState('reconnecting'),

      giveUp: () => this._abandonReconnect(false),

      failReconnect: () => this._abandonReconnect(true),

      forceClose: (code, reason) => this._transport?.close(code, reason),

      onUnexpectedClose: (handler) => {
        this._unexpectedCloseHandler = handler;
      },

      willReconnect: () => this._unexpectedCloseHandler !== null,

      onPong: (handler) => this._pongHandlers.push(handler),

      registerOutgoingFallback: (handler) => {
        this._outgoingFallback = handler;
      },

      shared: this._shared,

      reportServerError: (error) => this._reportServerError(error),

      suspend: () =>
        this._teardown(CloseCodes.NORMAL, 'background', { intentional: false, suspended: true }),

      // Resuming a suspended transport is exactly a fresh connect: the session
      // was never reset (suspend keeps it), so `_openConnection` treats it as a
      // reconnect and primitives rejoin and continue their streams as usual.
      resume: () => this.connect(),
    };
  }

  /**
   * Reconnection has permanently given up — a non-retryable close, or out of
   * retries. Notify primitives so they can finish state they kept alive for a
   * reconnect that will never come; otherwise a durable stream's loop hangs
   * forever and an active channel's idle hold leaks. Then settle on 'closed'.
   * Only the out-of-retries path emits the public `reconnectFailed` event, to
   * keep its existing meaning.
   */
  private _abandonReconnect(emitEvent: boolean): void {
    for (const primitive of this._primitives) {
      try {
        primitive.onReconnectFailed?.();
      } catch (error) {
        this._reportError(error);
      }
    }

    this._setState('closed');
    if (emitEvent) this._emitter.emit('reconnectFailed');
  }

  private _setState(state: ConnectionState): void {
    if (this._state === state) return;

    const previous = this._state;
    this._state = state;
    this._log(`${previous} → ${state}`);
    this._stateStore.set(state);
  }

  private async _openConnection(): Promise<void> {
    const attemptId = ++this._connectAttemptId;
    this._setState('connecting');
    let configReturnsWrongType = false;

    try {
      const url =
        typeof this._config.url === 'function' ? await this._config.url() : this._config.url;
      if (attemptId !== this._connectAttemptId) return; // a disconnect() cancelled us mid-resolve

      if (typeof url !== 'string') {
        configReturnsWrongType = true;
        throw new LiveThingConfigError(
          `the connect() url must be a string, or a function that returns one, got ${url === null ? 'null' : typeof url}.`,
        );
      }

      // On a reconnect, let add-on modules do any async work before the socket
      // opens (e.g. channels refreshing a subscribe token). Skipped on the first
      // connect since nothing is subscribed yet. Each module returns a Promise only
      // when it has real async work, so a basic reconnect stays synchronous.
      // After awaiting, re-check the attempt id so a disconnect() that happened
      // mid-resolve still cancels us.
      if (!this._isFirstConnect) {
        for (const primitive of this._primitives) {
          try {
            const result = primitive.onBeforeReopen?.();
            if (result) {
              await result;
              if (attemptId !== this._connectAttemptId) return;
            }
          } catch (error) {
            this._reportError(error);
          }
        }
      }

      const token = this._config.token ? await this._config.token() : undefined;
      if (attemptId !== this._connectAttemptId) return;

      if (token !== undefined && token !== null && typeof token !== 'string') {
        configReturnsWrongType = true;
        throw new LiveThingConfigError(
          `the connect() token function must return a string or null, got ${typeof token}.`,
        );
      }

      this._log(`connecting to ${redactUrl(url)}`);

      this._untried = this._transportOrder();
      this._failedThisOpen = [];
      this._target = { url, token: token ?? null };
      this._openTransport(attemptId);
    } catch (error) {
      if (attemptId !== this._connectAttemptId) return;

      this._log('connection failed', error);
      this._reportError(error);

      // Run primitive close cleanup first (same order as ws.onclose), so a failed
      // first connect doesn't leave channel/request/ack state pending.
      for (const primitive of this._primitives) {
        try {
          primitive.onClose?.({ code: 1006, reason: 'connection failed', intentional: false });
        } catch (closeError) {
          this._reportError(closeError);
        }
      }

      // A retry would call the same broken url or token function and report the same error.
      if (configReturnsWrongType) {
        this._abandonReconnect(false);
      } else if (this._unexpectedCloseHandler) {
        this._unexpectedCloseHandler(1006, 'connection failed');
      } else {
        this._setState('closed');
      }

      this._emitter.emit('close', { code: 1006, reason: 'connection failed', wasClean: false });
    }
  }

  /**
   * The transports to try, in list order, without the ones that failed in the last 5 minutes.
   * When every one failed, all of them, so a socket always has something to try.
   */
  private _transportOrder(): TransportFactory[] {
    const listed = this._config.transports ?? [DEFAULT_TRANSPORT];
    const now = Date.now();
    const usable = listed.filter((factory) => (this._failedUntil.get(factory.name) ?? 0) <= now);
    return usable.length > 0 ? usable : [...listed];
  }

  /**
   * Open the next untried transport of this attempt. One that throws while opening counts
   * as failed, and the one after it is tried. Throws only when none is left.
   */
  private _openTransport(attemptId: number): void {
    for (;;) {
      const factory = this._untried.shift()!;
      try {
        this._startTransport(attemptId, factory);
        return;
      } catch (error) {
        if (this._untried.length === 0) throw error;

        this._log(`${factory.name} could not open; trying the next one`, error);
        this._failedThisOpen.push(factory.name);
      }
    }
  }

  private _startTransport(attemptId: number, factory: TransportFactory): void {
    const target = this._target!;
    let heldError: unknown;
    // Kept from the start, so a teardown can close it before the server accepts it.
    // Events from a transport that is no longer the current one, such as a late
    // frame after a timeout or a close, are ignored.
    const isCurrent = () => this._transport === transport;
    // A transport may fire events before `open` returns, when `transport` is not set yet.
    // They wait until it is, then run in order.
    let early: (() => void)[] | null = [];
    function afterOpen<Args extends unknown[]>(handle: (...args: Args) => void) {
      return (...args: Args): void => {
        if (early) early.push(() => handle(...args));
        else handle(...args);
      };
    }

    const transport: Transport = factory.open({
      url: target.url,
      protocols: tokenSubprotocols(target.token, this._config.protocols),
      token: target.token,
      binary: this._binary !== null,
      warn: (message) => this._logger.warn(message),
      events: {
        open: afterOpen(() => {
          if (isCurrent()) this._log('waiting for __connected__');
        }),
        close: afterOpen((code: number, reason: string, wasClean: boolean) => {
          if (!isCurrent()) return;

          const close = { code, reason, wasClean };
          const error = heldError;
          heldError = undefined;
          if (this._failOver(attemptId, close)) return;

          if (error !== undefined) this._reportError(error);

          this._handleTransportClose(attemptId, close);
        }),
        error: afterOpen((event: unknown) => {
          if (!isCurrent()) return;

          this._log(`${transport.name} error`);
          // While connecting, the close that follows decides: a transport that fails over
          // is not the app's problem, so its error is only reported if it does not.
          if (this._state === 'connecting') heldError = event;
          else this._reportError(event);
        }),
        message: afterOpen((data: string | ArrayBuffer) => {
          if (isCurrent()) this._handleMessage(data);
        }),
        stable: afterOpen(() => {
          if (isCurrent() && this._state === 'open') this._handleStable();
        }),
        unusable: afterOpen(() => {
          if (!isCurrent()) return;

          this._log(`${transport.name} cannot carry data here; skipping it for 5 minutes`);
          this._failedUntil.set(transport.name, Date.now() + FAILED_TRANSPORT_MS);
        }),
      },
    });
    this._transport = transport;
    this._startConnectTimer(attemptId);

    const waiting = early;
    early = null;
    for (const run of waiting) run();
  }

  /** Whether a failure now would move on to another transport instead of closing. */
  private _mayFailOver(): boolean {
    return this._state === 'connecting' && this._untried.length > 0 && !this._intentionalClose;
  }

  /**
   * Try the next transport when the current one failed before its `__connected__` frame
   * with no answer: a timeout or a drop (1006). A close with any other code is the server's
   * answer and is final. Returns whether it moved on.
   */
  private _failOver(attemptId: number, close: CloseEvent): boolean {
    if (attemptId !== this._connectAttemptId || !this._target) return false;

    if (close.code !== ABNORMAL_CLOSE || !this._mayFailOver()) return false;

    const failed = this._transport;
    this._clearConnectTimer();
    this._transport = null;
    failed?.dispose();
    if (failed) this._failedThisOpen.push(failed.name);

    this._log(`${failed?.name ?? 'transport'} failed while connecting; trying the next one`);
    try {
      this._openTransport(attemptId);
    } catch (error) {
      this._reportError(error);
      this._handleTransportClose(attemptId, close);
    }

    return true;
  }

  private _setTransport(transport: Transport | null): void {
    this._transport = transport;
    this._transportStore.set(transport?.name ?? null);
  }

  private _startConnectTimer(attemptId: number): void {
    const transportCount = this._config.transports?.length ?? 1;
    const timeout = this._config.connectTimeoutMs ?? (transportCount > 1 ? 5_000 : 30_000);
    this._connectTimer = setTimeout(() => {
      this._connectTimer = null;
      this._abandonTransport(
        attemptId,
        new Error(`[livething] the server did not accept the connection within ${timeout} ms.`),
        { code: 1006, reason: 'connect timeout', wasClean: false },
      );
    }, timeout);
  }

  private _clearConnectTimer(): void {
    if (this._connectTimer === null) return;

    clearTimeout(this._connectTimer);
    this._connectTimer = null;
  }

  /** Close a transport that sent no usable `__connected__` frame, and handle it as a drop. */
  private _abandonTransport(attemptId: number, error: Error, close: CloseEvent): void {
    if (attemptId !== this._connectAttemptId) return;

    // A transport that fails over is not the app's problem, so its error is only logged.
    if (this._failOver(attemptId, close)) {
      this._log(error.message);
      return;
    }

    this._reportError(error);
    this._transport?.dispose();
    this._handleTransportClose(attemptId, close);
  }

  private _handleConnected(payload: unknown): void {
    const attemptId = this._connectAttemptId;
    const info = parseConnectedInfo(payload);
    if (!info) {
      this._abandonTransport(
        attemptId,
        new Error('[livething] the server sent a __connected__ frame this client cannot read.'),
        { code: CloseCodes.PROTOCOL_ERROR, reason: 'bad __connected__ frame', wasClean: false },
      );
      return;
    }

    this._clearConnectTimer();
    this._warnMissingFeatures(info.features);
    for (const primitive of this._primitives) {
      try {
        primitive.onConnected?.(info);
      } catch (error) {
        this._reportError(error);
      }
    }

    // A hook can disconnect, and then there is nothing left to open.
    const transport = this._transport;
    if (attemptId === this._connectAttemptId && transport) this._handleOpen(transport);
  }

  /** Warn once for each client primitive whose server feature is off. */
  private _warnMissingFeatures(features: readonly string[]): void {
    for (const feature of ['replay', 'binary', 'uploads']) {
      if (!this._knownTags.has(feature) || features.includes(feature)) continue;

      if (this._warnedFeatures.has(feature)) continue;

      this._warnedFeatures.add(feature);
      this._logger.warn(
        `${feature}() is on the client, but the server does not have it on, so it will not work. Turn it on in the server, or remove ${feature}() from the client.`,
      );
    }
  }

  private _handleOpen(transport: Transport): void {
    // A later transport connected, so the ones before it really failed on this network.
    for (const name of this._failedThisOpen) {
      this._failedUntil.set(name, Date.now() + FAILED_TRANSPORT_MS);
    }

    this._failedThisOpen = [];
    this._transportStore.set(transport.name);
    const protocol = transport.protocol;
    this.protocol = protocol && !isLiveThingSubprotocol(protocol) ? protocol : null;
    this._setState('open');

    const isReconnect = !this._isFirstConnect;
    this._isFirstConnect = false;

    // On a reconnect, restore membership state BEFORE flushing queued ops:
    // channels rejoin and durable streams continue in onReconnect, so a request,
    // ack, scoped send, stream trigger, or nudge queued during the drop reaches
    // the server only after its channel is rejoined and its stream continued.
    // Otherwise a queued channel op races ahead of the rejoin and the server
    // answers ChannelNotSubscribed or it times out.
    if (isReconnect) {
      for (const primitive of this._primitives) {
        try {
          this._flushPrimitiveFrames(primitive.onReconnect?.());
        } catch (error) {
          this._reportError(error);
        }
      }
    }

    // Then the flush phase: replay, the request/ack/stream outboxes, the
    // subscribe/unsubscribe flush, and the buffered messages — now ordered
    // after the rejoin/continue above.
    for (const primitive of this._primitives) {
      try {
        this._flushPrimitiveFrames(primitive.onOpen?.());
      } catch (error) {
        this._reportError(error);
      }
    }

    this._emitter.emit('open');
    if (isReconnect) this._emitter.emit('reconnect');

    // One connection that carries both directions has proved itself by opening.
    if (!transport.reportsStable && this._transport === transport) this._handleStable();

    // If we opened with no active listeners (e.g. the last one unsubscribed
    // while reconnecting), start the idle timer now — the open is the only
    // place that can, because _lazyRelease only runs while the socket is open.
    if (this._lazy && this._lazyConsumers === 0) this._startLazyIdleTimer();
  }

  private _handleStable(): void {
    for (const primitive of this._primitives) {
      try {
        primitive.onStable?.();
      } catch (error) {
        this._reportError(error);
      }
    }
  }

  private _handleTransportClose(attemptId: number, event: CloseEvent): void {
    if (attemptId !== this._connectAttemptId) return;

    this._clearConnectTimer();
    this._setTransport(null);
    this.protocol = null;

    for (const primitive of this._primitives) {
      try {
        primitive.onClose?.({ code: event.code, reason: event.reason, intentional: false });
      } catch (error) {
        this._reportError(error);
      }
    }

    this._clearLazyIdleTimer();

    // Update the state BEFORE firing onClose so a handler that reads
    // getState() sees the final state ('reconnecting' or 'closed').
    if (this._intentionalClose) {
      this._setState('closed');
    } else if (this._unexpectedCloseHandler) {
      // The reconnection module decides what to do next (sets 'reconnecting'
      // or gives up to 'closed'); without it, an unexpected drop stays closed.
      this._unexpectedCloseHandler(event.code, event.reason);
    } else {
      this._setState('closed');
    }

    this._emitter.emit('close', event);
  }

  private _handleMessage(raw: unknown): void {
    if (raw === 'ping') {
      this._log('ping received');
      this._transport?.sendControl('pong');
      return;
    }

    if (raw === 'pong') {
      this._log('pong received');
      dispatchToHandlers(this._pongHandlers, this._logger);
      return;
    }

    // A transport counts as working only once the server accepts it with `__connected__`.
    if (this._state !== 'open') {
      const first = typeof raw === 'string' ? decodeMessage(raw) : null;
      if (first?.event === '__connected__') {
        this._handleConnected(first.payload);
      } else {
        this._log('a frame arrived before __connected__ — dropping it');
      }

      return;
    }

    // Without binary(), report a binary message instead of throwing out of
    // `onmessage`: an uncaught throw there would break the WebSocket callback.
    if (typeof raw !== 'string') {
      if (this._binary) {
        this._binary.receive(raw);
      } else {
        this._reportError(
          new Error(
            '[livething] a binary message arrived and was dropped. Register binary() in client().',
          ),
        );
      }

      return;
    }

    const parsed = decodeMessage(raw);
    if (!parsed) {
      this._log('could not parse message — dropping it');
      return;
    }

    this._processIncoming(parsed);
  }

  /**
   * Run your intercepts on an app message. Returns the (maybe changed) message,
   * or null when an intercept threw Block. Protocol frames, request replies and
   * server-to-client requests (they belong to one pending call), and a plugin's
   * own namespaced traffic skip intercepts.
   */
  private _runIntercepts(parsed: Message): Message | null {
    if (this._intercepts.length === 0) return parsed;

    if (parsed.event.startsWith('__')) return parsed;

    if (parsed.metadata?.exchange !== undefined) return parsed;

    const channelName = parsed.metadata?.channel?.name;
    if (channelName?.startsWith('__') && channelName.includes(NAMESPACE_DELIMITER)) return parsed;

    let message = parsed;
    const bytes = parsed.bytes;
    for (const intercept of this._intercepts) {
      try {
        const result = intercept(message);
        message = keepFrameKind(bytes, result ? result : message);
      } catch (error) {
        message = keepFrameKind(bytes, message);
        if (error === Block) {
          if (this._debug) this._log(`intercept dropped '${message.event}'`);
          return null;
        }

        // A real error is isolated: log it and skip this intercept, so a bug in
        // one intercept does not silently swallow messages.
        this._reportError(error);
      }
    }

    return message;
  }

  /**
   * Run a list of add-on module `onIncoming` hooks. Returns the (maybe changed)
   * message, or null when a module consumed it. A throw is isolated: we log it
   * and skip that module so the rest of the pipeline still runs.
   */
  private _runIncoming(primitives: readonly PrimitiveRuntime[], parsed: Message): Message | null {
    let message = parsed;
    const bytes = parsed.bytes;
    for (const primitive of primitives) {
      try {
        const result = primitive.onIncoming!(message);
        if (result === null) {
          if (this._debug) this._log(`primitive '${primitive.id}' handled '${parsed.event}'`);
          return null;
        }

        message = keepFrameKind(bytes, result);
      } catch (error) {
        message = keepFrameKind(bytes, message);
        this._reportError(error);
      }
    }

    return message;
  }

  /**
   * @internal — the pipeline a parsed message runs through: add-on module
   * `onIncoming` hooks, then the error-frame check, then your intercepts, then
   * top-level dispatch. Split out from `_handleMessage` so testing's `inject()`
   * can push a message through the same path without a live socket.
   */
  _processIncoming(parsed: Message): void {
    // Modules that must drop a message before the app sees it (dedup) run first.
    // Then your intercepts, before any module delivers the message to channel
    // listeners or stream loops, so throwing Block drops any app message.
    const early = this._runIncoming(this._incomingBeforeIntercepts, parsed);
    if (early === null) return;

    const intercepted = this._runIntercepts(early);
    if (intercepted === null) return;

    const message = this._runIncoming(this._incoming, intercepted);
    if (message === null) return;

    // An `__error__` frame no module claimed becomes an onServerError call instead
    // of a normal event. It never falls into onError: those callbacks are for
    // local, transport, and hook failures.
    if (message.event === '__error__') {
      this._reportServerError(toLiveThingError(message.payload));
      return;
    }

    // An unclaimed reserved protocol frame is protocol bookkeeping, not user traffic — drop it
    // rather than leak to a `.on()` handler. Plugin-namespaced `__id::event` frames pass through.
    if (isProtocolFrameEvent(message.event)) return;

    if (message.bytes) {
      this._binary?.route(message);
      return;
    }

    // Top-level handlers only see top-level events. Messages tagged with a
    // channel or stream id are delivered by the matching add-on module, so they
    // don't fire here too.
    const metadata = message.metadata;
    if (metadata?.channel === undefined && metadata?.stream === undefined) {
      // Guard the log so the message string and args aren't built on every
      // frame when setDebug(true) was not called (they would be, even though _logAt no-ops).
      if (this._debug) this._log(`received '${message.event}'`, message.payload);
      this._dispatchMessage(message.event, message.payload);
    }
  }

  /** @internal — open the socket on demand if lazy mode is on and it's not already open. */
  _ensureConnected(): void {
    if (!this._lazy) return;

    if (this._state === 'open' || this._state === 'connecting' || this._state === 'reconnecting') {
      return;
    }

    this._clearLazyIdleTimer();

    this._log('lazy connect triggered');

    this.connect();
  }

  /** @internal */
  _lazyAcquire(): void {
    this._lazyConsumers++;
    this._clearLazyIdleTimer();
    this._ensureConnected();
  }

  /** @internal */
  _lazyRelease(): void {
    this._lazyConsumers = Math.max(0, this._lazyConsumers - 1);
    if (this._lazy && this._lazyConsumers === 0 && this._state === 'open') {
      this._startLazyIdleTimer();
    }
  }

  private _startLazyIdleTimer(): void {
    this._clearLazyIdleTimer();

    const timeout = this._config.lazyIdleTimeoutMs ?? 10_000;
    if (timeout <= 0) return;

    this._lazyIdleTimer = setTimeout(() => {
      this._log('lazy idle timeout — disconnecting');
      this.disconnect();
    }, timeout);
  }

  private _clearLazyIdleTimer(): void {
    if (this._lazyIdleTimer !== null) {
      clearTimeout(this._lazyIdleTimer);
      this._lazyIdleTimer = null;
    }
  }

  /**
   * @internal — the full send path: open the socket if lazy, let add-on modules
   * adjust or cancel the message, then either write it, hand it to the outgoing
   * buffer, or drop it.
   */
  _send(message: Message, options?: InternalSendOptions): SendResult {
    if (options?.ttl !== undefined) assertValidTtl(options.ttl, 'send');

    this._ensureConnected();

    let outgoing: Message | null = message;
    const bytes = message.bytes;
    for (const primitive of this._outgoing) {
      // Block cancels the send; any other throw is reported and the message
      // passes through unchanged.
      const result = runMessageHook(primitive.onOutgoing!, outgoing!, this._reportBound);

      if (result === null) {
        this._log('a primitive cancelled the send');
        return 'blocked';
      }

      outgoing = keepFrameKind(bytes, result);
    }

    // Offer to the outgoing fallback (buffering) first: it takes the message
    // while offline, or while a staggered flush is still draining so a live send
    // can't jump ahead of not-yet-flushed messages. It declines when open and idle.
    const kept = this._outgoingFallback?.(outgoing, options);
    if (kept) return kept;

    if (this._state !== 'open' || !this._transport) {
      if (this._debug) this._log(`send('${outgoing.event}') not sent — not connected`);
      // connecting/reconnecting still has a flush coming; closed does not.
      return this._state === 'connecting' || this._state === 'reconnecting'
        ? 'connecting'
        : 'closed';
    }

    this._transport.send(this._encode(outgoing));
    if (this._debug) this._log(`send('${outgoing.event}')`, outgoing.payload);

    // A send counts as activity. In lazy mode with no active listeners the idle
    // timer is running; restart it so a send-only client isn't closed mid-stream
    // (matches the "no recent send()" idle condition).
    if (this._lazy && this._lazyConsumers === 0 && this._state === 'open') {
      this._startLazyIdleTimer();
    }

    return 'sent';
  }

  /**
   * Send each frame a primitive returned from `onOpen`/`onReconnect`, isolating
   * every frame so one that won't serialize is reported without stranding the rest.
   */
  private _flushPrimitiveFrames(messages: Message[] | null | undefined): void {
    if (!messages) return;

    for (const message of messages) {
      try {
        this._rawSend(message);
      } catch (error) {
        this._reportError(error);
      }
    }
  }

  /**
   * @internal — write straight to the wire, skipping outgoing hooks. Returns
   * where it went so a Promise-bearing protocol op can queue or fail fast.
   *
   * When an `owner` is given (a Promise-bearing op flushing a held frame), a
   * serialization or send throw (a message over the POST limit of server-sent
   * events) rejects that owner and is reported, instead of escaping to the
   * caller — so a flush of one bad frame can't strand the owner or the frames
   * queued behind it.
   */
  _rawSend(message: Message, owner?: FrameOwner): SendResult {
    if (this._state === 'open' && this._transport) {
      if (owner) {
        try {
          this._transport.send(this._encode(message));
        } catch (error) {
          owner.reject(error);
          this._reportError(error);
        }

        return 'sent';
      }

      this._transport.send(this._encode(message));
      return 'sent';
    }

    return this._state === 'connecting' || this._state === 'reconnecting' ? 'connecting' : 'closed';
  }

  private _encode(message: Message): string | Uint8Array<ArrayBuffer> {
    return this._binary ? this._binary.encode(message) : encodeMessage(message);
  }

  /** @internal — call every handler listening for this event. */
  _dispatchMessage(event: string, payload: unknown): void {
    dispatchToHandlers(this._messageHandlers.get(event), this._logger, payload);
  }

  private _log(...args: unknown[]): void {
    this._logAt('log', ...args);
  }

  /** @internal — all log output goes through here; checks debug mode and adds the `[livething]` prefix. */
  private _logAt(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
    if (!this._debug) return;

    console[level]('[livething]', ...args);
  }

  /**
   * @internal — surface a caught throw on the `error` event. With no listener,
   * rethrow it out-of-band so it reaches the host's global error handler
   * (`window.onerror`, error trackers) without unwinding the dispatch loop.
   */
  private _reportError(error: unknown): void {
    if (this._emitter.listenerCount('error') > 0) {
      this._emitter.emit('error', error);
    } else {
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  /** Surface an unclaimed server error without routing it to the local error event. */
  _reportServerError(error: LiveThingError): void {
    const handled = [...this._serverErrorRegistrations].some(
      (registration) => registration.code === undefined || registration.code === error.code,
    );
    if (handled) {
      this._emitter.emit('serverError', error);
    } else {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
