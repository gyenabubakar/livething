/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * The result of running one SQL query through `ctx.sql.exec(...)`.
 *
 * Use `.toArray()` for multiple rows, `.one()` for a single row, or `.raw()`
 * when you want column arrays instead of named-key objects.
 *
 * ```ts
 * const rows = ctx.sql
 *   .exec<{ id: number; text: string }>('SELECT id, text FROM messages WHERE room = ?', roomId)
 *   .toArray();
 * const row = ctx.sql
 *   .exec<{ id: string }>('SELECT id FROM users WHERE id = ?', userId)
 *   .one();
 * ```
 */
export interface SqlResult<T = unknown> {
  /** Return every matching row as an array of the expected row shape. */
  toArray(): T[];

  /**
   * Return the matching row, or `null` if the query returned nothing.
   *
   * Throws if the query returned more than one row — `.one()` is for
   * single-row reads. If your query can match multiple rows and you only want
   * the first, add `LIMIT 1` to the SQL or use `.toArray()[0]` instead.
   */
  one(): T | null;

  /** Return every matching row as raw column arrays (no key names). */
  raw(): unknown[][];
}

/**
 * The SQL interface available as `ctx.sql`.
 *
 * This wraps the adapter's SQLite driver. Use `exec()` for individual queries
 * and `transaction()` when you need multiple queries to run atomically — if
 * anything inside the callback throws, the whole transaction is rolled back.
 *
 * ```ts
 * // Single query:
 * ctx.sql.exec('INSERT INTO events (type, data) VALUES (?, ?)', 'login', userId);
 *
 * // Atomic multi-step operation:
 * ctx.sql.transaction((tx) => {
 *   tx.exec('UPDATE wallets SET balance = balance - ? WHERE id = ?', amount, from);
 *   tx.exec('UPDATE wallets SET balance = balance + ? WHERE id = ?', amount, to);
 * });
 * ```
 */
export interface SQLProvider {
  /**
   * Run one SQL statement. Bind values with positional `?` placeholders.
   *
   * Pass a generic row type when you know the query's result shape. The generic
   * is a TypeScript hint only; wskit does not validate SQL rows at runtime.
   */
  exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow>;

  /**
   * Run multiple queries inside a single atomic transaction.
   *
   * If the callback throws, the transaction is rolled back and the error
   * propagates to the caller.
   */
  transaction<T>(
    fn: (tx: { exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> }) => T,
  ): T;
}

/**
 * A simple key-value store available as `ctx.kv`.
 *
 * Good for lightweight state that does not require relational queries —
 * session flags, rate-limit counters, ephemeral caches, etc.
 *
 * ```ts
 * await ctx.kv.set('user:' + userId + ':typing', true, { ttl: 5000 });
 * const isTyping = await ctx.kv.get('user:' + userId + ':typing');
 * ```
 */
export interface KVProvider {
  /** Read one value by key. Returns `undefined` when the key does not exist. */
  get(key: string): Promise<unknown>;

  /** Write one value. Optionally set a TTL in milliseconds after which the key expires. */
  set(key: string, value: unknown, options?: { ttl?: number }): Promise<void>;

  /** Remove one key. */
  delete(key: string): Promise<void>;

  /** List keys that start with the given prefix. */
  list(prefix?: string): Promise<string[]>;
}

/**
 * Combined storage surface available to handlers and lifecycle hooks.
 *
 * Adapters provide this — it bundles both SQL and key-value access in one
 * object so you only need to pass around one thing.
 *
 * @example
 * ```ts
 * const storage: StorageProvider = {
 *   sql,
 *   kv,
 * };
 * ```
 */
export interface StorageProvider {
  /** SQL database access for queries and transactions. */
  sql: SQLProvider;
  /** Key-value storage for lightweight state and caches. */
  kv: KVProvider;
}

/**
 * Timer and alarm APIs provided by the adapter.
 *
 * `setTimeout`/`clearTimeout` behave like their browser equivalents and are
 * available on all platforms. The alarm methods (`setAlarm`, `deleteAlarm`,
 * `getAlarm`) are only available on platforms that support durable alarms
 * (such as Cloudflare Durable Objects). Durable alarms survive hibernation
 * — in-memory timers do not.
 *
 * Prefer `ctx.schedule(...)` for most use cases — it is higher-level and
 * survives restarts. Use these methods only when you need low-level control.
 */
