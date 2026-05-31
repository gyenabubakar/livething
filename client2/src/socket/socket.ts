import { Block, CloseCodes, WSKitError } from '@wskit/core';
import { MessageBuffer } from '~/socket/buffer.ts';
import { Emitter } from '~/socket/emitter.ts';
import { Keepalive } from '~/socket/keepalive.ts';
import { Reconnection } from '~/socket/reconnection.ts';
import type { SendOptions } from '~/endpoint.ts';
import type { SocketConfig } from '~/internal/config.ts';
import type { InterceptFn, PrimitiveRuntime, WireMessage } from '~/internal/runtime.ts';
import type { ConnectionQuality, ConnectionState } from '~/types.ts';

// ---------------------------------------------------------------------------
// Close event
// ---------------------------------------------------------------------------

/** Describes a WebSocket close, passed to `onClose` handlers. */
export interface CloseEvent {
  /** WebSocket close code (e.g., 1000 for normal, 4001 for app-defined). */
  code: number;
  /** Optional close reason from the server. */
  reason: string;
  /** Whether the close handshake completed properly. */
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

// ---------------------------------------------------------------------------
// Default wire codec — `{ event, payload, __wskit? }` JSON
// ---------------------------------------------------------------------------

function defaultParse(raw: string): WireMessage | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.event !== 'string') return null;
  const message: WireMessage = { event: parsed.event, payload: parsed.payload };
  if (parsed.__wskit && typeof parsed.__wskit === 'object') {
    message.__wskit = parsed.__wskit as Record<string, unknown>;
  }
  return message;
}

/** Build a `WSKitError` from an `__error__` frame's `{ code, detail? }` payload. */
function toWSKitError(payload: unknown): WSKitError {
  const p = (payload ?? {}) as { code?: unknown; detail?: unknown };
  const code = typeof p.code === 'string' ? p.code : 'internal-error';
  return new WSKitError(code, p.detail);
}

function defaultSerialize(message: WireMessage): string {
  return message.__wskit
    ? JSON.stringify({ event: message.event, payload: message.payload, __wskit: message.__wskit })
    : JSON.stringify({ event: message.event, payload: message.payload });
}

// ---------------------------------------------------------------------------
// SocketImpl
// ---------------------------------------------------------------------------

/**
 * The core WebSocket client. Handles connection lifecycle, reconnection,
 * keepalive, buffering, the incoming/outgoing pipeline, and event dispatch.
 * Primitive APIs are merged onto the public type by `client()`.
 *
 * Developers never instantiate this directly — use `client()`.
 */
export class SocketImpl {
  /** The underlying native WebSocket instance. `null` when disconnected. */
  ws: WebSocket | null = null;

  /** The subprotocol selected by the server during handshake. `null` if none. */
  protocol: string | null = null;

  /** @internal */
  _config: SocketConfig;
  /** @internal */
  _primitives: readonly PrimitiveRuntime[];
  /** @internal */
  _state: ConnectionState = 'closed';
  /** @internal */
  _emitter = new Emitter<SocketEvents>();
  /** @internal */
  _debug = false;
  /** @internal */
  _isFirstConnect = true;
  /** @internal — tracks whether disconnect() was called to prevent reconnection */
  _intentionalClose = false;
  /** @internal — invalidates stale async URL/query resolutions after disconnect() */
  _connectAttemptId = 0;
  /** @internal */
  _reconnection: Reconnection;
  /** @internal */
  _keepalive: Keepalive;
  /** @internal */
  _buffer: MessageBuffer;
  /** @internal — lazy mode flags */
  _lazy: boolean;
  _lazyIdleTimer: ReturnType<typeof setTimeout> | null = null;
  _lazyConsumers = 0;
  /** @internal — direct dispatch map for on() handlers, keyed by event name */
  _messageHandlers = new Map<string, Set<(payload: unknown) => void>>();

  private readonly _parse: (raw: string) => WireMessage | null;
  private readonly _parseBinary: ((data: unknown) => WireMessage | null) | null;
  private readonly _serialize: (message: WireMessage) => string;
  private readonly _intercepts: readonly InterceptFn[];

  /** @internal */
  constructor(config: SocketConfig, primitives: readonly PrimitiveRuntime[]) {
    this._config = config;
    this._primitives = primitives;
    this._debug = config.debug ?? false;
    this._lazy = config.lazy ?? false;
    this._parse = config.parse ?? defaultParse;
    this._parseBinary = config.parseBinary ?? null;
    this._serialize = config.serialize ?? defaultSerialize;
    this._intercepts = config.intercepts ?? [];
    this._reconnection = new Reconnection(config, primitives);
    this._buffer = new MessageBuffer(config);
    this._keepalive = new Keepalive(config, {
      sendPing: () => {
        this._rawSend({ event: 'ping', payload: {} });
        this._log('ping sent');
      },
      forceClose: () => {
        this._log('missed pong threshold reached — force closing');
        this.ws?.close(CloseCodes.IDLE, 'missed pong');
      },
      onQualityChange: (quality, latency) => {
        this._emitter.emit('qualityChange', quality, latency);
      },
    });
  }

