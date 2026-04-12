/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * The result of running one SQL query through `ctx.sql.exec(...)`.
 *
 * Use `.toArray()` for multiple rows, `.one()` for a single row, or `.raw()`
 * when you want column arrays instead of objects.
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
 * and `transaction()` when you need multiple queries to run atomically.
 */
export interface SQLProvider {
  /** Run one SQL statement. Bind values with positional `?` placeholders. */
  exec(query: string, ...params: unknown[]): SqlResult;

  /**
   * Run multiple queries inside a single atomic transaction.
   *
   * If the callback throws, the transaction is rolled back.
   */
  transaction<T>(fn: (tx: { exec(query: string, ...params: unknown[]): SqlResult }) => T): T;
}

/**
 * A simple key-value store available as `ctx.kv`.
 *
 * Good for lightweight state that does not need relational queries.
 */
export interface KVProvider {
  /** Read one value by key. Returns `undefined` when the key does not exist. */
  get(key: string): Promise<unknown>;

  /** Write one value. Optionally set a TTL in milliseconds. */
  set(key: string, value: unknown, options?: { ttl?: number }): Promise<void>;

  /** Remove one key. */
  delete(key: string): Promise<void>;

  /** List keys that start with the given prefix. */
  list(prefix?: string): Promise<string[]>;
}

/**
 * Combined storage surface available to handlers and lifecycle hooks.
 *
 * Adapters provide this — it bundles both SQL and key-value access.
 */
export interface StorageProvider {
  sql: SQLProvider;
  kv: KVProvider;
}

/**
 * Timer and alarm APIs provided by the adapter.
 *
 * `setTimeout`/`clearTimeout` work like their browser equivalents. The alarm
 * methods are only available on platforms that support durable alarms (like
 * Cloudflare Durable Objects).
 */
export interface TimerProvider {
  /** Set a durable alarm that survives hibernation. Platform-specific. */
  setAlarm?(timeMs: number): Promise<void>;
  /** Cancel the current durable alarm. */
  deleteAlarm?(): Promise<void>;
  /** Read the current durable alarm time, or `null` if none is set. */
  getAlarm?(): Promise<number | null>;
  /** Schedule a callback to run after a delay (in-memory, not durable). */
  setTimeout(callback: () => void, delayMs: number): unknown;
  /** Cancel a previously scheduled timeout. */
  clearTimeout(handle: unknown): void;
}

/**
 * Structured logger available as `ctx.log`.
 *
 * The adapter decides where log output goes (console, remote service, etc.).
 */
export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * A read-only snapshot of one live connection.
 *
 * Returned by `ctx.getConnections()`, `ctx.getConnectionsByTag()`, and
 * `ctx.channels.members()`.
 */
export interface ConnectionInfo<Meta = Record<string, unknown>> {
  readonly id: string;
  readonly meta: Meta;
  readonly tags: readonly string[];
  readonly channels: readonly string[];
  readonly latency: number | null;
  readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';
  readonly bufferedAmount: number;
}

/**
 * Options for `ctx.broadcast(...)`.
 */
export interface BroadcastOptions {
  /** Only broadcast to connections in this channel. */
  readonly channel?: string;
  /** Skip the connection that is calling broadcast. */
  readonly excludeSelf?: boolean;
}

/**
 * Send/broadcast helpers scoped to one namespace or channel.
 *
 * Available as `ctx.namespace` or `ctx.channel` inside scoped handlers.
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
 * `sendReplay` is only available when `replay()` is registered in the scope.
 */
export interface ReplayScopeSendApi extends ScopeSendApi {
  // This stays optional in the broad runtime type because not every channel
  // context has replay enabled. The precise generated/app-facing types narrow
  // this to required only when replay() is actually registered for that scope.
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
 */
export interface ChannelManager<Meta = Record<string, unknown>> {
  /** Get every connection currently subscribed to a channel. */
  members(name: string): ConnectionInfo<Meta>[];

  /** Remove all connections with the given tag from a channel. */
  kick(channelName: string, tag: string, reason: string): void;
}

/**
 * The context object passed to every connection-scoped handler.
 *
 * This is what you receive as `ctx` inside `incoming`, `request`, `generate`,
 * `onConnect`, `onDisconnect`, `onError`, `onBinary`, and `onValidationError`
 * handlers. The exact shape depends on which primitives you registered —
 * `defineServer` narrows the type automatically.
 */
export interface ConnectionContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  /** The unique ID for the current websocket connection. */
  id: string;
  /** Metadata attached during the upgrade step (e.g. user ID, session). */
  meta: Meta;
  /** Tags currently attached to this connection. */
  tags: readonly string[];
  /** Attach a tag to this connection for group targeting. */
  tag(label: string): void;
  /** Remove a tag from this connection. */
  untag(label: string): void;

