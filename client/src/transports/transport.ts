/** The name of a transport, as `socket.transport` reports it: a built-in one, or a custom one. */
export type TransportName = 'websocket' | 'http' | (string & {});

/** How a transport reports what happens on its connection. */
export interface TransportEvents {
  open(): void;
  /** A frame from the server: a string, or an `ArrayBuffer` for binary. */
  message(data: unknown): void;
  close(code: number, reason: string, wasClean: boolean): void;
  error(event: unknown): void;
  /**
   * The connection has proved it carries data both ways, so `reconnection()` may forget
   * its earlier failed tries. Only a transport whose `reportsStable` is `true` emits it.
   */
  stable(): void;
  /**
   * The connection opened but cannot carry data here, such as an `http()` POST that failed before
   * any POST worked. The socket skips this transport for a while. A close follows.
   */
  unusable(): void;
}

/** What the socket passes when it opens a transport. */
export interface TransportOpenOptions {
  url: string;
  protocols: string[] | undefined;
  /** The login token of this try, from the `token` option, or `null`. */
  token: string | null;
  /** Whether `binary()` is in use, so binary frames must arrive as `ArrayBuffer`. */
  binary: boolean;
  /** A warning for the developer, shown in debug mode. */
  warn(message: string): void;
  events: TransportEvents;
}

/** One open, or opening, connection. The socket never asks which transport it is. */
export interface Transport {
  readonly name: TransportName;
  /** The subprotocol the server picked, or `''`. */
  readonly protocol: string;
  /** The native WebSocket, for `socket.ws`. Only the WebSocket transport has one. */
  readonly webSocket: WebSocket | null;
  /**
   * `true` when the transport emits `stable` itself. Otherwise the connection counts as
   * stable as soon as it opens, because one connection carries both directions.
   */
  readonly reportsStable: boolean;
  isOpen(): boolean;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  /** Send a frame of the protocol itself, such as `ping` or `pong`. */
  sendControl(frame: 'ping' | 'pong'): void;
  /** The bytes queued and not yet sent, for `socket.drain()`. */
  bufferedAmount(): number;
  /** Close the connection. The `close` event still fires. */
  close(code?: number, reason?: string): void;
  /** Stop all events, then close the connection. */
  dispose(code?: number, reason?: string): void;
}

/**
 * A transport the client can connect with, listed in the `transports` option of
 * `connect()`. Each is a function, so a transport the app does not list is left out
 * of the bundle.
 */
export interface TransportFactory {
  readonly name: TransportName;
  /**
   * Starts a connection. The socket calls it once for each try. The transport may fire
   * events before `open` returns; the socket holds them and handles them in order once
   * it has the returned transport.
   */
  open(options: TransportOpenOptions): Transport;
}

/**
 * The URL with the scheme a transport needs. An app gives one URL, and each transport
 * accepts `ws`, `wss`, `http` and `https` for it.
 */
export function withScheme(url: string, secure: string, plain: string): string {
  return url.replace(/^(wss|https):/i, `${secure}:`).replace(/^(ws|http):/i, `${plain}:`);
}
