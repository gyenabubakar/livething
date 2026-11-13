/** The name of a transport, as `socket.transport` reports it. */
export type TransportName = 'websocket';

/** How a transport reports what happens on its connection. */
interface TransportEvents {
  open(): void;
  /** A frame from the server: a string, or an `ArrayBuffer` for binary. */
  message(data: unknown): void;
  close(code: number, reason: string, wasClean: boolean): void;
  error(event: unknown): void;
}

/** What the socket kernel passes when it opens a transport. */
export interface TransportOpenOptions {
  url: string;
  protocols: string[] | undefined;
  /** Whether `binary()` is in use, so binary frames must arrive as `ArrayBuffer`. */
  binary: boolean;
  events: TransportEvents;
}

/** One open, or opening, connection. The kernel never asks which transport it is. */
export interface Transport {
  readonly name: TransportName;
  /** The subprotocol the server picked, or `''`. */
  readonly protocol: string;
  /** The native WebSocket, for `socket.ws`. Only the WebSocket transport has one. */
  readonly webSocket: WebSocket | null;
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
  /** @internal */
  open(options: TransportOpenOptions): Transport;
}