  /** Send an event to the current connection. */
  send(event: string, payload: unknown): boolean;
  /** Send an event to all connections, optionally filtered by channel. */
  broadcast(event: string, payload: unknown, options?: BroadcastOptions): void;
  /** Send an event to every connection with the given tag. */
  sendTo(tag: string, event: string, payload: unknown): void;
  /** Send an event to one specific connection by its ID. */
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;

  /** Send a binary frame to the current connection. */
  sendBinary(data: ArrayBuffer | ArrayBufferView): boolean;
  /** Send a binary frame to all connections. */
  broadcastBinary(data: ArrayBuffer | ArrayBufferView, options?: { excludeSelf?: boolean }): void;

  /** Close the current websocket connection. */
  close(code?: number, reason?: string): void;
  /** Get a snapshot of every live connection. */
  getConnections(): ConnectionInfo<Meta>[];
  /** Get every connection that has a specific tag. */
  getConnectionsByTag(tag: string): ConnectionInfo<Meta>[];
  /** The total number of live connections. */
  connectionCount: number;
  /** Bytes still queued to send to this connection. */
  bufferedAmount: number;
  /** Round-trip latency in milliseconds, or `null` until measured. */
  latency: number | null;
  /** A simple health label derived from latency measurements. */
  quality: 'excellent' | 'good' | 'degraded' | 'poor';

  /** Scoped send/broadcast when inside a namespace handler. */
  namespace?: ScopeSendApi;
  /** Scoped send/broadcast when inside a channel handler. */
  channel?: ReplayScopeSendApi;
  /** Manage channel membership from any handler. */
  channels: ChannelManager<Meta>;

  /** Queue a scheduled task to run at a specific time. */
  schedule(taskId: string, options: { time: number; data?: unknown }): void;
  /** Cancel queued runs for a scheduled task. */
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;
  /** Set a low-level platform alarm (prefer `schedule()` for most cases). */
  setAlarm(time: number): void;

  /** SQL storage access. */
  sql: SQLProvider;
  /** Key-value storage access. */
  kv: KVProvider;
  /** Environment variables provided by the adapter. */
  env: Env;
  /** Structured logger. */
  log: Logger;
  /** Let a background promise outlive the current callback. */
  waitUntil(promise: Promise<unknown>): void;
  /** Raw platform object from the adapter (Durable Object stub, etc.). */
  platform: Platform;
}

/**
 * The context passed to `onInit` handlers.
 *
 * This runs once during server startup, before any connections are accepted.
 * It has storage and environment access but no connection-level APIs.
 */
export interface InitContext<Env = Record<string, unknown>, Platform = unknown> {
  sql: SQLProvider;
  kv: KVProvider;
  env: Env;
  log: Logger;
  platform: Platform;
}

/**
 * The context passed to `onShutdown` handlers.
 *
 * This runs when the server is shutting down. All connections are still live
 * at this point — use `closeAll()` to close them or `broadcast()` to send
 * a final message.
 */
export interface ShutdownContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  /** Close every live connection at once. */
  closeAll(code?: number, reason?: string): void;
  /** Broadcast an event to all connections. */
  broadcast(event: string, payload: unknown, options?: { channel?: string }): void;
  sql: SQLProvider;
  kv: KVProvider;
  schedule(taskId: string, options: { time: number; data?: unknown }): void;
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;
  connectionCount: number;
  getConnections(): ConnectionInfo<Meta>[];
  getConnectionsByTag(tag: string): ConnectionInfo<Meta>[];
  env: Env;
  log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  platform: Platform;
}

/**
 * The context passed to scheduled task handlers.
 *
 * This has broadcast and storage access but no single-connection send —
 * scheduled tasks are not tied to one client.
 */
export interface TaskContext<
  Env = Record<string, unknown>,
  Meta = Record<string, unknown>,
  Platform = unknown,
> {
  sql: SQLProvider;
  kv: KVProvider;
  broadcast(event: string, payload: unknown, options?: { channel?: string }): void;
  sendTo(tag: string, event: string, payload: unknown): void;
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;
  getConnections(): ConnectionInfo<Meta>[];
  getConnectionsByTag(tag: string): ConnectionInfo<Meta>[];
  connectionCount: number;
  schedule(taskId: string, options: { time: number; data?: unknown }): void;
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;
  env: Env;
  log: Logger;
  waitUntil(promise: Promise<unknown>): void;
  platform: Platform;
}
