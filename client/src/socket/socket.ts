import { Block, CloseCodes } from '@wskit/core';
import { dispatchToHandlers, runMessageHook } from '~/internal/dispatch.ts';
import { toWSKitError } from '~/internal/error-frame.ts';
import { createStore } from '~/internal/store.ts';
import { isThenable } from '~/internal/thenable.ts';
import { isProtocolFrameEvent, isReservedEventName } from '~/internal/wire-validation.ts';
import { Emitter } from '~/socket/emitter.ts';
import type { WSKitError } from '@wskit/core';
import type { SocketConfig } from '~/internal/config.ts';
import type {
  FrameOwner,
  InterceptFn,
  InternalSendOptions,
  PrimitiveHelpers,
  PrimitiveLogger,
  PrimitiveRuntime,
  SendResult,
  WireMessage,
  WSKitEnvelope,
} from '~/internal/runtime.ts';
import type { ReadableStore } from '~/internal/store.ts';
import type { SendOptions } from '~/messaging.ts';
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
  serverError: [error: WSKitError];
};

type ServerErrorRegistration = { code?: string };

interface TeardownOptions {
  intentional: boolean;
  suspended: boolean;
}

/** Default reader: turn a text frame into `{ event, payload, __wskit? }`. */
function defaultParse(raw: string): WireMessage | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.event !== 'string') return null;

  const message: WireMessage = { event: parsed.event, payload: parsed.payload };
  if (parsed.__wskit && typeof parsed.__wskit === 'object') {
    message.__wskit = parsed.__wskit as WSKitEnvelope;
  }

  return message;
}

/** Default writer: turn a message into the JSON string sent over the wire. */
function defaultSerialize(message: WireMessage): string {
  return message.__wskit
    ? JSON.stringify({ event: message.event, payload: message.payload, __wskit: message.__wskit })
    : JSON.stringify({ event: message.event, payload: message.payload });
}

function isValidCloseCode(code: unknown): code is number {
  return (
    typeof code === 'number' &&
    Number.isInteger(code) &&
    (code === CloseCodes.NORMAL || (code >= 3000 && code <= 4999))
  );
}

