import { Block, WSKitConfigError } from '@wskit/core';
import { toWSKitError } from '~/internal/error-frame.ts';
import { Emitter } from '~/socket/emitter.ts';
import type { WSKitError } from '@wskit/core';
import type { SendOptions } from '~/endpoint.ts';
import type { SocketConfig } from '~/internal/config.ts';
import type {
  InterceptFn,
  PrimitiveHelpers,
  PrimitiveRuntime,
  WireMessage,
  WSKitEnvelope,
} from '~/internal/runtime.ts';
import type { ConnectionQuality, ConnectionState } from '~/types.ts';

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
  state: [state: ConnectionState];
  open: [];
  reconnect: [];
  reconnectFailed: [];
  close: [event: CloseEvent];
  error: [error: Event | WSKitError];
  qualityChange: [quality: ConnectionQuality, latency: number];
};

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

/**
 * The connection engine behind every socket. It handles the WebSocket itself,
 * the connection state, sending and receiving, lazy connecting, and quality.
 *
 * On purpose it contains no reconnection, keepalive, or buffering code — those
 * live in their own primitives and drive the engine through `_helpers()`. That
 * keeps unused features out of your bundle. You never build this yourself;
 * `client()` does and hands you back a typed `Socket`.
 */
export class WSKitSocket {
  /** The native WebSocket, or `null` when not connected. */
  ws: WebSocket | null = null;

  /** The subprotocol the server picked, or `null`. */
  protocol: string | null = null;

  /** @internal */
  _config: SocketConfig;
  /** @internal — set after construction, once primitives are built. */
  _primitives: readonly PrimitiveRuntime[] = [];
  /** @internal */
  _state: ConnectionState = 'closed';
  /** @internal */
  _emitter = new Emitter<SocketEvents>();
  /** @internal */
  _debug = false;
  /** @internal */
  _isFirstConnect = true;
  /** @internal — true once disconnect() is called, so we don't reconnect. */
  _intentionalClose = false;
  /** @internal — bumped to cancel a connect attempt that's still resolving its URL. */
  _connectAttemptId = 0;
  /** @internal */
  _lazy: boolean;
  _lazyIdleTimer: ReturnType<typeof setTimeout> | null = null;
  _lazyConsumers = 0;
  /** @internal — listeners by event name. */
  _messageHandlers = new Map<string, Set<(payload: unknown) => void>>();

  // Quality lives here because the getters are part of the public API, but the
  // values come from the keepalive primitive (if you added it).
  private _quality: ConnectionQuality = 'disconnected';
  private _latency: number | null = null;

  // Filled in by behavior primitives through _helpers().
  private _unexpectedCloseHandler: ((code: number, reason: string) => void) | null = null;
  private _pongHandlers: (() => void)[] = [];
  private _outgoingFallback: ((message: WireMessage, ttl?: number) => boolean) | null = null;
  private _signalHandlers = new Map<string, Set<(value: boolean) => void>>();
  private _idCounter = 0;

  /**
   * @internal — plugin APIs, built lazily on first `Plugin.use(socket)`. Keyed
   * by the plugin's `key`, then by `registrationId` (or `undefined` for a
   * singleton), so a repeatable plugin can hold several instances at once.
   */
  private _plugins = new Map<
    symbol,
    Map<string | undefined, { build: (socket: WSKitSocket) => unknown; api?: unknown }>
  >();

  private readonly _parse: (raw: string) => WireMessage | null;
  private readonly _parseBinary: ((data: unknown) => WireMessage | null) | null;
  private readonly _serialize: (message: WireMessage) => string;
  private readonly _intercepts: readonly InterceptFn[];

  /** @internal */
  constructor(config: SocketConfig) {
    this._config = config;
    this._debug = config.debug ?? false;
    this._lazy = config.lazy ?? false;
    this._parse = config.parse ?? defaultParse;
    this._parseBinary = config.parseBinary ?? null;
    this._serialize = config.serialize ?? defaultSerialize;
    this._intercepts = config.intercepts ?? [];
  }

  /** @internal — attach the primitive runtimes after they're set up. */
  _setPrimitives(primitives: readonly PrimitiveRuntime[]): void {
    this._primitives = primitives;
  }

  /** @internal — record how to build a plugin's API; the api is built on first use. */
  _registerPlugin(
    key: symbol,
    registrationId: string | undefined,
    build: (socket: WSKitSocket) => unknown,
  ): void {
    let byRegistration = this._plugins.get(key);
    if (!byRegistration) {
      byRegistration = new Map();
      this._plugins.set(key, byRegistration);
    }
    byRegistration.set(registrationId, { build });
  }

