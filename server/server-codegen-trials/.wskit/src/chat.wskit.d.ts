export {};

declare global {
  interface WskitServerRegistry {
    "chat":     {
      ctx: WskitChatCtx;
      outgoing:       {
        "message": { text: string };
        "alert": { level: 'info' | 'warn' };
      };
      incomingContexts: {
        "send-message": WskitServerRegistry["chat"]["ctx"];
      };
    };
  }

  interface WskitChatCtx {
    /** Unique ID for this connection. Store it when you need to target this client later. */
    readonly id: string;

    /** Per-connection metadata set during the upgrade step (auth, session info, etc). */
    readonly meta: Record<string, unknown>;

    /** Bytes still queued to be sent. Useful for detecting backpressure. */
    readonly bufferedAmount: number;

    /** Latest round-trip latency in ms. `null` until enough ping/pong data is collected. */
    readonly latency: number | null;

    /** Connection health derived from recent latency: < 50 ms excellent, 50–150 ms good, 150–500 ms degraded, > 500 ms poor. */
    readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';

    /** Current tags on this connection. Use `tag()` / `untag()` to modify. */
    readonly tags: readonly string[];

    /** Attach a tag so this connection can be targeted later via `sendTo()`. */
    tag(label: string): void;

    /** Remove a tag from this connection. */
    untag(label: string): void;

    /** Send a `message` event to the current connection. */
    send(event: "message", payload: { text: string }): void;

    /** Broadcast a `message` event to all other connections. */
    broadcast(event: "message", payload: { text: string }): void;

    /** Send a `alert` event to the current connection. */
    send(event: "alert", payload: { level: 'info' | 'warn' }): void;

    /** Broadcast a `alert` event to all other connections. */
    broadcast(event: "alert", payload: { level: 'info' | 'warn' }): void;

    /** Send a `message` event to every connection that currently has the given tag. */
    sendTo(tag: string, event: "message", payload: { text: string }): void;

    /** Send a `alert` event to every connection that currently has the given tag. */
    sendTo(tag: string, event: "alert", payload: { level: 'info' | 'warn' }): void;

    /** Confirm receipt of the current incoming message. Only available when `ack()` is registered. */
    ack(): void;
  }
}
