/* oxlint-disable @typescript-eslint/no-explicit-any */

import type { BroadcastOptions, ChannelManager, ConnectionContext } from '~/context.ts';

// ---------------------------------------------------------------------------
// Typed send / broadcast methods
// ---------------------------------------------------------------------------

/**
 * Type-safe `send` and `broadcast` methods for a handler ctx.
 *
 * Only events declared with `outgoing()` in the same scope are accepted.
 * Calling `ctx.send('unknown-event', ...)` is a type error.
 *
 * `TOutgoing` is the accumulated outgoing event map from `ScopeState.outgoing`.
 */
export interface SendMethods<TOutgoing extends Record<string, any>> {
  /**
   * Send an event to the current connection.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   *
   * Returns `false` if the send buffer was full and the frame was dropped;
   * `true` otherwise.
   */
  send<TEvent extends keyof TOutgoing & string>(event: TEvent, payload: TOutgoing[TEvent]): boolean;

  /**
   * Broadcast an event to all connections in the current scope.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   *
   * Pass `options.excludeSelf: true` to skip the caller, or
   * `options.channel` to restrict delivery to subscribers of a specific channel.
   */
  broadcast<TEvent extends keyof TOutgoing & string>(
    event: TEvent,
    payload: TOutgoing[TEvent],
    options?: BroadcastOptions,
  ): void;
}

/**
 * Type-safe `sendTo` method for a handler ctx.
 *
 * Only events declared with `outgoing()` in the same scope are accepted.
 */
export interface SendToMethods<TOutgoing extends Record<string, any>> {
  /**
   * Send an event to every connection that currently has the given tag.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   */
  sendTo<TEvent extends keyof TOutgoing & string>(
    tag: string,
    event: TEvent,
    payload: TOutgoing[TEvent],
  ): void;
}

/**
 * Untyped fallback `sendTo` for scopes that have no `outgoing()` declared.
 *
 * When no outgoing events are known, `sendTo` still exists but accepts any
 * string for the event name and `unknown` for the payload.
 */
export interface GenericSendToMethods {
  /**
   * Send an event to every connection that currently has the given tag.
   */
  sendTo(tag: string, event: string, payload: unknown): void;
}

/**
 * Provides `ctx.id` — the unique ID for the current WebSocket connection.
 */
export interface ConnectionIdentityMethods {
  /**
   * The unique ID for the current websocket connection.
   *
   * Useful when you want to persist a connection reference and target
   * this exact client again later (e.g. `ctx.sendToConnection(id, ...)`).
   */
  readonly id: ConnectionContext['id'];
}

/**
 * Provides `ctx.meta` — per-connection metadata set during the upgrade step.
 *
 * When `.onUpgrade()` returns `{ meta: { userId: string } }`, TypeScript
 * infers `TMeta` as `{ userId: string }` and all handler contexts get
 * `ctx.meta.userId: string` instead of `Record<string, unknown>`.
 */
export interface ConnectionMetaMethods<
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Per-connection metadata attached during the WebSocket upgrade step.
   *
   * This is where auth or session information usually lives. Handlers that
   * run after the upgrade can read it here.
   */
  readonly meta: TMeta;
}

/**
 * Provides `ctx.bufferedAmount` — bytes waiting to be sent on this connection.
 */
export interface BufferedAmountMethods {
  /**
   * The number of bytes still waiting to be sent on this connection.
   *
   * Useful for detecting back-pressure: if this is large, the client is not
   * keeping up and you should slow down or skip non-critical sends.
   */
  readonly bufferedAmount: ConnectionContext['bufferedAmount'];
}

/**
 * Provides `ctx.latency` — measured round-trip time for this connection.
 */
export interface LatencyMethods {
  /**
   * The latest measured round-trip latency for this connection in milliseconds.
   *
   * This is `null` until wskit has completed at least one ping/pong exchange.
   */
  readonly latency: ConnectionContext['latency'];
}

/**
 * Provides `ctx.quality` — a human-readable connection health label.
 */
export interface QualityMethods {
  /**
   * A simple health label derived from recent ping/pong latency measurements.
   *
   * Use this for easy quality checks. If you need exact numbers, use `latency`.
   */
  readonly quality: ConnectionContext['quality'];
}

/**
 * Provides `ctx.tags` — the current tag set for this connection.
 */
export interface ConnectionTagsMethods {
  /**
   * The current tags attached to this connection.
   *
   * Tags let you group connections and send events to all of them at once
   * with `ctx.sendTo(tag, event, payload)`.
   */
  readonly tags: ConnectionContext['tags'];
}

/**
 * Provides `ctx.tag(label)` — attach a tag to this connection.
 */
export interface TagMethods {
  /**
   * Attach a tag to the current connection.
   *
   * Tags let you target groups of related connections later with
   * `ctx.sendTo(tag, event, payload)`.
   */
  tag(label: string): ReturnType<ConnectionContext['tag']>;
}

/**
 * Provides `ctx.untag(label)` — remove a tag from this connection.
 */