  /** @internal — get a plugin's API for this socket, building and caching it once. */
  _usePlugin(key: symbol, registrationId: string | undefined): unknown {
    const entry = this._plugins.get(key)?.get(registrationId);
    if (!entry) {
      throw new WSKitConfigError(
        registrationId === undefined
          ? '[wskit] this plugin is not registered on this socket. Pass it to client().'
          : `[wskit] no plugin instance with registrationId '${registrationId}' is registered on this socket.`,
      );
    }
    if (!('api' in entry)) entry.api = entry.build(this);
    return entry.api;
  }

  /** Open the connection. Calling it again while open or connecting does nothing. */
  connect(): void {
    if (this._state === 'open' || this._state === 'connecting') return;
    this._intentionalClose = false;
    this._openConnection();
  }

  /**
   * Close the connection on purpose. This is a full stop: no reconnection, the
   * buffer is cleared, and primitives clean up. Your `on()` handlers stay, so
   * `connect()` later picks up where you left off.
   */
  disconnect(code = 1000, reason = ''): void {
    this._intentionalClose = true;
    this._connectAttemptId++;
    this._clearLazyIdleTimer();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close(code, reason);
      this.ws = null;
    }
    this.protocol = null;
    this._quality = 'disconnected';

    // Primitives reject their pending work here, and each pending op releases
    // its own lazy hold. We do NOT zero `_lazyConsumers`: `on()` handlers stay
    // registered across a disconnect, so they remain real consumers — wiping the
    // count would make a later unsubscribe wrongly idle-close a socket that still
    // has live listeners (e.g. after a background-disconnect/reconnect).
    for (const primitive of this._primitives) {
      try {
        primitive.onClose?.(code, reason, true);
      } catch (error) {
        this._logAt('error', `primitive '${primitive.id}' onClose threw`, error);
      }
    }

