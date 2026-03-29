/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin type merging requires `any` */
import { MessageBuffer } from '@/socket/buffer.ts';
import { Emitter } from '@/socket/emitter.ts';
import { Keepalive } from '@/socket/keepalive.ts';
import { Platform } from '@/socket/platform.ts';
import { Reconnection } from '@/socket/reconnection.ts';
import type { SendOptions } from '@/endpoint.ts';
import type { MiddlewareFn, MiddlewareMessage } from '@/middleware.ts';
import type { FullSocketOptions } from '@/options.ts';
import type { Plugin } from '@/plugins/base.ts';
import type {
  ConnectionQuality,
  ConnectionState,
  IncomingOf,
  OutgoingOf,
  SocketContract,
} from '@/types.ts';

// ---------------------------------------------------------------------------
// Close event
// ---------------------------------------------------------------------------

/**
 * Describes a WebSocket close, passed to `onClose` handlers.
 *
 * - `code` — numeric close code (e.g., 1000 = normal, 1006 = abnormal, 4001 = app-defined)
 * - `reason` — optional string from the server (e.g., "token expired")
 * - `wasClean` — `true` if the close handshake completed properly
 */
export interface CloseEvent {
  /** WebSocket close code (e.g., 1000 for normal, 4001 for app-defined). */
  code: number;
  /** Optional close reason from the server. */
  reason: string;
  /** Whether the close handshake completed properly. */
  wasClean: boolean;
}

// ---------------------------------------------------------------------------
// Internal event map
// ---------------------------------------------------------------------------

type SocketEvents = {
  state: [state: ConnectionState];
  open: [];
  reconnect: [];
  reconnectFailed: [];
  close: [event: CloseEvent];
  error: [error: Event];
  qualityChange: [quality: ConnectionQuality, latency: number];
  message: [event: string, payload: unknown];
};

// ---------------------------------------------------------------------------
// Socket class
// ---------------------------------------------------------------------------

/** Default message parser: expects `{ event, payload }` JSON. */
function defaultParse(raw: string): { event: string; payload: unknown } | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.event !== 'string') return null;
  return { event: parsed.event, payload: parsed.payload };
}

/** Default message serializer: `{ event, payload }` as JSON. */
function defaultSerialize(event: string, payload: unknown): string {
  return JSON.stringify({ event, payload });
}

/**
 * The core WebSocket client. Handles connection lifecycle, reconnection,
 * keepalive, buffering, middleware, and event dispatch. Plugin APIs are
 * merged onto the type by `createSocket`.
 *
 * Developers never instantiate this directly — use `createSocket()`.
 */
export class Socket<TContract extends SocketContract> {
  /** The underlying native WebSocket instance. `null` when disconnected. */
  ws: WebSocket | null = null;

  /** The subprotocol selected by the server during handshake. `null` if none. */
  protocol: string | null = null;