function isValidCloseReason(reason: unknown): reason is string {
  return typeof reason === 'string' && new TextEncoder().encode(reason).byteLength <= 123;
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
export class WSKitSocket {
  /** The native WebSocket, or `null` when not connected. */
  ws: WebSocket | null = null;

  /** The subprotocol the server picked, or `null`. */
  protocol: string | null = null;

  /** @internal */
  _config: SocketConfig;

  /** @internal — set after construction, once add-on modules are ready. */
  _primitives: readonly PrimitiveRuntime[] = [];

  // The send and receive loops run on every frame and only call onIncoming or
  // onOutgoing. Most primitives don't have those hooks, so we pick the ones that
  // do just once here and let the loops skip the rest.
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

  private _unexpectedCloseHandler: ((code: number, reason: string) => void) | null = null;

  // One reconnect decision per close: stream cleanup (willReconnect) and the
  // reconnection module must not re-evaluate a stateful policy and disagree.
  private _reconnectDecision: { code: number; reason: string; result: boolean | undefined } | null =
    null;

  private _pongHandlers: (() => void)[] = [];

  private _outgoingFallback:
    | ((message: WireMessage, options?: InternalSendOptions) => boolean)
    | null = null;

  private readonly _shared = new Map<string, unknown>();

  // One shared error callback, so the send loop doesn't make a new one per message.
  private readonly _reportBound = (error: unknown): void => this._reportError(error);

  private readonly _serverErrorRegistrations = new Set<ServerErrorRegistration>();

  private readonly _parse: (raw: string) => WireMessage | null;
  private readonly _serialize: (message: WireMessage) => string;
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
    this._debug = config.debug ?? false;
    this._logger.debug = this._debug;
    this._lazy = config.lazy ?? false;
    this._parse = config.parse ?? defaultParse;

    this._serialize = config.serialize ?? defaultSerialize;
    this._intercepts = config.intercepts ?? [];
  }

  /** @internal — attach the primitive runtimes after they're set up. */
  _setPrimitives(primitives: readonly PrimitiveRuntime[]): void {
    this._primitives = primitives;
    this._incoming = primitives.filter((p) => p.onIncoming);
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
        ? new RangeError(`[wskit] invalid client close code: ${String(code)}`)
        : new RangeError('[wskit] invalid client close reason: exceeds 123 UTF-8 bytes');
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

    // Was there anything to tear down? A teardown on an already-closed socket
    // must not fire a second onClose. Closing a connecting/reconnecting socket
    // still counts (matches native close-during-connecting).
    const wasActive = this._state !== 'closed';

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close(code, reason);

      this.ws = null;
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
        primitive.onClose?.(code, reason, intentional, suspended);
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

    const result = this._send({ event, payload }, options);
    return result === 'sent' || result === 'buffered';
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
  onServerError(callback: (error: WSKitError<string, unknown>) => void): () => void;
  /** Listen only for an unclaimed server error with one code. */
  onServerError(code: string, callback: (error: WSKitError<string, unknown>) => void): () => void;
  onServerError(
    codeOrCallback: string | ((error: WSKitError<string, unknown>) => void),
    maybeCallback?: (error: WSKitError<string, unknown>) => void,
  ): () => void {
    const code = typeof codeOrCallback === 'string' ? codeOrCallback : undefined;
    const callback = typeof codeOrCallback === 'function' ? codeOrCallback : maybeCallback;
    if (!callback) throw new TypeError('[wskit] onServerError requires a callback.');

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

      sendPing: () => this.ws?.send('ping'),

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

      forceClose: (code, reason) => this.ws?.close(code, reason),

      onUnexpectedClose: (handler) => {
        this._unexpectedCloseHandler = handler;
      },

      runShouldReconnect: (code, reason) => this._runShouldReconnect(code, reason),

      willReconnect: (code, reason) =>
        this._unexpectedCloseHandler !== null && this._runShouldReconnect(code, reason) !== false,

      onPong: (handler) => this._pongHandlers.push(handler),

      registerOutgoingFallback: (handler) => {
        this._outgoingFallback = handler;
      },

      shared: this._shared,

      reportServerError: (error) => this._reportServerError(error),

      disconnect: (code, reason) => this.disconnect(code, reason),

      connect: () => this.connect(),

      suspend: (code, reason) => this._suspend(code, reason),

      // Resuming a suspended transport is exactly a fresh connect: the session
      // was never reset (suspend keeps it), so `_openConnection` treats it as a
      // reconnect and primitives rejoin/resume as usual.
      resume: () => this.connect(),
    };
  }

  private _suspend(code = 1000, reason = 'background'): void {
    this._teardown(code, reason, { intentional: false, suspended: true });
  }

  /**
   * Reconnection has permanently given up — a non-retryable close, or out of
   * retries. Notify primitives so they can finish state they kept alive for a
   * reconnect that will never come; otherwise a resumable stream's loop hangs
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

  private _runShouldReconnect(code: number, reason: string): boolean | undefined {
    if (
      this._reconnectDecision &&
      this._reconnectDecision.code === code &&
      this._reconnectDecision.reason === reason
    ) {
      return this._reconnectDecision.result;
    }

    const result = this._evaluateShouldReconnect(code, reason);
    this._reconnectDecision = { code, reason, result };
    return result;
  }

  private _evaluateShouldReconnect(code: number, reason: string): boolean | undefined {
    for (const primitive of this._primitives) {
      if (!primitive.shouldReconnect) continue;

      // Isolate each vote so a throwing policy can't abort the close flow.
      let result: boolean | void;
      try {
        result = primitive.shouldReconnect(code, reason);
      } catch (error) {
        this._logger.report(error);
        continue;
      }

      if (result === true || result === false) return result;
    }

    return undefined;
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

    try {
      const baseUrl =
        typeof this._config.url === 'function' ? await this._config.url() : this._config.url;
      if (attemptId !== this._connectAttemptId) return; // a disconnect() cancelled us mid-resolve

      // Let add-on modules rewrite the URL before connecting (e.g. query() adds
      // params). They chain, each seeing the previous result. Only async hooks
      // are awaited, so a connect with no URL hooks stays synchronous.
      let finalUrl = baseUrl;
      for (const primitive of this._primitives) {
        if (!primitive.resolveUrl) continue;

        const result = primitive.resolveUrl(finalUrl);
        if (isThenable<string>(result)) {
          finalUrl = await result;
          if (attemptId !== this._connectAttemptId) return;
        } else {
          finalUrl = result;
        }
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

      this._log(`connecting to ${finalUrl}`);

      const ws = new WebSocket(finalUrl, this._config.protocols);
      if (this._config.binaryType) ws.binaryType = this._config.binaryType;

      ws.onopen = () => {
        if (attemptId !== this._connectAttemptId) {
          ws.close();
          return;
        }

        this.ws = ws;
        this.protocol = ws.protocol || null;
        this._setState('open');

        const isReconnect = !this._isFirstConnect;
        this._isFirstConnect = false;

        // On a reconnect, restore membership state BEFORE flushing queued ops:
        // channels rejoin and durable streams resume in onReconnect, so a request,
        // ack, scoped send, stream trigger, or nudge queued during the drop reaches
        // the server only after its channel is rejoined and its stream resumed.
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
        // after the rejoin/resume above.
        for (const primitive of this._primitives) {
          try {
            this._flushPrimitiveFrames(primitive.onOpen?.());
          } catch (error) {
            this._reportError(error);
          }
        }

        this._emitter.emit('open');
        if (isReconnect) this._emitter.emit('reconnect');

        // If we opened with no active listeners (e.g. the last one unsubscribed
        // while reconnecting), start the idle timer now — onopen is the only
        // place that can, because _lazyRelease only runs while the socket is open.
        if (this._lazy && this._lazyConsumers === 0) this._startLazyIdleTimer();
      };

      ws.onclose = (event) => {
        if (attemptId !== this._connectAttemptId) return;

        this.ws = null;
        this.protocol = null;
        this._reconnectDecision = null;

        for (const primitive of this._primitives) {
          try {
            primitive.onClose?.(event.code, event.reason, false, false);
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

        this._emitter.emit('close', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      };

      ws.onerror = (event) => {
        if (attemptId !== this._connectAttemptId) return;

        this._log('WebSocket error');
        this._reportError(event);
      };

      ws.onmessage = (event) => {
        if (attemptId !== this._connectAttemptId) return;

        this._handleMessage(event);
      };
    } catch (error) {
      if (attemptId !== this._connectAttemptId) return;

      this._log('connection failed', error);
      this._reportError(toWSKitError(error));
      this._reconnectDecision = null;

      // Run primitive close cleanup first (same order as ws.onclose), so a failed
      // first connect doesn't leave channel/request/ack state pending.
      for (const primitive of this._primitives) {
        try {
          primitive.onClose?.(1006, 'connection failed', false, false);
        } catch (closeError) {
          this._reportError(closeError);
        }
      }

      if (this._unexpectedCloseHandler) {
        this._unexpectedCloseHandler(1006, 'connection failed');
      } else {
        this._setState('closed');
        this._emitter.emit('close', { code: 1006, reason: 'connection failed', wasClean: false });
      }
    }
  }

  private _handleMessage(event: MessageEvent): void {
    const raw = event.data;

    if (raw === 'ping') {
      this._log('ping received');
      this.ws?.send('pong');
      return;
    }

    if (raw === 'pong') {
      this._log('pong received');
      dispatchToHandlers(this._pongHandlers, this._logger);
      return;
    }

    // TODO: binary support is planned. Until then, surface a binary frame
    // through the normal error path instead of throwing out of `onmessage`
    // (an uncaught exception there would crash the WebSocket callback).
    if (typeof raw !== 'string') {
      this._reportError(new Error('[wskit] binary frames are not supported yet'));
      return;
    }

    let parsed: WireMessage | null = null;
    try {
      parsed = this._parse(raw);
    } catch {
      this._log('could not parse message — dropping it');
      return;
    }

    if (!parsed) return;

    this._processIncoming(parsed);
  }

  /**
   * @internal — the pipeline a parsed message runs through: add-on module
   * `onIncoming` hooks, then the error-frame check, then your intercepts, then
   * top-level dispatch. Split out from `_handleMessage` so testing's `inject()`
   * can push a message through the same path without a live socket.
   */
  _processIncoming(parsed: WireMessage): void {
    // Let add-on modules see it first; any of them can consume it by returning null.
    // A throw is isolated (same as intercepts and lifecycle callbacks): we log it
    // and skip that module so the rest of the pipeline still runs.
    let message: WireMessage = parsed;
    for (const primitive of this._incoming) {
      try {
        const result = primitive.onIncoming!(message);
        if (result === null) {
          if (this._debug) this._log(`primitive '${primitive.id}' handled '${parsed.event}'`);
          return;
        }

        message = result;
      } catch (error) {
        this._reportError(error);
      }
    }

    // An `__error__` frame no module claimed becomes an onServerError call instead
    // of a normal event. It never falls into onError: those callbacks are for
    // local, transport, and hook failures.
    if (message.event === '__error__') {
      this._reportServerError(toWSKitError(message.payload));
      return;
    }

    // Your intercepts run last and can change or drop the message (throw Block to drop).
    if (this._intercepts.length) {
      for (const intercept of this._intercepts) {
        try {
          const result = intercept(message);
          if (result) message = result;
        } catch (error) {
          if (error === Block) {
            // An intentional drop: stop the chain and drop the message.
            if (this._debug) this._log(`intercept dropped '${message.event}'`);
            return;
          }

          // A real error is isolated like an onIncoming throw above: log it and
          // skip this intercept so the message and the remaining intercepts still
          // run — a bug in one intercept must not silently swallow messages.
          this._reportError(error);
        }
      }
    }

    // An unclaimed reserved protocol frame is protocol bookkeeping, not user traffic — drop it
    // rather than leak to a `.on()` handler. Plugin-namespaced `__id::event` frames pass through.
    if (isProtocolFrameEvent(message.event)) return;

    // Top-level handlers only see top-level events. Messages tagged with a
    // channel or stream id are delivered by the matching add-on module, so they
    // don't fire here too.
    const envelope = message.__wskit;
    if (envelope?.channel === undefined && envelope?.streamId === undefined) {
      // Guard the log so the message string and args aren't built on every
      // frame when debug is off (they would be, even though _logAt no-ops).
      if (this._debug) this._log(`received '${message.event}'`, message.payload);
      this._dispatchMessage(message.event, message.payload);
    }
  }

  /** @internal — open the socket on demand if lazy mode is on and it's not already open. */
  _ensureConnected(): void {
    if (!this._lazy) return;

    if (this._state === 'open' || this._state === 'connecting' || this._state === 'reconnecting')
      return;

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

    const timeout = this._config.idleTimeout ?? 10_000;
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
  _send(message: WireMessage, options?: InternalSendOptions): SendResult {
    this._ensureConnected();

    let outgoing: WireMessage | null = message;
    for (const primitive of this._outgoing) {
      // Block cancels the send; any other throw is reported and the message
      // passes through unchanged.
      outgoing = runMessageHook(primitive.onOutgoing!, outgoing!, this._reportBound);

      if (outgoing === null) {
        this._log('a primitive cancelled the send');
        return 'blocked';
      }
    }

    // Offer to the outgoing fallback (buffering) first: it takes the message
    // while offline, or while a staggered flush is still draining so a live send
    // can't jump ahead of not-yet-flushed messages. It declines when open and idle.
    if (this._outgoingFallback?.(outgoing, options)) {
      if (this._debug) this._log(`send('${outgoing.event}') buffered`);
      return 'buffered';
    }

    if (this._state !== 'open' || !this.ws) {
      if (this._debug) this._log(`send('${outgoing.event}') not sent — not connected`);
      // connecting/reconnecting still has a flush coming; closed does not.
      return this._state === 'connecting' || this._state === 'reconnecting'
        ? 'connecting'
        : 'closed';
    }

    this.ws.send(this._serialize(outgoing));
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
  private _flushPrimitiveFrames(messages: WireMessage[] | null | undefined): void {
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
   * serialization throw rejects that owner and is reported, instead of escaping
   * to the caller — so a flush of one bad frame can't strand the owner or the
   * frames queued behind it.
   */
  _rawSend(message: WireMessage, owner?: FrameOwner): SendResult {
    if (this._state === 'open' && this.ws) {
      if (owner) {
        let serialized: string;
        try {
          serialized = this._serialize(message);
        } catch (error) {
          owner.reject(error);
          this._reportError(error);
          return 'sent';
        }

        this.ws.send(serialized);
        return 'sent';
      }

      this.ws.send(this._serialize(message));
      return 'sent';
    }

    return this._state === 'connecting' || this._state === 'reconnecting' ? 'connecting' : 'closed';
  }

  /** @internal — call every handler listening for this event. */
  _dispatchMessage(event: string, payload: unknown): void {
    dispatchToHandlers(this._messageHandlers.get(event), this._logger, payload);
  }

  private _log(...args: unknown[]): void {
    this._logAt('log', ...args);
  }

  /** @internal — all log output goes through here; checks debug mode and adds the `[wskit]` prefix. */
  private _logAt(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
    if (!this._debug) return;

    console[level]('[wskit]', ...args);
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
  _reportServerError(error: WSKitError): void {
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