    this._setState('closed');
    // Clear again in case a pending-op release above started an idle timer.
    this._clearLazyIdleTimer();
    this._emitter.emit('close', { code, reason, wasClean: true });
  }

  getState(): ConnectionState {
    return this._state;
  }

  getQuality(): ConnectionQuality {
    return this._state === 'open' ? this._quality : 'disconnected';
  }

  getLatency(): number | null {
    return this._latency;
  }

  /** Run a callback whenever the state changes. Read the new value with `getState()`. */
  subscribe(callback: () => void): () => void {
    return this._emitter.on('state', callback);
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    this._lazyAcquire();

    if (!this._messageHandlers.has(event)) {
      this._messageHandlers.set(event, new Set());
    }
    const set = this._messageHandlers.get(event)!;
    set.add(handler);

    return () => {
      set.delete(handler);
      if (set.size === 0) this._messageHandlers.delete(event);
      this._lazyRelease();
    };
  }

  send(event: string, payload: unknown, options?: SendOptions): boolean {
    return this._send({ event, payload }, options);
  }

  sendBinary(data: ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob): boolean {
    if (this._state !== 'open' || !this.ws) return false;
    this.ws.send(data);
    return true;
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

  /** A WebSocket-level error. */
  onError(callback: (error: Event) => void): () => void;
  /** A typed error the server sent that no request/stream claimed. */
  onError(callback: (error: WSKitError) => void): () => void;
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- the single body serves both overloads above
  onError(callback: (error: any) => void): () => void {
    return this._emitter.on('error', callback);
  }

  /** Runs when the quality tier changes. */
  onQualityChange(callback: (quality: ConnectionQuality, latency: number) => void): () => void {
    return this._emitter.on('qualityChange', callback);
  }

  setDebug(enabled: boolean): void {
    this._debug = enabled;
  }

  /** @internal — the set of things a primitive can ask the engine to do. */
  _helpers(): PrimitiveHelpers {
    return {
      config: this._config,

      log: {
        info: (...args) => this._logAt('log', ...args),
        warn: (...args) => this._logAt('warn', ...args),
        error: (...args) => this._logAt('error', ...args),
      },

      rawSend: (message) => this._rawSend(message),

      send: (message, options) => this._send(message, options),

      generateId: (prefix) => {
        const id = ++this._idCounter;
        return prefix ? `${prefix}-${id}` : `${id}`;
      },

      getState: () => this._state,

      ensureConnected: () => this._ensureConnected(),

      lazyAcquire: () => this._lazyAcquire(),

      lazyRelease: () => this._lazyRelease(),

      reopen: () => this._openConnection(),

      enterReconnecting: () => this._setState('reconnecting'),

      giveUp: () => this._setState('closed'),

      failReconnect: () => {
        this._setState('closed');
        this._emitter.emit('reconnectFailed');
      },

      forceClose: (code, reason) => this.ws?.close(code, reason),

      onUnexpectedClose: (handler) => {
        this._unexpectedCloseHandler = handler;
      },

      runShouldReconnect: (code, reason) => this._runShouldReconnect(code, reason),

      onPong: (handler) => this._pongHandlers.push(handler),

      reportQuality: (quality, latency) => {
        this._latency = latency;
        if (this._quality === quality) return;
        this._quality = quality;
        this._emitter.emit('qualityChange', quality, latency);
      },

      registerOutgoingFallback: (handler) => {
        this._outgoingFallback = handler;
      },

      emitSignal: (name, value) => {
        const set = this._signalHandlers.get(name);
        if (set) for (const handler of [...set]) handler(value);
      },

      onSignal: (name, handler) => {
        let set = this._signalHandlers.get(name);
        if (!set) {
          set = new Set();
          this._signalHandlers.set(name, set);
        }

        set.add(handler);

        return () => {
          set.delete(handler);
        };
      },

      disconnect: (code, reason) => this.disconnect(code, reason),

      connect: () => this.connect(),
    };
  }

  private _runShouldReconnect(code: number, reason: string): boolean | undefined {
    for (const primitive of this._primitives) {
      const result = primitive.shouldReconnect?.(code, reason);
      if (result === true || result === false) return result;
    }
    return undefined;
  }

  private _setState(state: ConnectionState): void {
    if (this._state === state) return;
    const prev = this._state;
    this._state = state;
    this._log(`${prev} → ${state}`);
    this._emitter.emit('state', state);
  }

  private async _openConnection(): Promise<void> {
    const attemptId = ++this._connectAttemptId;
    this._setState('connecting');

    try {
      const baseUrl =
        typeof this._config.url === 'function' ? await this._config.url() : this._config.url;
      if (attemptId !== this._connectAttemptId) return; // a disconnect() cancelled us mid-resolve

      let finalUrl = baseUrl;
      if (this._config.searchParams) {
        const params = await this._config.searchParams();
        if (attemptId !== this._connectAttemptId) return;
        const query = new URLSearchParams(params).toString();
        if (query) {
          const separator = baseUrl.includes('?') ? '&' : '?';
          finalUrl = `${baseUrl}${separator}${query}`;
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
        this._quality = 'excellent';
        this._latency = null;
        this._setState('open');

        const isReconnect = !this._isFirstConnect;
        this._isFirstConnect = false;

        // Primitives go first (replay, re-subscribe, …), then your callbacks.
        for (const primitive of this._primitives) {
          try {
            const messages = primitive.onOpen?.();
            if (messages) for (const msg of messages) this._rawSend(msg);
          } catch (error) {
            this._logAt('error', `primitive '${primitive.id}' onOpen threw`, error);
          }
        }

        if (isReconnect) {
          for (const primitive of this._primitives) {
            try {
              const messages = primitive.onReconnect?.();
              if (messages) for (const msg of messages) this._rawSend(msg);
            } catch (error) {
              this._logAt('error', `primitive '${primitive.id}' onReconnect threw`, error);
            }
          }
        }

        this._emitter.emit('open');
        if (isReconnect) this._emitter.emit('reconnect');
      };

      ws.onclose = (event) => {
        if (attemptId !== this._connectAttemptId) return;
        this.ws = null;
        this.protocol = null;
        this._quality = 'disconnected';

        for (const primitive of this._primitives) {
          try {
            primitive.onClose?.(event.code, event.reason, false);
          } catch (error) {
            this._logAt('error', `primitive '${primitive.id}' onClose threw`, error);
          }
        }

        this._emitter.emit('close', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });

        if (this._intentionalClose) {
          this._setState('closed');
          return;
        }

        // If reconnection is installed it decides what happens next; otherwise
        // an unexpected drop just leaves us closed.
        if (this._unexpectedCloseHandler) {
          this._unexpectedCloseHandler(event.code, event.reason);
        } else {
          this._setState('closed');
        }
      };

      ws.onerror = (event) => {
        this._log('WebSocket error');
        this._emitter.emit('error', event);
      };

      ws.onmessage = (event) => this._handleMessage(event);
    } catch (error) {
      if (attemptId !== this._connectAttemptId) return;

      this._log('connection failed', error);

      if (this._unexpectedCloseHandler) {
        this._unexpectedCloseHandler(1006, 'connection failed');
      } else {
        this._setState('closed');
      }
    }
  }

  private _handleMessage(event: MessageEvent): void {
    const raw = event.data;

    let parsed: WireMessage | null = null;
    if (typeof raw === 'string') {
      try {
        parsed = this._parse(raw);
      } catch {
        this._log('could not parse message — dropping it');
        return;
      }
    } else if (this._parseBinary) {
      try {
        parsed = this._parseBinary(raw);
      } catch {
        this._log('could not parse binary message — dropping it');
        return;
      }
    }
    if (!parsed) return;

    // Answer the server's pings and feed pongs to keepalive; never show these to handlers.
    if (parsed.event === 'pong') {
      this._log('pong received');
      for (const handler of this._pongHandlers) handler();
      return;
    }
    if (parsed.event === 'ping') {
      this._log('ping received');
      this._rawSend({ event: 'pong', payload: {} });
      return;
    }

    this._processIncoming(parsed);
  }

  /**
   * @internal — the pipeline a parsed message runs through: primitive
   * `onIncoming` hooks, then the error-frame check, then your intercepts, then
   * top-level dispatch. Split out from `_handleMessage` so testing's `inject()`
   * can push a message through the exact same path without a live socket.
   */
  _processIncoming(parsed: WireMessage): void {
    // Let primitives see it first; any of them can swallow it by returning null.
    let message: WireMessage = parsed;
    for (const primitive of this._primitives) {
      if (!primitive.onIncoming) continue;
      const result = primitive.onIncoming(message);
      if (result === null) {
        this._log(`primitive '${primitive.id}' handled '${parsed.event}'`);
        return;
      }
      message = result;
    }

    // An error frame nobody claimed becomes an onError call instead of a normal event.
    if (message.event === '__error__') {
      this._emitter.emit('error', toWSKitError(message.payload));
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
            this._log(`intercept dropped '${message.event}'`);
          } else {
            this._log('intercept threw — dropping the message', error);
          }
          return;
        }
      }
    }

    // Top-level handlers only see top-level events. Scope- or stream-tagged
    // frames are delivered by their primitives (channel/namespace handlers, the
    // stream iterator), so they don't double-fire here.
    const w = message.__wskit;
    if (w?.channel === undefined && w?.namespace === undefined && w?.streamId === undefined) {
      this._log(`received '${message.event}'`, message.payload);
      this._dispatchMessage(message.event, message.payload);
    }
  }

  /** @internal — open a lazy socket the first time something needs it. */
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
   * @internal — the full send path: open a lazy socket, let primitives adjust or
   * cancel the message, then either write it, hand it to the buffer fallback, or
   * drop it.
   */
  _send(message: WireMessage, options?: SendOptions): boolean {
    this._ensureConnected();

    let msg: WireMessage | null = message;
    for (const primitive of this._primitives) {
      if (!primitive.onOutgoing) continue;
      msg = primitive.onOutgoing(msg!);
      if (msg === null) {
        this._log('a primitive cancelled the send');
        return false;
      }
    }

    if (this._state !== 'open' || !this.ws) {
      if (this._outgoingFallback?.(msg, options?.ttl)) {
        this._log(`send('${msg.event}') buffered`);
        return true;
      }
      this._log(`send('${message.event}') dropped — not connected`);
      return false;
    }

    this.ws.send(this._serialize(msg));
    this._log(`send('${msg.event}')`, msg.payload);
    return true;
  }

  /** @internal — write a message straight to the wire, skipping outgoing hooks. */
  _rawSend(message: WireMessage): void {
    if (!this.ws || this._state !== 'open') return;
    this.ws.send(this._serialize(message));
  }

  /** @internal — call every handler listening for this event. */
  _dispatchMessage(event: string, payload: unknown): void {
    const handlers = this._messageHandlers.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      handler(payload);
    }
  }

  private _log(...args: unknown[]): void {
    this._logAt('log', ...args);
  }

  /** @internal — the one place the debug gate and `[wskit]` prefix live. */
  private _logAt(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
    if (!this._debug) return;
    console[level]('[wskit]', ...args);
  }
}