export interface TimerProvider {
  /** Set a durable alarm that fires at an absolute timestamp (ms since epoch). Platform-specific. */
  setAlarm?(timeMs: number): Promise<void>;
  /** Cancel the current durable alarm. */
  deleteAlarm?(): Promise<void>;
  /** Read the time of the current durable alarm, or `null` if none is set. */
  getAlarm?(): Promise<number | null>;
  /** Schedule a callback after a delay in milliseconds. Not durable — lost on restart. */
  setTimeout(callback: () => void, delayMs: number): unknown;
  /** Cancel a scheduled timeout before it fires. */
  clearTimeout(handle: unknown): void;
}

/**
 * Structured logger available as `ctx.log`.
 *
 * The adapter decides where output goes (stdout, a remote log service, etc.).
 * Always prefer structured log calls over `console.log` so log aggregators
 * can index the fields.
 *
 * ```ts
 * ctx.log.info('message received', { event: 'send-chat', userId: ctx.meta.userId });
 * ctx.log.error('payment failed', { orderId, reason: err.message });
 * ```
 */
export interface Logger {
  /** Write an informational log entry. */
  info(message: string, data?: Record<string, unknown>): void;
  /** Write a warning log entry for recoverable or suspicious behavior. */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Write an error log entry for failed operations or unexpected exceptions. */
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * An addressable handle to one connection — used by engine methods that act
 * on a specific socket (`channel.subscribe(ref)`, future cross-instance
 * routing). The value is opaque from the developer's view; the engine reads
 * the inner fields to decide whether the target is on this instance or
 * another one.
 *
 * Get a ref from `ConnectionInfo.ref()` (any snapshot) or `ctx.self` (the
 * current connection inside a connection handler).
 *
 * @example
 * ```ts
 * // Subscribe every member of "team-eng" to a new room
 * const members = ctx.getConnectionsByTag('team:eng');
 * const room = ctx.channels.get('eng-room');
 * for (const m of members) {
 *   await room.subscribe(m.ref());
 * }
 *
 * // Auto-join the current connection to a default room
 * await ctx.channels.get('lobby').subscribe(ctx.self);
 * ```
 */
export interface ConnectionRef {
  /** Brand tag so the type cannot be confused with a plain object. */
  readonly __wskit: 'connection-ref';
  /** Engine-generated id of the target connection. */
  readonly id: string;
  /**
   * Stable id of the engine instance that owns this connection. `undefined`
   * in single-instance setups — those refs always resolve locally. When a
   * broker is configured (future), this field carries the target instance
   * id and is the address the broker routes to.
   */
  readonly instance: string | undefined;
  /** Identity string the upgrade hook returned for the target connection. */
  readonly identity: string;
}

/**
 * A read-only snapshot of one live connection at a point in time.
 *
 * Returned by `ctx.getConnections()`, `ctx.getConnectionsByTag()`, and
 * `ctx.channels.members()`. The snapshot does not update — fetch it again
 * if you need fresh data.
 *
 * `Meta` matches the shape of the metadata you set during the upgrade step.
 */
export interface ConnectionInfo<Meta = Record<string, unknown>> {
  /** Unique connection identifier generated by the engine. */
  readonly id: string;
  /**
   * Identity string the `onUpgrade` hook returned for this connection — the
   * stable user-equivalent id the framework uses as the row key for any
   * per-user durable state.
   */
  readonly identity: string;
  /** Key-value metadata set during the upgrade step (e.g. userId, role). */
  readonly meta: Meta;
  /** Tags attached to this connection via `ctx.tag()`. */
  readonly tags: readonly string[];
  /** Channel names this connection is currently subscribed to. */
  readonly channels: readonly string[];
  /** Round-trip latency in milliseconds, measured by ping/pong. `null` if not yet measured. */
  readonly latency: number | null;
  /** Connection quality tier derived from the rolling latency average. */
  readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';
  /** Bytes waiting to be sent over the wire. High values mean the network is slower than the send rate. */
  readonly bufferedAmount: number;
  /**
   * Build a `ConnectionRef` for this connection — pass it to engine methods
   * that act on a specific socket (such as `channelHandle.subscribe(ref)`).
   */
  ref(): ConnectionRef;
}

/**
 * Options for `ctx.broadcast(...)`.
 *
 * `ctx.broadcast` always fans out to every connection on the server. To
 * fan out only to subscribers of a specific channel, resolve a channel
 * handle with `ctx.channels.get(...)` and use its `broadcast(...)` method
 * — that path filters by channel membership and respects family vs static
 * scope. Sending a top-level broadcast with a channel filter is not a
 * supported operation.
 */
export interface BroadcastOptions {
  /**
   * Whether to skip the calling connection. Defaults to `true` inside a
   * connection handler — pass `false` to include the sender as well.
   */
  readonly excludeSelf?: boolean;
}

/**
 * Send and broadcast helpers scoped to one namespace or channel.
 *
 * Available as `ctx.namespace` inside namespace handlers and `ctx.channel`
 * inside channel handlers. Both `send` and `broadcast` automatically scope
 * the outgoing event to the current namespace or channel name.
 */
export interface ScopeSendApi {
  /** The resolved name of this namespace or channel instance. */
  readonly name: string;
  /** Send an event only to the current connection, scoped to this namespace/channel. */
  send(event: string, payload: unknown): boolean;
  /** Broadcast an event to every connection in this namespace/channel. */
  broadcast(event: string, payload: unknown, options?: BroadcastOptions): void;
}

/**
 * Extended scope send API that includes replay support.
 *
 * `sendReplay` is only available when `replay()` is registered in the same
 * scope. In the broad runtime type it is optional because not every channel
 * context has replay enabled. The precise generated/app-facing types narrow
 * it to required only when replay is actually registered for that scope.
 */
export interface ReplayScopeSendApi extends ScopeSendApi {
  /**
   * Send a replayable event scoped to this namespace or channel.
   *
   * Provide replay wire metadata so reconnecting clients can request missed
   * messages and deduplicate anything they already received.
   */
  sendReplay?(
    event: string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string },
  ): void;
}

