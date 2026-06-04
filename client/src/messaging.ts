/** Per-call options for `send()`. */
export interface SendOptions {
  /**
   * How long (ms) this message may sit in the buffer before it's dropped.
   * Overrides the `buffering` primitive's `ttl` for this one message.
   */
  ttl?: number;
}

/**
 * The shared shape of anything you can listen and send on — the socket itself,
 * and later namespaces and channels.
 *
 * `on()` only appears when the contract has `incoming` events, and `send()` only
 * when it has `outgoing` events. If a contract has neither, the messaging is
 * empty. That's why `socket.send(...)` is a compile error when you never
 * declared anything to send.
 */
export type Messaging<
  TIncoming extends object = {},
  TOutgoing extends object = {},
> = (keyof TIncoming extends never
  ? {}
  : {
      /** Listen for an incoming event. Call the returned function to stop listening. */
      on<K extends keyof TIncoming & string>(
        event: K,
        handler: (data: TIncoming[K]) => void,
      ): () => void;
    }) &
  (keyof TOutgoing extends never
    ? {}
    : {
        /**
         * Send a message. Returns `true` if it was sent or buffered, `false` if
         * dropped. `true` means "accepted," not "the server got it" — use
         * `sendWithAck()` if you need confirmation.
         */
        send<K extends keyof TOutgoing & string>(
          event: K,
          payload: TOutgoing[K],
          options?: SendOptions,
        ): boolean;
      });
