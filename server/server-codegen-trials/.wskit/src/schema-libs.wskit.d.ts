export {};

declare global {
  interface WskitServerRegistry {
    "schema-libs":     {
      ctx: WskitSchemaLibsCtx;
      outgoing:       {
        "schema-message": { roomId: string; text: string };
        "typing-state": { roomId: string; userId: string };
      };
      incomingContexts: {
        "join-room": WskitServerRegistry["schema-libs"]["ctx"];
        "start-typing": WskitServerRegistry["schema-libs"]["ctx"];
      };
      requestContexts: {
        "get-history": WskitServerRegistry["schema-libs"]["ctx"];
      };
    };
  }

  interface WskitSchemaLibsCtx {
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

    /** Send a `schema-message` event to the current connection. */
    send(event: "schema-message", payload: { roomId: string; text: string }): void;

    /** Broadcast a `schema-message` event to all other connections. */
    broadcast(event: "schema-message", payload: { roomId: string; text: string }): void;

    /** Send a `typing-state` event to the current connection. */
    send(event: "typing-state", payload: { roomId: string; userId: string }): void;

    /** Broadcast a `typing-state` event to all other connections. */
    broadcast(event: "typing-state", payload: { roomId: string; userId: string }): void;

    /** Send a `schema-message` event to every connection that currently has the given tag. */
    sendTo(tag: string, event: "schema-message", payload: { roomId: string; text: string }): void;

    /** Send a `typing-state` event to every connection that currently has the given tag. */
    sendTo(tag: string, event: "typing-state", payload: { roomId: string; userId: string }): void;
  }
}