  // ── Connection lifecycle ─────────────────────────────────────

  /** Open the WebSocket connection. Safe to call multiple times. */
  connect(): void {
    if (this._state === 'open' || this._state === 'connecting') return;
    this._intentionalClose = false;
    this._openConnection();
  }

  /**
   * Close the connection and fully tear down the socket. Stops reconnection,
   * clears the buffer, rejects pending primitive promises, and resets state.
   * All `.on()` handlers remain registered — call `connect()` to reconnect.
   */
  disconnect(code = 1000, reason = ''): void {
    this._intentionalClose = true;
    this._connectAttemptId++;
    this._reconnection.stop();
    this._keepalive.stop();
    this._buffer.clear();
    this._clearLazyIdleTimer();
    this._lazyConsumers = 0;

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close(code, reason);
      this.ws = null;
    }
    this.protocol = null;

    for (const primitive of this._primitives) {
      primitive.onClose?.(code, reason);
    }

    this._setState('closed');
    this._emitter.emit('close', { code, reason, wasClean: true });
  }

  // ── State ────────────────────────────────────────────────────

  getState(): ConnectionState {
    return this._state;
  }

  getQuality(): ConnectionQuality {
    if (this._state !== 'open') return 'disconnected';
    return this._keepalive.getQuality();
  }

  getLatency(): number | null {
    return this._keepalive.getLatency();
  }

  /** Subscribe to state changes. The callback receives no arguments — read with `getState()`. */
  subscribe(callback: () => void): () => void {
    return this._emitter.on('state', callback);
  }

  // ── Events ───────────────────────────────────────────────────

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

  /**
   * Send raw binary data directly over the WebSocket. Bypasses the wire codec
   * and contract typing — you own the encoding. Returns `true` if sent.
   */
  sendBinary(data: ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob): boolean {
    if (this._state !== 'open' || !this.ws) return false;
    this.ws.send(data);
    return true;
  }

  // ── Lifecycle callbacks ──────────────────────────────────────

  onOpen(callback: () => void): () => void {
    return this._emitter.on('open', callback);
  }

  onReconnect(callback: () => void): () => void {
    return this._emitter.on('reconnect', callback);
  }

  onReconnectFailed(callback: () => void): () => void {
    return this._emitter.on('reconnectFailed', callback);
  }

  onClose(callback: (event: CloseEvent) => void): () => void {
    return this._emitter.on('close', callback);
  }

  /** Protocol errors (WebSocket-level failures). */
  onError(callback: (error: Event) => void): () => void;
  /** Application errors — typed `WSKitError`s from fire-and-forget incoming handlers. */
  onError(callback: (error: WSKitError) => void): () => void;
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- overload impl must accept both forms
  onError(callback: (error: any) => void): () => void {
    return this._emitter.on('error', callback);
  }

  onQualityChange(callback: (quality: ConnectionQuality, latency: number) => void): () => void {
    return this._emitter.on('qualityChange', callback);
  }

  // ── Debug ────────────────────────────────────────────────────

  setDebug(enabled: boolean): void {
    this._debug = enabled;
  }

  // ── Internal ─────────────────────────────────────────────────

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
      if (attemptId !== this._connectAttemptId) return; // cancelled by disconnect()

      let finalUrl = baseUrl;
      if (this._config.searchParams) {
        const params = await this._config.searchParams();
        if (attemptId !== this._connectAttemptId) return; // cancelled
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
        this._reconnection.reset();
        this._setState('open');

        const isReconnect = !this._isFirstConnect;
        this._isFirstConnect = false;

        this._keepalive.start();

        for (const primitive of this._primitives) {
          const messages = primitive.onOpen?.();
          if (messages) for (const msg of messages) this._rawSend(msg);
        }
        if (isReconnect) {
          for (const primitive of this._primitives) {
            const messages = primitive.onReconnect?.();
            if (messages) for (const msg of messages) this._rawSend(msg);
          }
        }

        this._buffer.flush(
          (message) => this._rawSend(message),
          () => this._log('buffer flush complete'),
        );

        this._emitter.emit('open');
        if (isReconnect) this._emitter.emit('reconnect');
      };

      ws.onclose = (event) => {
        if (attemptId !== this._connectAttemptId) return;
        this.ws = null;
        this.protocol = null;
        this._keepalive.stop();

        for (const primitive of this._primitives) {
          primitive.onClose?.(event.code, event.reason);
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

        if (!this._reconnection.shouldReconnect(event.code, event.reason)) {
          this._log(`reconnection suppressed (code ${event.code})`);
          this._setState('closed');
          return;
        }

        this._setState('reconnecting');
        this._log(`connection closed (code ${event.code}), reconnecting`);
        this._scheduleReconnect();
      };

      ws.onerror = (event) => {
        this._log('WebSocket error');
        this._emitter.emit('error', event);
      };

      ws.onmessage = (event) => this._handleMessage(event);
    } catch (error) {
      if (attemptId !== this._connectAttemptId) return;
      this._log('connection failed', error);
      this._setState('reconnecting');
      this._scheduleReconnect();
    }
  }

  private _handleMessage(event: MessageEvent): void {
    const raw = event.data;

    let parsed: WireMessage | null = null;
    if (typeof raw === 'string') {
      try {
        parsed = this._parse(raw);
      } catch {
        this._log('parse error — message dropped');
        return;
      }
    } else if (this._parseBinary) {
      try {
        parsed = this._parseBinary(raw);
      } catch {
        this._log('parseBinary error — message dropped');
        return;
      }
    }
    if (!parsed) return;

    // Keepalive — protocol ping/pong are answered/measured, never dispatched.
    if (parsed.event === 'pong') {
      this._log('pong received');
      this._keepalive.onPong();
      return;
    }
    if (parsed.event === 'ping') {
      this._log('ping received');
      this._rawSend({ event: 'pong', payload: {} });
      return;
    }

    // Primitive onIncoming hooks — returning null consumes the message.
    let message: WireMessage = parsed;
    for (const primitive of this._primitives) {
      if (!primitive.onIncoming) continue;
      const result = primitive.onIncoming(message);
      if (result === null) {
        this._log(`primitive '${primitive.id}' consumed '${parsed.event}'`);
        return;
      }
      message = result;
    }

    // Unclaimed error frames surface on onError as a WSKitError. Frames carrying
    // a routing marker (correlationId/ackId/streamId) are owned by their
    // primitive and were consumed above — only "unrecognized" errors reach here.
    if (message.event === '__error__') {
      this._emitter.emit('error', toWSKitError(message.payload));
      return;
    }

    // Intercept stage — runs last, can transform or drop (throw Block).
    if (this._intercepts.length) {
      for (const intercept of this._intercepts) {
        try {
          const result = intercept(message);
          if (result) message = result;
        } catch (error) {
          if (error === Block) {
            this._log(`intercept dropped '${message.event}'`);
          } else {
            this._log('intercept error — message dropped', error);
          }
          return;
        }
      }
    }

    this._log(`received '${message.event}'`, message.payload);
    this._dispatchMessage(message.event, message.payload);
  }

  private _scheduleReconnect(): void {
    this._reconnection.schedule(
      () => {
        this._log(`reconnect attempt ${this._reconnection.currentAttempt}`);
        this._openConnection();
      },
      () => {
        this._log('reconnection attempts exhausted');
        this._setState('closed');
        this._emitter.emit('reconnectFailed');
      },
    );
  }

  // ── Lazy mode ──────────────────────────────────────────────

  /** @internal — trigger connection if lazy and not connected. */
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

  // ── Send pipeline ──────────────────────────────────────────

  /** @internal — full outgoing pipeline: lazy connect → onOutgoing hooks → buffer fallback → wire. */
  _send(message: WireMessage, options?: SendOptions): boolean {
    this._ensureConnected();

    let msg: WireMessage | null = message;
    for (const primitive of this._primitives) {
      if (!primitive.onOutgoing) continue;
      msg = primitive.onOutgoing(msg!);
      if (msg === null) {
        this._log('send cancelled by primitive');
        return false;
      }
    }

    if (this._state !== 'open' || !this.ws) {
      if (this._buffer.enqueue(msg, options?.ttl)) {
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

  /** @internal — send a raw message, bypassing onOutgoing hooks (avoids loops). */
  _rawSend(message: WireMessage): void {
    if (!this.ws || this._state !== 'open') return;
    this.ws.send(this._serialize(message));
  }

  /** @internal — dispatch a parsed message to on() handlers by event name. */
  _dispatchMessage(event: string, payload: unknown): void {
    const handlers = this._messageHandlers.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      handler(payload);
    }
  }

  private _log(...args: unknown[]): void {
    if (!this._debug) return;
    console.log('[wskit]', ...args);
  }
}
