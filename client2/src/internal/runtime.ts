// ---------------------------------------------------------------------------
// Internal runtime contracts shared by the socket and primitives
// ---------------------------------------------------------------------------

/**
 * A parsed wire message. `payload` is pure user data; all routing and
 * correlation metadata lives in the separate `__wskit` block.
 */
export interface WireMessage {
  event: string;
  payload: unknown;
  __wskit?: Record<string, unknown>;
}

/**
 * The runtime side of a primitive — produced by a primitive's `setup` and
 * attached to the socket by `client()`. Hooks fire in dependency-sorted order.
 */
export interface PrimitiveRuntime {
  /** Tag/id for debug logging. */
  id: string;
  /** Intercept incoming messages. Return the message (possibly modified), or `null` to consume it. */
  onIncoming?(message: WireMessage): WireMessage | null;
  /** Intercept outgoing messages. Return the message (possibly modified), or `null` to cancel the send. */
  onOutgoing?(message: WireMessage): WireMessage | null;
  /** Fires on every open (first connect and reconnects). Return messages to auto-send. */
  onOpen?(): WireMessage[] | null;
  /** Fires only on reconnects (not the first connect). Return messages to auto-send. */
  onReconnect?(): WireMessage[] | null;
  /** Fires when the connection closes. Use for cleanup (rejecting pending promises, clearing state). */
  onClose?(code: number, reason: string): void;
  /** Decide whether to reconnect. Return `false`/`true` for a definitive answer, `void` to defer. */
  shouldReconnect?(code: number, reason: string): boolean | void;
  /** Attach runtime methods to the socket object. */
  install?(socket: Record<string, unknown>): void;
}

/** Helpers handed to each primitive's `setup`, mirroring the socket internals. */
export interface PrimitiveHelpers {
  /** Send a raw message over the wire, bypassing `onOutgoing` hooks (avoids loops). */
  rawSend(message: WireMessage): void;
  /** Send a message through the full pipeline (onOutgoing → buffer fallback → wire). */
  send(message: WireMessage, options?: { ttl?: number }): boolean;
  /** Generate a unique id, shared monotonic counter across all primitives. */
  generateId(prefix?: string): string;
  /** Current connection state. */
  getState(): 'closed' | 'connecting' | 'open' | 'reconnecting';
  /** Trigger a lazy connection if applicable. */
  ensureConnected(): void;
  /** Increment the lazy consumer count and connect if needed. */
  lazyAcquire(): void;
  /** Decrement the lazy consumer count; start the idle timer at zero. */
  lazyRelease(): void;
}
