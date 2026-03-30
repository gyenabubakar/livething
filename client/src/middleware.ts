// ---------------------------------------------------------------------------
// Middleware — public API
// ---------------------------------------------------------------------------

/**
 * A deserialized incoming message. Middleware receives this and can
 * inspect, modify, or drop it before it reaches event handlers.
 */
export interface MiddlewareMessage {
  /** The event name (e.g., `'notification'`, `'chat-message'`). */
  event: string;
  /** The event payload, already parsed from the wire format. */
  payload: unknown;
}

/**
 * Middleware function. Called in registration order for each incoming message.
 *
 * - Return nothing (or `undefined`) → message passes through unchanged
 * - Return a new `{ event, payload }` → replaces the original message
 * - Return `null` → message is dropped, no handlers fire
 */
export type MiddlewareFn = (message: MiddlewareMessage) => MiddlewareMessage | null | void;
