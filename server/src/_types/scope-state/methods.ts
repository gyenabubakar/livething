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
 * Type-level metadata recorded for each declared scheduled task.
 *
 * `hasData` controls whether `ctx.schedule(...)` accepts a `data` payload for
 * the task, and `data` carries the inferred payload type when present.
 */
export interface ScheduledTaskDefinition<TData = never, THasData extends boolean = false> {
  readonly hasData: THasData;
  readonly data: TData;
}

type ScheduleOptionsForTask<TTask extends ScheduledTaskDefinition<any, any>> =
  TTask extends ScheduledTaskDefinition<infer TData, true>
    ? undefined extends TData
      ? { time: number; data?: TData }
      : { time: number; data: TData }
    : { time: number };

/**
 * Untyped scheduling surface used when no tasks are known in the current
 * builder state.
 */
export interface GenericScheduleMethods {
  /** Enqueue a scheduled task by ID. */
  schedule(taskId: string, options: { time: number; data?: unknown }): void;
  /** Cancel scheduled runs for a task, optionally matching stored task data. */
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;
  /** Set a low-level platform alarm. Prefer `ctx.schedule(...)` for tasks. */
  setAlarm(time: number): void;
}

/**
 * Provides `ctx.schedule()`, `ctx.cancelScheduled()`, and `ctx.setAlarm()`.
 *
 * These are always available on connection handler contexts — they delegate
 * to the engine's scheduled-task infrastructure and the platform's alarm API.
 */
export interface ScheduleMethods<
  TScheduledTasks extends Record<string, ScheduledTaskDefinition<any, any>>,
> {
  /**
   * Enqueue a registered scheduled task.
   *
   * Tasks declared without `.data(...)` accept only `{ time }`. Tasks declared
   * with `.data(schema)` require a matching `data` payload unless the schema
   * itself allows `undefined`.
   */
  schedule<TTaskId extends keyof TScheduledTasks & string>(
    taskId: TTaskId,
    options: ScheduleOptionsForTask<TScheduledTasks[TTaskId]>,
  ): void;
  /** Cancel scheduled runs for a registered task, optionally matching stored task data. */
  cancelScheduled<TTaskId extends keyof TScheduledTasks & string>(
    taskId: TTaskId,
    filter?: Record<string, unknown>,
  ): void;
  /** Set a low-level platform alarm. Prefer `ctx.schedule(...)` for tasks. */
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
  /**
   * SQL database access for this handler.
   *
   * Use `ctx.sql.exec(...)` for one query and `ctx.sql.transaction(...)` when
   * several queries must commit or roll back together.
   */
  readonly sql: ConnectionContext['sql'];

  /**
   * Key-value storage for lightweight state.
   *
   * Useful for flags, counters, simple caches, and values that do not need a
   * relational SQL query.
   */
  readonly kv: ConnectionContext['kv'];

  /**
   * Structured logger provided by the adapter.
   *
   * Prefer `ctx.log.info/warn/error(...)` over `console.log` so adapters can
   * route and index log fields consistently.
   */
  readonly log: ConnectionContext['log'];

  /** Raw platform object provided by the adapter, such as a Cloudflare Durable Object state. */
  readonly platform: ConnectionContext['platform'];

  /**
   * Keep platform work alive after the handler returns.
   *
   * Pass background promises here for logging, persistence, or cleanup work
   * that should continue even after the current message handler finishes.
   */
  waitUntil: ConnectionContext['waitUntil'];

  /** Close the current WebSocket connection with an optional close code and reason. */
  close: ConnectionContext['close'];

  /** Get a point-in-time snapshot of every live connection. */
  getConnections: ConnectionContext['getConnections'];

  /** Get a point-in-time snapshot of live connections that have the given tag. */
  getConnectionsByTag: ConnectionContext['getConnectionsByTag'];

  /** The current number of live WebSocket connections. */
  readonly connectionCount: ConnectionContext['connectionCount'];

  /** Send a raw binary frame to the current connection. */
  sendBinary: ConnectionContext['sendBinary'];

  /** Broadcast a raw binary frame to live connections. */
  broadcastBinary: ConnectionContext['broadcastBinary'];

  /** Send an event to one specific connection ID. Returns `false` when it cannot be delivered. */
  sendToConnection: ConnectionContext['sendToConnection'];
}

/**
 * Provides typed `ctx.env` — the environment bindings from the platform adapter.
 *
 * When `server<TEnv>()` specifies a concrete env type, handler contexts expose
 * that type instead of `Record<string, unknown>`.
 */
export interface EnvMethods<TEnv extends object = Record<string, unknown>> {
  /** Environment bindings provided by the adapter, typed from `server<TEnv>(...)`. */
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
  /**
   * Namespace-scoped send helpers for the current handler.
   *
   * These helpers automatically target the namespace the handler belongs to,
   * so you do not have to include the namespace name in each send call.
   */
  readonly namespace: {
    /** The concrete namespace name for the current handler. */
    readonly name: string;
    /** Send a namespace-scoped event to the current connection. */
    send<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): boolean;
    /** Broadcast a namespace-scoped event to live connections in this namespace. */
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
  /**
   * Channel-scoped send helpers for the current handler.
   *
   * These helpers automatically target the concrete channel instance the
   * current handler belongs to.
   */
  readonly channel: {
    /** The concrete channel name for the current handler. */
    readonly name: string;
    /** Send a channel-scoped event to the current connection. */
    send<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): boolean;
    /** Broadcast a channel-scoped event to subscribed channel members. */
    broadcast<TEvent extends keyof TOutgoing & string>(
      event: TEvent,
      payload: TOutgoing[TEvent],
    ): void;
  } & (THasReplay extends true
    ? {
        /** Send a channel-scoped replayable event with explicit replay wire metadata. */
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