/**
 * A handle to one resolved channel, returned by `ctx.channel` (in-channel) and
 * by `ctx.channels.get(...)` (anywhere). Use it to send to the caller, broadcast
 * to subscribers, list members, or kick tagged connections out of this exact
 * channel scope.
 *
 * `TOutgoing` is typed to the events declared inside the channel's
 * sub-builder, so `send` and `broadcast` only accept those events. `Meta` matches
 * the per-connection metadata shape from your `.onUpgrade()`.
 */
export interface ChannelHandle<
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
  Meta = Record<string, unknown>,
> {
  /** The concrete channel name this handle targets. */
  readonly name: string;
  /**
   * The channel family key when this handle was resolved from a dynamic
   * family registered with `scope(key, pattern)`, or `null` when the handle
   * targets a static channel registered with a string name.
   */
  readonly scope: string | null;
  /** Send a channel-scoped event to the current connection. */
  send<E extends keyof TOutgoing & string>(event: E, payload: TOutgoing[E]): boolean;
  /**
   * Broadcast a channel-scoped event to subscribers of this exact channel scope.
   *
   * Excludes the calling connection by default. Pass `{ excludeSelf: false }`
   * to also deliver the event to the sender.
   */
  broadcast<E extends keyof TOutgoing & string>(
    event: E,
    payload: TOutgoing[E],
    options?: { excludeSelf?: boolean },
  ): void;
  /** List the connections currently subscribed to this exact channel scope. */
  members(): ConnectionInfo<Meta>[];
  /**
   * Subscribe a connection to this exact channel scope from server code,
   * without a client `_subscribe` frame. Runs the channel's `onBeforeSubscribe`
   * gate, commits the membership, emits `_subscribeOk { source: 'server' }` to
   * the target, fans out `_memberJoin` to existing members, and runs the
   * `onSubscribe` hook — exactly the same path a client-initiated subscribe
   * takes.
   *
   * If the connection is already a member of this scope, the call resolves
   * immediately as a no-op — no gate, no events. The mental model is "make
   * sure they are in", not "re-subscribe".
   *
   * `payload` feeds the channel's `onBeforeSubscribe` validator and gate. The
   * type is unknown at this level; channels that declared a validator get a
   * typed argument through the builder.
   *
   * The returned promise rejects if `onBeforeSubscribe` throws (the
   * subscription is not committed in that case).
   */
  subscribe(ref: ConnectionRef, payload?: unknown): Promise<void>;
  /**
   * Remove every connection that has the given tag from this exact channel
   * scope, sending each kicked connection a `_kicked` frame with the reason and
   * notifying remaining subscribers via `_memberLeave`.
   *
   * Awaits all `onUnsubscribe` hook completions; rejections from those hooks
   * propagate to the caller.
   */
  kick(tag: string, reason: string): Promise<void>;
}

