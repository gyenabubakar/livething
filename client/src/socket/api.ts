import type { WSKitError } from '@wskit/core';
import type { Messaging } from '~/messaging.ts';
import type { CloseEvent } from '~/socket/socket.ts';
import type { ConnectionState, IncomingOf, OutgoingOf, SocketContract } from '~/types.ts';

/**
 * The connection methods every socket has, no matter the contract. The typed
 * `on()` / `send()` come from `Messaging` and are added in by `Socket` below.
 */
export interface SocketConnection {
  /** Open the connection. Safe to call more than once. */
  connect(): void;
  /** Close on purpose. Defaults to code 1000 and an empty reason. */
  disconnect(code?: number, reason?: string): void;

  /** The current connection state. */
  getState(): ConnectionState;

  /** Run a callback on every state change (read the value with `getState()`). */
  subscribe(callback: () => void): () => void;

  /** Runs on every open (first connect and reconnects). */
  onOpen(callback: () => void): () => void;
  /** Runs only on reconnects. */
  onReconnect(callback: () => void): () => void;
  /** Runs once when reconnection gives up. */
  onReconnectFailed(callback: () => void): () => void;
  /** Runs on every close. */
  onClose(callback: (event: CloseEvent) => void): () => void;
  /** Runs on a WebSocket-level error. */
  onError(callback: (error: Event) => void): () => void;
  /** Runs on a typed server error that no request or stream claimed. */
  onError(callback: (error: WSKitError) => void): () => void;

  /** Turn console logging on or off at runtime. */
  setDebug(enabled: boolean): void;

  /** The subprotocol the server picked, or `null`. */
  readonly protocol: string | null;
  /** The native WebSocket, or `null` when not connected. */
  readonly ws: WebSocket | null;
}

/**
 * The socket type you work with: the connection methods plus typed `on()` and
 * `send()` for your contract. Primitives add their own methods on top through
 * `client()`.
 */
export type Socket<TContract extends SocketContract = SocketContract> = SocketConnection &
  Messaging<IncomingOf<TContract> & object, OutgoingOf<TContract> & object>;
