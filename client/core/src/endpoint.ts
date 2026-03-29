// ---------------------------------------------------------------------------
// Endpoint interface
// ---------------------------------------------------------------------------
//
// The shared API surface between the socket and channel objects.
// `on()` is typed against incoming events, `send()` against outgoing.
// If a contract omits `incoming` or `outgoing`, the corresponding method
// does not exist at the type level.

// ---------------------------------------------------------------------------
// Send options
// ---------------------------------------------------------------------------

/** Options for `send()` — per-message TTL override. */
export interface SendOptions {
  /** Time-to-live in ms. Overrides the `bufferTTL` config for this message. */
  ttl?: number;
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

/**
 * The base Endpoint type, parameterized by the contract slice it operates on.
 *
 * - If `TIncoming` has keys → `on(event, handler)` exists, typed against those keys.
 * - If `TOutgoing` has keys → `send(event, payload)` exists, typed against those keys.
 * - If neither has keys → the endpoint has no methods (empty object).
 *
 * Plugins can extend the endpoint with additional methods (e.g., `request()`,
 * `send.withAck()`, `onStream()`) via the plugin type system.
 *
 * Type parameters:
 * - `TIncoming` — the incoming event map (event name → payload type)
 * - `TOutgoing` — the outgoing event map (event name → payload type)
 */
export type Endpoint<
  TIncoming extends object = {},
  TOutgoing extends object = {},
> = (keyof TIncoming extends never
  ? {}
  : {
      /**
       * Listen for an incoming event. Returns an unsubscribe function.
       *
       * ```ts
       * const unsub = socket.on('notification', (data) => { ... });
       * unsub(); // stop listening
       * ```
       */
      on<K extends keyof TIncoming & string>(
        event: K,
        handler: (data: TIncoming[K]) => void,
      ): () => void;
    }) &
  (keyof TOutgoing extends never
    ? {}
    : {
        /**
         * Send a message. Returns `true` if sent or buffered, `false` if dropped.
         *
         * A `true` return means "accepted," not "delivered." Use `send.withAck()`
         * for delivery confirmation.
         *
         * ```ts
         * socket.send('mark-read', { notificationId: '123' });
         * socket.send('typing', { channelId: '456' }, { ttl: 5_000 });
         * ```
         */
        send<K extends keyof TOutgoing & string>(
          event: K,
          payload: TOutgoing[K],
          options?: SendOptions,
        ): boolean;
      });