/**
 * Look up a channel handle from any handler. Use the single-argument overload
 * for static channel names, and the two-argument overload for dynamic channel
 * families declared with `scope(key, pattern)`. The returned handle is bound to
 * the resolved scope so members and kicks never cross into a different family.
 *
 * Available as `ctx.channels` when at least one `channel()` is registered at
 * the top level. Inside a channel handler, prefer `ctx.channel` instead.
 */
export interface ChannelsManager<
  TStaticNames extends string = string,
  TFamilyKeys extends string = string,
  TOutgoingByKey extends Record<string, Record<string, unknown>> = Record<
    string,
    Record<string, unknown>
  >,
  Meta = Record<string, unknown>,
> {
  /** Resolve a static channel by its registered name. */
  get<K extends TStaticNames>(name: K): ChannelHandle<TOutgoingByKey[K], Meta>;
  /** Resolve a concrete channel inside a registered channel family. */
  get<K extends TFamilyKeys>(family: K, name: string): ChannelHandle<TOutgoingByKey[K], Meta>;
}

/**
 * The runtime **superset** of every field and method that may appear on the
 * `ctx` argument in a connection-scoped handler.
 *
 * Most users do not need to reference this type directly. What you actually get
 * as `ctx` inside an `incoming(...)` handler is a narrowed view that only
 * exposes the fields relevant to what you registered on the builder. This
 * interface lists **everything the engine might provide**; your handler type
 * trims it down.
 *
 * `ConnectionContext` is passed to handlers registered with: `incoming`,
 * `request`, `generate`, `onConnect`, `onDisconnect`, `onError`, `onBinary`,
 * and `onValidationError`.
 *
 * @template Env      Environment variables exposed by the adapter.
 * @template Meta     Per-connection metadata set in the upgrade step.
 * @template Platform The raw platform object (e.g. a Cloudflare DO stub).
 *
 * @example
 * ```ts
 * server('chat')
 *   .outgoing(Message)
 *   .incoming(Send, (ctx, payload) => {
 *     const delivered: boolean = ctx.send('message', { text: payload.text });
 *     ctx.broadcast('message', { text: payload.text });
 *     if (!delivered) ctx.log.warn('send buffer full', { id: ctx.id });
 *   });
 * ```
 *
 * Mental model, grouped by purpose:
 * - **identity** — `id`, `meta`, `tags`, `tag`, `untag`
 * - **messaging** — `send`, `broadcast`, `sendTo`, `sendToConnection`,
 *   `sendBinary`, `broadcastBinary`
 * - **scope helpers** — `namespace`, `channel`, `channels`
 * - **durability / platform** — `schedule`, `cancelScheduled`, `sql`, `kv`,
 *   `env`, `log`, `platform`, `waitUntil`
 */
