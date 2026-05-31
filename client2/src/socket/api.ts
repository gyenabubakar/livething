import type { WSKitError } from '@wskit/core';
import type { Endpoint } from '~/endpoint.ts';
import type { CloseEvent } from '~/socket/socket.ts';
import type {
  ConnectionQuality,
  ConnectionState,
  IncomingOf,
  OutgoingOf,
  SocketContract,
} from '~/types.ts';

/**
 * Connection-management API common to every socket, independent of the
 * contract. Contract-typed `on()` / `send()` come from `Endpoint` and are
 * intersected in by the public `Socket` type below.
 */
export interface SocketConnection {
  /** Open the WebSocket connection. Safe to call multiple times. */
  connect(): void;
  /** Close the connection and tear down. `code` defaults to 1000, `reason` to `''`. */
  disconnect(code?: number, reason?: string): void;

  /** Current connection state. */
  getState(): ConnectionState;
  /** Current connection quality based on ping latency. */
  getQuality(): ConnectionQuality;
  /** Last measured round-trip time in ms, or `null` if unknown. */
  getLatency(): number | null;

  /** Subscribe to state changes (callback receives no args — read with `getState()`). */
  subscribe(callback: () => void): () => void;

  /** Send raw binary data, bypassing the wire codec and contract typing. */
  sendBinary(data: ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob): boolean;

  /** Fires on every connection open (first connect and reconnects). */
  onOpen(callback: () => void): () => void;
  /** Fires only on reconnects (not the first connect). */
  onReconnect(callback: () => void): () => void;
  /** Fires once when all reconnection attempts are exhausted. */
  onReconnectFailed(callback: () => void): () => void;
  /** Fires on every WebSocket close, including closes that trigger reconnection. */
  onClose(callback: (event: CloseEvent) => void): () => void;
  /** Fires on WebSocket protocol errors (WebSocket-level failures). */
  onError(callback: (error: Event) => void): () => void;
  /** Fires on typed application errors (`WSKitError`) from incoming handlers. */
  onError(callback: (error: WSKitError) => void): () => void;
  /** Fires when connection quality transitions between tiers. */
  onQualityChange(callback: (quality: ConnectionQuality, latency: number) => void): () => void;

  /** Enable or disable console debug logging at runtime. */
  setDebug(enabled: boolean): void;

  /** The subprotocol the server selected during handshake, or `null`. */
  readonly protocol: string | null;
  /** The underlying native WebSocket instance, or `null` when disconnected. */
  readonly ws: WebSocket | null;
}

/**
 * The public socket type. Combines the connection API with contract-typed
 * `on()` / `send()`. Primitives intersect their own APIs on top via `client()`.
 */
export type Socket<TContract extends SocketContract = SocketContract> = SocketConnection &
  Endpoint<IncomingOf<TContract> & object, OutgoingOf<TContract> & object>;
