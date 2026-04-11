export {};

declare global {
  interface WskitServerRegistry {
    "all-primitives":     {
      ctx: WskitAllPrimitivesCtx;
      outgoing:       {
        "message": { text: string; room?: string };
        "alert": { level: 'info' | 'warn' | 'error' };
        "usage": { totalTokens: number };
      };
      namespaces: {
        "notifications":         {
          ctx: WskitAllPrimitivesCtxNotifications;
          outgoing:           {
            "notice": { id: string; text: string };
          };
        };
      };
      channels: {
        "general":         {
          ctx: WskitAllPrimitivesCtxGeneral;
          outgoing:           {
            "announcement": { text: string };
          };
        };
        "rooms":         {
          ctx: WskitAllPrimitivesCtxRooms;
          outgoing:           {
            "typing": { userId: string };
            "room-message": { text: string };
          };
        };
      };
      incomingContexts: {
        "send-message": WskitServerRegistry["all-primitives"]["ctx"];
        "dismiss-notice": WskitServerRegistry["all-primitives"]["namespaces"]["notifications"]["ctx"];
        "announce": WskitServerRegistry["all-primitives"]["channels"]["general"]["ctx"];
        "start-typing": WskitServerRegistry["all-primitives"]["channels"]["rooms"]["ctx"];
      };
      requestContexts: {
        "get-usage": WskitServerRegistry["all-primitives"]["ctx"];
        "get-notices": WskitServerRegistry["all-primitives"]["namespaces"]["notifications"]["ctx"];
        "get-room-members": WskitServerRegistry["all-primitives"]["channels"]["rooms"]["ctx"];
      };
      postInterceptContexts: {
        "start-typing": WskitServerRegistry["all-primitives"]["channels"]["rooms"]["ctx"];
      };
    };
  }

  interface WskitAllPrimitivesCtx {
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
    send(event: "message", payload: { text: string; room?: string }): void;

    /** Broadcast a `message` event to all other connections. */
    broadcast(event: "message", payload: { text: string; room?: string }): void;

    /** Send a `alert` event to the current connection. */
    send(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;

    /** Broadcast a `alert` event to all other connections. */
    broadcast(event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;

    /** Send a `usage` event to the current connection. */
    send(event: "usage", payload: { totalTokens: number }): void;

    /** Broadcast a `usage` event to all other connections. */
    broadcast(event: "usage", payload: { totalTokens: number }): void;

    /** Send a `message` event to every connection that currently has the given tag. */
    sendTo(tag: string, event: "message", payload: { text: string; room?: string }): void;

    /** Send a `alert` event to every connection that currently has the given tag. */
    sendTo(tag: string, event: "alert", payload: { level: 'info' | 'warn' | 'error' }): void;

    /** Send a `usage` event to every connection that currently has the given tag. */
    sendTo(tag: string, event: "usage", payload: { totalTokens: number }): void;

    /** Confirm receipt of the current incoming message. Only available when `ack()` is registered. */
    ack(): void;

    /** Send a `message` replay message directly with explicit wire metadata. */
    sendReplay(event: "message", payload: { text: string; room?: string }, meta: { seq: number; messageId: string }): void;

    /** Send a `alert` replay message directly with explicit wire metadata. */
    sendReplay(event: "alert", payload: { level: 'info' | 'warn' | 'error' }, meta: { seq: number; messageId: string }): void;

    /** Send a `usage` replay message directly with explicit wire metadata. */
    sendReplay(event: "usage", payload: { totalTokens: number }, meta: { seq: number; messageId: string }): void;

    /** Schedule the `cleanup-sessions` task to run at a specific time. */
    schedule(taskId: "cleanup-sessions", options: { time: number; data?: unknown }): void;

    /** Cancel a previously scheduled `cleanup-sessions` task. */
    cancelScheduled(taskId: "cleanup-sessions", filter?: unknown extends Record<string, unknown> ? Partial<unknown> : Record<string, unknown>): void;

    /** Schedule the `expire-hold` task to run at a specific time. */
    schedule(taskId: "expire-hold", options: { time: number; data?: { orderId: string } }): void;

    /** Cancel a previously scheduled `expire-hold` task. */
    cancelScheduled(taskId: "expire-hold", filter?: { orderId: string } extends Record<string, unknown> ? Partial<{ orderId: string }> : Record<string, unknown>): void;
  }

  interface WskitAllPrimitivesCtxNotifications extends WskitAllPrimitivesCtx {
    /** Scoped API for the `notifications` namespace. */
    readonly namespace: {
      /** Always `"notifications"` for this namespace. */
      readonly name: "notifications";

      /** Send a `notice` event scoped to this namespace. */
      send(event: "notice", payload: { id: string; text: string }): void;

      /** Broadcast a `notice` event scoped to this namespace. */
      broadcast(event: "notice", payload: { id: string; text: string }): void;
    };
  }

  interface WskitAllPrimitivesCtxGeneral extends WskitAllPrimitivesCtx {
    /** Scoped API for the `general` channel. Send and broadcast events within this channel. */
    readonly channel: {
      /** The concrete channel name matched at runtime. */
      readonly name: string;

      /** Send a `announcement` event scoped to this channel. */
      send(event: "announcement", payload: { text: string }): void;

      /** Broadcast a `announcement` event scoped to this channel. */
      broadcast(event: "announcement", payload: { text: string }): void;
    };
  }

  interface WskitAllPrimitivesCtxRooms extends WskitAllPrimitivesCtx {
    /** Scoped API for the `rooms` channel. Send and broadcast events within this channel. */
    readonly channel: {
      /** The concrete channel name matched at runtime. */
      readonly name: string;

      /** Send a `typing` event scoped to this channel. */
      send(event: "typing", payload: { userId: string }): void;

      /** Broadcast a `typing` event scoped to this channel. */
      broadcast(event: "typing", payload: { userId: string }): void;

      /** Send a `room-message` event scoped to this channel. */
      send(event: "room-message", payload: { text: string }): void;

      /** Broadcast a `room-message` event scoped to this channel. */
      broadcast(event: "room-message", payload: { text: string }): void;

      /** Send a `typing` replay message scoped to this channel. */
      sendReplay(event: "typing", payload: { userId: string }, meta: { seq: number; messageId: string }): void;

      /** Send a `room-message` replay message scoped to this channel. */
      sendReplay(event: "room-message", payload: { text: string }, meta: { seq: number; messageId: string }): void;
    };
  }
}