export interface ConnectionContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  // Connection identity
  /** The unique ID for the current WebSocket connection. */
  id: string;

  /**
   * The stable identity string the `onUpgrade` hook returned for this
   * connection. Same person can have many connections (phone, laptop, etc.)
   * with different `id`s but the same `identity`.
   */
  identity: string;

  /**
   * A `ConnectionRef` for the current connection — pass it to engine methods
   * that act on a specific socket. Equivalent to calling `.ref()` on the
   * current connection's `ConnectionInfo`, but available directly here.
   */
  self: ConnectionRef;

  /** Metadata attached during the upgrade step (e.g. user ID, session token). */
  meta: Meta;

  /** Tags currently attached to this connection. */
  tags: readonly string[];

  /** Attach a tag to this connection so it can be targeted as a group later. */
  tag(label: string): void;

  /** Remove a tag from this connection. */
  untag(label: string): void;

  // Message delivery
  /** Send an event to the current connection only. Returns `false` if the send buffer is full. */
  send(event: string, payload: unknown): boolean;

  /**
   * Send an event to all live connections except the caller. Pass
   * `{ excludeSelf: false }` to include the calling connection as well.
   *
   * Treat data you broadcast as untrusted by the receiving clients. The
   * server-side schema validated the inbound payload, but receivers must
   * still escape the data before rendering it. See `SECURITY.md` for the full
   * boundary.
   */
  broadcast(event: string, payload: unknown, options?: BroadcastOptions): void;

  /** Send an event to every connection that currently has the given tag. */
  sendTo(tag: string, event: string, payload: unknown): void;

  /** Send an event to one specific connection by its ID. Returns `false` if the connection is gone. */
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;

  /** Send a raw binary frame to the current connection. */
  sendBinary(data: ArrayBuffer | ArrayBufferView): boolean;

  /** Broadcast a raw binary frame to all connections. */
  broadcastBinary(data: ArrayBuffer | ArrayBufferView, options?: { excludeSelf?: boolean }): void;

  /** Close the current WebSocket connection. */
  close(code?: number, reason?: string): void;

  // Connection snapshots
  /** Get a snapshot of every live connection at this moment. */
  getConnections(): ConnectionInfo<Meta>[];

  /** Get every connection that currently has the given tag. */
  getConnectionsByTag(tag: string): ConnectionInfo<Meta>[];

  /** The total number of live connections right now. */
  connectionCount: number;

  /** Bytes still queued to be sent to this connection. Useful for back-pressure detection. */
  bufferedAmount: number;

  /** Round-trip latency in milliseconds, or `null` until the first ping/pong completes. */
  latency: number | null;

  /** A simple health label derived from recent ping/pong measurements. */
  quality: 'excellent' | 'good' | 'degraded' | 'poor';

  /**
   * The WebSocket close code, present only in `onDisconnect` handlers
   * (and module `onDisconnect`). Common values: `1000` graceful close,
   * `1001` going-away during server shutdown, `1006` abnormal close
   * (network failure), `4xxx` application-defined (e.g. moderator kick).
   * Undefined in every other handler — `onConnect`, `incoming`, etc.
   */
  closeCode?: number;

  /**
   * The WebSocket close reason string, paired with `closeCode`. Present
   * only in `onDisconnect` handlers (and module `onDisconnect`). The
   * empty string when the close did not carry a reason.
   */
  closeReason?: string;

  // Scope-aware routing helpers
  /** Scoped send/broadcast when inside a namespace handler. */
  namespace?: ScopeSendApi;

  /** Scoped send/broadcast when inside a channel handler, with optional replay support. */
  channel?: ReplayScopeSendApi;

  /** Resolve a channel handle from any handler. Only present when channels are registered. */
  channels: ChannelsManager<string, string, Record<string, Record<string, unknown>>, Meta>;

  // Durable scheduling
  /** Queue a scheduled task to run at a specific absolute timestamp (ms since epoch). */
  schedule(taskId: string, options: { time: number; data?: unknown }): void;

  /** Cancel queued runs for a scheduled task. Pass a `filter` to cancel only matching runs. */
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;

  /** Set a low-level platform alarm. Prefer `ctx.schedule()` for most cases. */
  setAlarm(time: number): void;

  // Storage and platform services
  /** SQL storage access. */
  sql: SQLProvider;

  /** Key-value storage access. */
  kv: KVProvider;

  /** Environment variables provided by the adapter (e.g. secrets, feature flags). */
  env: Env;

  /** Structured logger. */
  log: Logger;

  /** Keep the platform runtime alive until the promise resolves, even after the handler returns. */
  waitUntil(promise: Promise<unknown>): void;

  /** Raw platform object from the adapter (Durable Object stub, etc.). */
  platform: Platform;
}

/**
 * The context passed to `onInit` handlers.
 *
 * `onInit` runs once during server startup, before any WebSocket connections
 * are accepted. Use it for one-time setup: seeding the database, warming
 * caches, or running migrations.
 *
 * This context has no connection-level APIs (`send`, `broadcast`, etc.)
 * because no clients are connected yet.
 */
export interface InitContext<Env = Record<string, unknown>, Platform = unknown> {
  /** SQL database access for queries, migrations, and transactions. */
  sql: SQLProvider;
  /** Key-value storage for simple get/set/delete operations. */
  kv: KVProvider;
  /** Environment variables provided by the hosting platform (e.g. Cloudflare bindings). */
  env: Env;
  /** Structured logger — writes to the platform's logging system. */
  log: Logger;
  /** The raw platform object from the adapter (e.g. DurableObjectState on Cloudflare). */
  platform: Platform;
}