export interface UntagMethods {
  /**
   * Remove a tag from the current connection.
   *
   * Call this when the connection should no longer be part of a group you
   * are targeting with `sendTo`.
   */
  untag(label: string): ReturnType<ConnectionContext['untag']>;
}

/**
 * Provides `ctx.ack()` — confirm receipt of the current message.
 *
 * Only present when `ack()` is registered in the top-level scope.
 */
export interface AckMethods {
  /**
   * Confirm receipt of the current incoming message.
   *
   * This is only available when `ack()` is registered at the top level.
   * Calling it sends a lightweight acknowledgement frame back to the client.
   */
  ack(): void;
}

/**
 * The wire metadata attached to every replay message.
 *
 * `seq`       — the sequence number for ordering on the client side
 * `messageId` — a unique ID for deduplication
 * `channel`   — optional channel scope the replay is pinned to
 */
export interface ReplayWire {
  readonly seq: number;
  readonly messageId: string;
  readonly channel?: string;
}

/**
 * Provides `ctx.sendReplay(...)` — send a message with explicit replay wire metadata.
 *
 * Only present when `replay()` is registered in this scope.
 */
export interface ReplayMethods<TOutgoing extends Record<string, any>> {
  /**
   * Send a message that the client can replay after reconnecting.
   *
   * Provide explicit wire metadata (`seq`, `messageId`, optional `channel`)
   * so the client can deduplicate and reorder messages correctly.
   */
  sendReplay<TEvent extends keyof TOutgoing & string>(
    event: TEvent,
    payload: TOutgoing[TEvent],
    wire: ReplayWire,
  ): void;
}

/**
 * Provides `ctx.schedule()`, `ctx.cancelScheduled()`, and `ctx.setAlarm()`.
 *
 * These are always available on connection handler contexts — they delegate
 * to the engine's scheduled-task infrastructure and the platform's alarm API.
 */
export interface ScheduleMethods<TScheduledTaskIds extends string = string> {
  schedule(taskId: TScheduledTaskIds, options: { time: number; data?: unknown }): void;
  cancelScheduled(taskId: TScheduledTaskIds, filter?: Record<string, unknown>): void;
  setAlarm(time: number): void;
}

/**
 * Runtime-provided context properties that don't depend on builder state.
 *
 * These are always available on every connection handler context. They come
 * from the adapter at runtime, not from builder method chaining, so they
 * don't need type-level tracking in `ScopeState`.
 */
export interface RuntimeContextMethods {
  readonly sql: ConnectionContext['sql'];
  readonly kv: ConnectionContext['kv'];
  readonly log: ConnectionContext['log'];
  readonly platform: ConnectionContext['platform'];
  waitUntil: ConnectionContext['waitUntil'];
  close: ConnectionContext['close'];
  getConnections: ConnectionContext['getConnections'];
  getConnectionsByTag: ConnectionContext['getConnectionsByTag'];
  readonly connectionCount: ConnectionContext['connectionCount'];
  sendBinary: ConnectionContext['sendBinary'];
  broadcastBinary: ConnectionContext['broadcastBinary'];
  sendToConnection: ConnectionContext['sendToConnection'];
}

/**
 * Provides typed `ctx.env` — the environment bindings from the platform adapter.
 *
 * When `server<TEnv>()` specifies a concrete env type, handler contexts expose
 * that type instead of `Record<string, unknown>`.
 */
export interface EnvMethods<TEnv extends object = Record<string, unknown>> {
  readonly env: TEnv;
}

/**
 * Provides `ctx.namespace` inside namespace-scoped handlers.
 *
 * When outgoing events are known, `send` and `broadcast` are typed to only
 * accept events declared inside the namespace.
 */
export interface NamespaceScopeMethods<
  TOutgoing extends Record<string, any> = Record<string, any>,
> {
  readonly namespace: {
    readonly name: string;
    send<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): boolean;
    broadcast<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): void;
  };
}

/**
 * Provides `ctx.channel` inside channel-scoped handlers.
 *
 * When outgoing events are known, `send` and `broadcast` are typed to only
 * accept events declared inside the channel.
 */
export interface ChannelScopeMethods<
  TOutgoing extends Record<string, any> = Record<string, any>,
  THasReplay extends boolean = false,
> {
  readonly channel: {
    readonly name: string;
    send<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): boolean;
    broadcast<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): void;
  } & (THasReplay extends true
    ? {
        sendReplay<TEvent extends keyof TOutgoing & string>(
          event: TEvent,
          payload: TOutgoing[TEvent],
          wire: ReplayWire,
        ): void;
      }
    : {});
}

/**
 * Provides `ctx.channels` — manage channel membership from any handler.
 *
 * When channel names are known (from `.channel()` calls), the `name` parameter
 * on `members()` and `kick()` is typed as the union of registered channel
 * names. Static channels produce exact string literals; dynamic channels
 * (via `scope()`) widen to `string & {}` so any string is accepted but
 * autocomplete still suggests known names.
 */
export interface ChannelsMethods<TChannelNames extends string = string> {
  /**
   * Manage channel membership from any handler — list members, kick
   * connections by tag. Available everywhere, not just inside channel-scoped
   * handlers.
   */
  readonly channels: ChannelManager<TChannelNames>;
}