  /** @internal */
  _url: string | (() => string | Promise<string>);
  /** @internal */
  _options: FullSocketOptions<TContract>;
  /** @internal */
  _plugins: readonly Plugin<any, any>[];
  /** @internal */
  _state: ConnectionState = 'closed';
  /** @internal */
  _emitter = new Emitter<SocketEvents>();
  /** @internal */
  _middleware: MiddlewareFn[] = [];
  /** @internal */
  _debug = false;
  /** @internal */
  _isFirstConnect = true;
  /** @internal — tracks whether disconnect() was called to prevent reconnection */
  _intentionalClose = false;
  /** @internal — cancel in-flight async URL/searchParams resolution */
  _connectAttemptId = 0;
  /** @internal */
  _reconnection: Reconnection;
  /** @internal */
  _keepalive: Keepalive;
  /** @internal */
  _buffer: MessageBuffer;
  /** @internal */
  _platform: Platform;
  /** @internal — whether platform listeners have been bound */
  _platformBound = false;
  /** @internal — inactivity disconnect timer */
  _inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  /** @internal */
  constructor(
    url: string | (() => string | Promise<string>),
    options: FullSocketOptions<TContract>,
    plugins: readonly Plugin<any, any>[],
  ) {
    this._url = url;
    this._options = options;
    this._plugins = plugins;
    this._debug = options.debug ?? false;
    this._reconnection = new Reconnection(options, plugins);
    this._buffer = new MessageBuffer(options);
    this._platform = new Platform(options);
    this._keepalive = new Keepalive(options, {
      sendPing: (message) => {
        if (!this.ws || this._state !== 'open') return;
        this.ws.send(message);
        this._log('ping sent');
      },
      forceClose: () => {
        this._log('missed pong threshold reached — force closing');
        if (this.ws) {
          this.ws.close(4000, 'missed pong');
        }
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
    this._bindPlatform();
    this._openConnection();
  }

  /**
   * Close the connection and fully tear down the socket.
   *
   * Stops reconnection, clears the message buffer, rejects all pending
   * `request()` and `send.withAck()` promises, and detaches platform listeners.
   * All `.on()` handlers remain registered — call `connect()` to reconnect.
   *
   * @param code WebSocket close code. Default: `1000` (normal closure).
   * @param reason Close reason string sent to the server. Default: `''`.
   */
  disconnect(code = 1000, reason = ''): void {
    this._intentionalClose = true;
    this._connectAttemptId++;
    this._reconnection.stop();
    this._keepalive.stop();
    this._buffer.clear();
    this._unbindPlatform();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close(code, reason);
      this.ws = null;
    }

    this.protocol = null;

    // Notify plugins
    for (const plugin of this._plugins) {
      plugin.onClose?.(code, reason);
    }

    this._setState('closed');
    this._emitter.emit('close', { code, reason, wasClean: true });
  }

  // ── State ────────────────────────────────────────────────────

  /** Current connection state. */
  getState(): ConnectionState {
    return this._state;
  }

  /** Current connection quality based on ping latency. */
  getQuality(): ConnectionQuality {
    if (this._state !== 'open') return 'disconnected';
    return this._keepalive.getQuality();
  }

  /** Last measured round-trip time in milliseconds, or `null` if unknown. */
  getLatency(): number | null {
    return this._keepalive.getLatency();
  }

  /**
   * Subscribe to state changes. The callback receives no arguments —
   * read the new state with `getState()`. Returns an unsubscribe function.
   */
  subscribe(callback: () => void): () => void {
    return this._emitter.on('state', callback);
  }

  // ── Event callbacks ──────────────────────────────────────────

  /** Listen for incoming events. Typed against `TContract['incoming']`. Returns an unsubscribe function. */
  on<K extends keyof IncomingOf<TContract> & string>(
    event: K,
    handler: (data: IncomingOf<TContract>[K]) => void,
  ): () => void {
    return this._emitter.on('message', (incomingEvent: string, payload: unknown) => {
      if (incomingEvent === event) {
        handler(payload as IncomingOf<TContract>[K]);
      }
    });
  }

  /** Send an outgoing event. Typed against `TContract['outgoing']`. Returns `true` if sent or buffered. */
  send<K extends keyof OutgoingOf<TContract> & string>(
    event: K,
    payload: OutgoingOf<TContract>[K],
    _options?: SendOptions,
  ): boolean {
    // Run through plugin onOutgoing hooks
    let msg: { event: string; payload: unknown } | null = { event, payload };
    for (const plugin of this._plugins) {
      if (!plugin.onOutgoing) continue;
      msg = plugin.onOutgoing(msg.event, msg.payload);
      if (msg === null) {
        this._log('send cancelled by plugin');
        return false;
      }
    }

    if (this._state !== 'open' || !this.ws) {
      if (this._buffer.enqueue(msg.event, msg.payload, _options?.ttl)) {
        this._log(`send('${msg.event}') buffered`);
        return true;
      }
      this._log(`send('${event}') dropped — not connected`);
      return false;
    }

    const serialize = this._options.serialize ?? defaultSerialize;
    this.ws.send(serialize(msg.event, msg.payload));
    this._log(`send('${msg.event}')`, msg.payload);
    return true;
  }

  /**
   * Send raw binary data directly over the WebSocket. Bypasses the `serialize`
   * option and contract typing — you handle the encoding.
   */
  sendBinary(data: ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob): void {
    if (this._state !== 'open' || !this.ws) return;
    this.ws.send(data);
  }

  // ── Lifecycle callbacks ──────────────────────────────────────

  /** Fires on every connection open (first connect and reconnects). */
  onOpen(callback: () => void): () => void {
    return this._emitter.on('open', callback);
  }

  /** Fires only on reconnects (not the first connect). */
  onReconnect(callback: () => void): () => void {
    return this._emitter.on('reconnect', callback);
  }

  /** Fires when all reconnection attempts are exhausted. */
  onReconnectFailed(callback: () => void): () => void {
    return this._emitter.on('reconnectFailed', callback);
  }

  /** Fires on every WebSocket close, including closes that trigger reconnection. */
  onClose(callback: (event: CloseEvent) => void): () => void {
    return this._emitter.on('close', callback);
  }

  /** Fires on WebSocket protocol errors. Not called on normal disconnection. */
  onError(callback: (error: Event) => void): () => void {
    return this._emitter.on('error', callback);
  }

  /**
   * Fires when connection quality transitions between tiers
   * (e.g., `'good'` → `'degraded'`). Callback receives the new quality
   * tier and the current round-trip latency in milliseconds.
   */
  onQualityChange(callback: (quality: ConnectionQuality, latency: number) => void): () => void {
    return this._emitter.on('qualityChange', callback);
  }

  // ── Middleware ────────────────────────────────────────────────

  /** Add incoming message middleware. Runs in registration order. */
  use(middleware: MiddlewareFn): void {
    this._middleware.push(middleware);
  }

  // ── Debug ────────────────────────────────────────────────────

  /** Enable or disable console debug logging for connection events, message flow, and plugin activity. */
  setDebug(enabled: boolean): void {
    this._debug = enabled;
  }

  // ── Internal ─────────────────────────────────────────────────

  /** @internal */
  private _setState(state: ConnectionState): void {
    if (this._state === state) return;
    const prev = this._state;
    this._state = state;
    this._log(`${prev} → ${state}`);
    this._emitter.emit('state', state);
  }

  /** @internal — resolve the URL (string or async function) and open the WebSocket */
  private async _openConnection(): Promise<void> {
    const attemptId = ++this._connectAttemptId;
    this._setState('connecting');

    try {
      // Resolve dynamic URL
      const baseUrl = typeof this._url === 'function' ? await this._url() : this._url;
      if (attemptId !== this._connectAttemptId) return; // cancelled by disconnect()

      // Append searchParams
      let finalUrl = baseUrl;
      if (this._options.searchParams) {
        const params = await this._options.searchParams();
        if (attemptId !== this._connectAttemptId) return; // cancelled
        const separator = baseUrl.includes('?') ? '&' : '?';
        finalUrl = `${baseUrl}${separator}${params.toString()}`;
      }

      this._log(`connecting to ${finalUrl}`);

      const ws = new WebSocket(finalUrl, this._options.protocols);
      if ('binaryType' in this._options && this._options.binaryType) {
        ws.binaryType = this._options.binaryType;
      }

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

        // Plugin onOpen hooks (fire on every open)
        for (const plugin of this._plugins) {
          const messages = plugin.onOpen?.();
          if (!messages) continue;
          for (const msg of messages) {
            this._rawSend(msg.event, msg.payload);
          }
        }

        // Plugin onReconnect hooks (fire only on reconnect)
        if (isReconnect) {
          for (const plugin of this._plugins) {
            const messages = plugin.onReconnect?.();
            if (!messages) continue;
            for (const msg of messages) {
              this._rawSend(msg.event, msg.payload);
            }
          }
        }

        // Flush buffered messages
        this._buffer.flush(
          (event, payload) => this._rawSend(event, payload),
          () => this._log('buffer flush complete'),
        );

        // Socket callbacks
        this._emitter.emit('open');
        if (isReconnect) {
          this._emitter.emit('reconnect');
        }
      };

      ws.onclose = (event) => {
        if (attemptId !== this._connectAttemptId) return;
        this.ws = null;
        this.protocol = null;
        this._keepalive.stop();

        // Notify plugins
        for (const plugin of this._plugins) {
          plugin.onClose?.(event.code, event.reason);
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

      ws.onmessage = (event) => {
        this._handleMessage(event);
      };
    } catch (error) {
      if (attemptId !== this._connectAttemptId) return;
      this._log('connection failed', error);
      this._setState('reconnecting');
      this._scheduleReconnect();
    }
  }

  /** @internal — handle an incoming WebSocket message through the full pipeline */
  private _handleMessage(event: MessageEvent): void {
    const raw = event.data;

    // Handle pong messages
    const pongMessage = this._options.pongMessage ?? 'pong';
    if (raw === pongMessage) {
      this._log('pong received');
      this._keepalive.onPong();
      return;
    }

    // Parse: text or binary
    let parsed: { event: string; payload: unknown } | null = null;

    if (typeof raw === 'string') {
      try {
        const parse = this._options.parse ?? defaultParse;
        parsed = parse(raw);
      } catch {
        this._log('parse error — message dropped');
        return;
      }
    } else if ('parseBinary' in this._options && this._options.parseBinary) {
      try {
        parsed = this._options.parseBinary(raw as any);
      } catch {
        this._log('parseBinary error — message dropped');
        return;
      }
    }

    if (!parsed) return;

    // Middleware chain
    let msg: MiddlewareMessage | null = parsed;
    for (const mw of this._middleware) {
      const result = mw(msg!);
      if (result === null) {
        this._log(`middleware dropped '${msg!.event}'`);
        return;
      }
      if (result !== undefined) {
        msg = result;
      }
    }

    // Plugin onIncoming hooks
    let pluginMsg: { event: string; payload: unknown } | null = msg;
    for (const plugin of this._plugins) {
      if (!plugin.onIncoming) continue;
      pluginMsg = plugin.onIncoming(pluginMsg!);
      if (pluginMsg === null) {
        this._log(`plugin '${plugin.id}' consumed '${msg!.event}'`);
        return;
      }
    }

    // Dispatch to on() handlers
    this._log(`received '${pluginMsg!.event}'`, pluginMsg!.payload);
    this._emitter.emit('message', pluginMsg!.event, pluginMsg!.payload);
  }

  /** @internal — schedule a reconnection attempt via the Reconnection module */
  private _scheduleReconnect(): void {
    const scheduled = this._reconnection.schedule(
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

    if (scheduled) {
      this._log(`reconnect scheduled (attempt ${this._reconnection.currentAttempt})`);
    }
  }

  /** @internal — bind platform listeners (network, visibility). Idempotent. */
  private _bindPlatform(): void {
    if (this._platformBound) return;
    this._platformBound = true;

    const inactiveTimeout = this._options.inactiveTimeout ?? 0;

    this._platform.bind({
      onNetworkOnline: () => {
        this._log('network online');
        if (this._state === 'reconnecting') {
          this._reconnection.resume(
            () => {
              this._log('reconnect attempt (network resumed)');
              this._openConnection();
            },
            () => {
              this._log('reconnection attempts exhausted');
              this._setState('closed');
              this._emitter.emit('reconnectFailed');
            },
          );
        }
      },
      onNetworkOffline: () => {
        this._log('network offline');
        if (this._state === 'reconnecting') {
          this._reconnection.pause();
        }
      },
      onActive: () => {
        this._log('app active');
        this._clearInactivityTimer();
        if (this._state === 'closed' && !this._intentionalClose) {
          this.connect();
        }
      },
      onInactive: () => {
        this._log('app inactive');
        if (inactiveTimeout > 0 && this._state === 'open') {
          this._inactivityTimer = setTimeout(() => {
            this._log('inactivity timeout — disconnecting');
            this._intentionalClose = false;
            this._keepalive.stop();
            this._reconnection.stop();
            if (this.ws) {
              this.ws.onopen = null;
              this.ws.onclose = null;
              this.ws.onerror = null;
              this.ws.onmessage = null;
              this.ws.close(1000, 'inactive');
              this.ws = null;
            }
            this.protocol = null;
            this._setState('closed');
            this._emitter.emit('close', { code: 1000, reason: 'inactive', wasClean: true });
          }, inactiveTimeout);
        }
      },
    });
  }

  /** @internal — unbind platform listeners and clear inactivity timer */
  private _unbindPlatform(): void {
    this._platform.unbind();
    this._platformBound = false;
    this._clearInactivityTimer();
  }

  /** @internal */
  private _clearInactivityTimer(): void {
    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
  }

  /** @internal — send a raw message, bypassing plugin onOutgoing hooks */
  _rawSend(event: string, payload: unknown): void {
    if (!this.ws || this._state !== 'open') return;
    const serialize = this._options.serialize ?? defaultSerialize;
    this.ws.send(serialize(event, payload));
  }

  /** @internal */
  private _log(...args: unknown[]): void {
    if (!this._debug) return;
    console.log('[better-ws]', ...args);
  }
}