/**
 * The context passed to `onShutdown` handlers.
 *
 * `onShutdown` runs when the server is shutting down. Connections that were
 * active before shutdown are still reachable at this point — you can use
 * `broadcast()` to send a final message or `closeAll()` to close them early.
 *
 * The engine will automatically close any remaining connections after all
 * `onShutdown` handlers finish, so calling `closeAll()` is optional.
 *
 * Mental model: this is the whole-server view. You are not inside one
 * connection, so there is no `send()` or `meta`, but you can still inspect
 * live connections, broadcast, and queue durable work.
 */
export interface ShutdownContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  // Connection management
  /** Close every live connection at once. */
  closeAll(code?: number, reason?: string): void;

  /**
   * Broadcast an event to every live connection. To target only members of
   * a specific channel, resolve the channel through your handler's typed
   * channel surface — the shutdown context does not filter by channel.
   */
  broadcast(event: string, payload: unknown): void;

  // Storage and durable work
  /** SQL database access for queries, migrations, and transactions. */
  sql: SQLProvider;

  /** Key-value storage for simple get/set/delete operations. */
  kv: KVProvider;

  /** Queue a scheduled task to run at a specific time (milliseconds since epoch). */
  schedule(taskId: string, options: { time: number; data?: unknown }): void;

  /** Cancel all pending runs of a scheduled task, optionally filtered by data fields. */
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;

  // Connection snapshots
  /** The total number of live WebSocket connections right now. */
  connectionCount: number;

  /** Get a snapshot of every live connection. */
  getConnections(): ConnectionInfo<Meta>[];

  /** Get every connection that currently has the given tag. */
  getConnectionsByTag(tag: string): ConnectionInfo<Meta>[];

  // Platform services
  /** Environment variables provided by the hosting platform (e.g. Cloudflare bindings). */
  env: Env;

  /** Structured logger — writes to the platform's logging system. */
  log: Logger;

  /** Keep the platform runtime alive until the promise resolves, even after the handler returns. */
  waitUntil(promise: Promise<unknown>): void;

  /** The raw platform object from the adapter (e.g. DurableObjectState on Cloudflare). */
  platform: Platform;
}

/**
 * The context passed to scheduled task handlers (registered with `scheduled()`).
 *
 * Scheduled tasks are not tied to any one client, so this context has no
 * single-connection `send()`. It can still broadcast to all connections,
 * target groups by tag, and access storage.
 *
 * Mental model: this looks like `ShutdownContext`, but it runs for one queued
 * job instance and receives its payload separately as the handler argument.
 */
export interface TaskContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  // Storage
  /** SQL database access for queries, migrations, and transactions. */
  sql: SQLProvider;

  /** Key-value storage for simple get/set/delete operations. */
  kv: KVProvider;

  // Message delivery
  /**
   * Broadcast an event to every live connection. The task context has no
   * channel filter — for channel-scoped broadcasts, resolve a channel
   * handle from a connection-scoped handler instead.
   */
  broadcast(event: string, payload: unknown): void;

  /** Send an event to every connection that has the given tag. */
  sendTo(tag: string, event: string, payload: unknown): void;

  /** Send an event to one specific connection by ID. Returns false if the connection doesn't exist. */
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;

  // Connection snapshots
  /** Get a snapshot of every live connection. */
  getConnections(): ConnectionInfo<Meta>[];

  /** Get every connection that currently has the given tag. */
  getConnectionsByTag(tag: string): ConnectionInfo<Meta>[];

  /** The total number of live WebSocket connections right now. */
  connectionCount: number;

  // Durable scheduling
  /** Queue a scheduled task to run at a specific time (milliseconds since epoch). */
  schedule(taskId: string, options: { time: number; data?: unknown }): void;

  /** Cancel all pending runs of a scheduled task, optionally filtered by data fields. */
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;

  // Platform services
  /** Environment variables provided by the hosting platform (e.g. Cloudflare bindings). */
  env: Env;

  /** Structured logger — writes to the platform's logging system. */
  log: Logger;

  /** Keep the platform runtime alive until the promise resolves, even after the handler returns. */
  waitUntil(promise: Promise<unknown>): void;

  /** The raw platform object from the adapter (e.g. DurableObjectState on Cloudflare). */
  platform: Platform;
}
