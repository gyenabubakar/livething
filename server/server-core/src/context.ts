/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * The result of running one SQL query through `ctx.sql.exec(...)`.
 *
 * Use `.toArray()` for multiple rows, `.one()` for a single row, or `.raw()`
 * when you want column arrays instead of named-key objects.
 *
 * ```ts
 * const rows = ctx.sql.exec('SELECT * FROM messages WHERE room = ?', roomId).toArray();
 * const row  = ctx.sql.exec('SELECT * FROM users WHERE id = ?', userId).one();
 * ```
 */
export interface SqlResult {
  /** Return every matching row as an array of key-value objects. */
  toArray(): Record<string, unknown>[];

  /** Return the first matching row, or `null` if the query returned nothing. */
  one(): Record<string, unknown> | null;

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
  /** Run one SQL statement. Bind values with positional `?` placeholders. */
  exec(query: string, ...params: unknown[]): SqlResult;

  /**
   * Run multiple queries inside a single atomic transaction.
   *
   * If the callback throws, the transaction is rolled back and the error
   * propagates to the caller.
   */
  transaction<T>(fn: (tx: { exec(query: string, ...params: unknown[]): SqlResult }) => T): T;
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
 */
export interface StorageProvider {
  sql: SQLProvider;
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
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
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
}

/**
 * Options for `ctx.broadcast(...)`.
 */
export interface BroadcastOptions {
  /** Only broadcast to connections subscribed to this channel. */
  readonly channel?: string;
  /** Skip sending to the connection that is calling broadcast. */
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
  broadcast(event: string, payload: unknown): void;
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
  sendReplay?(
    event: string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string },
  ): void;
}

/**
 * Manage channel membership from any handler context.
 *
 * Available as `ctx.channels` when at least one `channel()` is registered.
 *
 * `TChannelNames` is the union of registered channel name strings — when only
 * static channels are registered, typos in `name` / `channelName` are caught
 * at compile time. When dynamic channels exist the union includes `string & {}`
 * so any string is accepted but autocomplete still suggests known names.
 */
export interface ChannelManager<
  TChannelNames extends string = string,
  Meta = Record<string, unknown>,
> {
  /** Get every connection currently subscribed to the given channel. */
  members(name: TChannelNames): ConnectionInfo<Meta>[];

  /** Remove all connections with the given tag from a channel, with a reason string. */
  kick(channelName: TChannelNames, tag: string, reason: string): void;
}

/**
 * The context object passed to every connection-scoped handler.
 *
 * This is what you receive as `ctx` inside `incoming`, `request`, `generate`,
 * `onConnect`, `onDisconnect`, `onError`, `onBinary`, and `onValidationError`
 * handlers.
 *
 * The exact shape depends on which primitives you registered — the `server()`
 * builder narrows it automatically. For example, `ctx.ack()` only exists if you
 * registered `ack()`. Refer to `HandlerCtxFromState` in `scope-state.ts` for
 * how each primitive contributes to the ctx shape.
 *
 * `Env`      — the environment variables shape provided by the adapter
 * `Meta`     — the per-connection metadata set during the upgrade step
 * `Platform` — the raw platform object from the adapter (e.g. Durable Object stub)
 *
 * Mental model:
 * - identity: `id`, `meta`, `tags`
 * - messaging: `send`, `broadcast`, `sendTo`, `sendToConnection`
 * - scope helpers: `namespace`, `channel`, `channels`
 * - durable/platform services: `schedule`, `sql`, `kv`, `env`, `platform`
 */
export interface ConnectionContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  // Connection identity
  /** The unique ID for the current WebSocket connection. */
  id: string;

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

  /** Send an event to all live connections, optionally filtered by channel. */
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

  // Scope-aware routing helpers
  /** Scoped send/broadcast when inside a namespace handler. */
  namespace?: ScopeSendApi;

  /** Scoped send/broadcast when inside a channel handler, with optional replay support. */
  channel?: ReplayScopeSendApi;

  /** Manage channel membership from any handler. Only present when channels are registered. */
  channels: ChannelManager<string, Meta>;

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

  /** Broadcast an event to all connections, optionally filtered by channel. */
  broadcast(event: string, payload: unknown, options?: { channel?: string }): void;

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
  /** Broadcast an event to all connections, optionally filtered by channel. */
  broadcast(event: string, payload: unknown, options?: { channel?: string }): void;

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
