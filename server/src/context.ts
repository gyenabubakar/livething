/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { BackfillMessage } from './inbox/storage.ts';
import type { InterceptFrame } from './intercept/intercept.ts';
import type { LocalKey } from './local-key/local-key.ts';

type OptionsParameter = { ttl?: number };
type OptsParameter = { timeout?: number };
type WireParameter = {
  deliverySeq: number;
  messageId: string;
  channel?: string;
  channelFamily?: string | null;
};
type OptsParameter2 = { reason: string; revoke?: boolean };
type OptionsParameter3 = { time: number; data?: unknown };
type OptionsParameter4 = { time: number; data?: unknown };
type OptionsParameter5 = { time: number; data?: unknown };
type OptsParameter3 = { reason: string; revoke?: boolean };
type FilterParameter = { userId?: string };
type OptionsParameter6 = { time: number; data?: unknown };

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
 * The bind-parameter and payload ceilings of the SQL engine behind `ctx.sql`.
 *
 * Every SQL engine caps how many `?` placeholders one statement may carry, how
 * many bytes the statement text may be, and how many bytes a single bound
 * value (or returned column) may be. The caps differ wildly by engine — a
 * Cloudflare Durable Object allows 100 bound parameters per statement, while
 * `node:sqlite` allows 32,766. LiveThing does not pick a number for you: each
 * adapter states its engine's real numbers here, and code that builds
 * variable-length SQL (batched inserts, `WHERE id IN (...)`, and similar)
 * reads `limits` to stay under them instead of assuming one shared ceiling.
 *
 * Authoring a custom adapter? Find your engine's real numbers from its own
 * documentation — do not guess. See
 * [Custom Adapters](/server/adapters/custom-adapters) for where to look.
 */
export interface SqlLimits {
  /** The most `?` placeholders one statement may bind at once. */
  readonly maxBoundParams: number;

  /** The most bytes one statement's SQL text may be. */
  readonly maxStatementBytes: number;

  /**
   * The most bytes one stored string, one stored BLOB, or one whole table row
   * may be. A row of many mid-sized columns can exceed this even when no single
   * column does.
   *
   * This is separate from {@link maxStatementBytes}: a bound value travels
   * alongside the SQL text rather than inside it, so a value far larger than
   * the statement limit still binds fine.
   */
  readonly maxValueBytes: number;
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
   * is a TypeScript hint only; LiveThing does not validate SQL rows at runtime.
   */
  exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow>;

  /**
   * Run multiple queries inside a single atomic transaction.
   *
   * The callback must be synchronous. If it throws, the transaction is rolled
   * back and the error propagates to the caller. Run async work before or after
   * this callback, never inside it.
   */
  transaction<T>(
    fn: (tx: { exec<TRow = unknown>(query: string, ...params: unknown[]): SqlResult<TRow> }) => T,
  ): T;

  /** The bind-parameter and payload ceilings of the engine behind this provider. */
  readonly limits: SqlLimits;
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
  set(key: string, value: unknown, options?: OptionsParameter): Promise<void>;

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
 * Durable alarm APIs provided by the adapter. Every adapter provides this.
 *
 * Plain JavaScript timers (`setTimeout` / `clearTimeout`) come from the
 * runtime directly and are not part of this interface — this interface is
 * only the adapter's durable alarm API, which survives hibernation and
 * restarts.
 *
 * Prefer `ctx.schedule(...)` for most use cases — it is higher-level. Use
 * these methods only when you need low-level control.
 */
export interface TimerProvider {
  /** Set a durable alarm that fires at an absolute timestamp (ms since epoch). Platform-specific. */
  setAlarm(timeMs: number): Promise<void>;

  /** Cancel the current durable alarm. */
  deleteAlarm(): Promise<void>;

  /** Read the time of the current durable alarm, or `null` if none is set. */
  getAlarm(): Promise<number | null>;
}

/**
 * Async-context capability the adapter provides so the engine can tell which
 * connection's dispatch is currently running, even when handlers for different
 * connections interleave at `await` points.
 *
 * `AsyncLocalStorage` from `node:async_hooks` satisfies this interface
 * directly. Adapters provide a factory for creating one, and the engine
 * decides the store shape it wants to carry.
 */
export interface AsyncContext<TStore = unknown> {
  /** Run `callback` with `store` recorded as the active async state. */
  run<R>(store: TStore, callback: () => R): R;

  /** The active async state on the current call stack, or `undefined`. */
  getStore(): TStore | undefined;
}

/** Factory the adapter provides so the engine can create its own async context instance. */
export type AsyncContextFactory = <TStore>() => AsyncContext<TStore>;

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
 * Get a ref from `ConnectionInfo.ref()` (any snapshot) or `ctx.connection`
 * (the current connection inside a connection handler).
 *
 * @example
 * ```ts
 * // Subscribe every member of "team-eng" to a new room
 * const members = ctx.tags.ephemeral('team').ref('eng').connections();
 * const room = ctx.channels.get('eng-room');
 * for (const m of members) {
 *   await room.subscribe(m.ref());
 * }
 *
 * // Auto-join the current connection to a default room
 * await ctx.channels.get('lobby').subscribe(ctx.connection);
 * ```
 */
export interface ConnectionRef {
  /** Brand tag so the type cannot be confused with a plain object. */
  readonly __livething: 'connection-ref';

  /** Engine-generated id of the target connection. */
  readonly id: string;

  /**
   * Stable id of the engine instance that owns this connection. `undefined`
   * in single-instance setups — those refs always resolve locally. When a
   * broker is configured (future), this field carries the target instance
   * id and is the address the broker routes to.
   */
  readonly instance: string | undefined;

  /** User id the upgrade hook returned for the target connection. */
  readonly userId: string;
}

/**
 * Address for one user — the account a `ConnectionRef` belongs to. Built via `UserInfo.ref()`,
 * `UserHandle.ref()`, or `ctx.user.ref()`. Pass it to `ctx.users.get(...)`
 * or to fan-out targets that accept a user (such as `kick`).
 *
 * Different from `ConnectionRef`, which addresses one specific socket — a
 * `UserRef` addresses every live connection the user currently holds.
 */
export interface UserRef {
  /** Brand tag so the type cannot be confused with a plain object. */
  readonly __livething: 'user-ref';

  /** The user id — same value as `ConnectionRef.userId` / `ctx.user.id`. */
  readonly id: string;

  /**
   * Stable id of the engine instance that owns this reference. `undefined`
   * in single-instance setups. See `ConnectionRef.instance` for the broker
   * routing behavior this mirrors.
   */
  readonly instance: string | undefined;
}

/**
 * Address for a group of connections matching a single `(kind, group, key)`
 * tuple. Built via `ctx.tags.<kind>(group).ref(key)` or by reading
 * `ConnectionInfo.tags`. Pass it to fan-out APIs like `channelHandle.kick`.
 *
 * Different from `ConnectionRef`, which addresses one specific socket.
 * `TagRef` is a label, not an identity — many connections can match it.
 */
export interface TagRef {
  /** Brand tag so the type cannot be confused with a plain object. */
  readonly __livething: 'tag-ref';

  /** Which kind of group the tag belongs to. */
  readonly kind: 'ephemeral' | 'persistent';

  /** Group name as declared in the contract's tagGroups config. */
  readonly group: string;

  /** Key inside the group. Any non-empty string the dev chose. */
  readonly key: string;
}

/**
 * A read-only snapshot of one live connection at a point in time.
 *
 * Returned by `ctx.connections.all()`, `channelHandle.members()`, and the
 * tag-group reads on `ctx.tags`. The snapshot does not update — fetch it
 * again if you need fresh data.
 *
 * `Meta` matches the shape of the metadata you set during the upgrade step.
 */
export interface ConnectionInfo<Meta = Record<string, unknown>> {
  /** Unique connection identifier generated by the engine. */
  readonly id: string;

  /**
   * User id the `onUpgrade` hook returned for this connection — the stable
   * id the framework uses as the row key for any per-user durable state.
   * An anonymous connection — one whose upgrade returned no user id — has no
   * user identity, and this is an empty string. Address such a connection by
   * its `ConnectionRef` instead.
   */
  readonly userId: string;

  /** Key-value metadata set during the upgrade step (e.g. role, display name). */
  readonly meta: Meta;

  /**
   * Tag refs currently attached to this connection. Each ref carries the
   * `(kind, group, key)` triple from the contract's `tagGroups` declaration.
   * Empty when the contract declares no tag groups.
   */
  readonly tags: readonly TagRef[];

  /** Channel names this connection is currently subscribed to. */
  readonly channels: readonly string[];

  /** Round-trip latency in milliseconds, measured by ping/pong. `null` if not yet measured. */
  readonly latency: number | null;

  /** Connection quality tier derived from the rolling latency average. `null` when hibernation is enabled (no server-side ping is sent). */
  readonly quality: 'excellent' | 'good' | 'degraded' | 'poor' | null;

  /** Bytes waiting to be sent over the wire. High values mean the network is slower than the send rate. */
  readonly bufferedAmount: number;

  /**
   * This connection's last-seen timestamp (ms), filled only when the
   * `lastSeen()` capability is listed; `null` when it has never been stamped.
   * The field is optional on every server: without `lastSeen()` it is always
   * `undefined`.
   */
  readonly lastSeen?: number | null;

  /**
   * Build a `ConnectionRef` for this connection — pass it to engine methods
   * that act on a specific socket (such as `channelHandle.subscribe(ref)`).
   */
  ref(): ConnectionRef;
}

/**
 * A handle to one specific connection, addressed by its `ConnectionRef`.
 * Returned by `ctx.connections.get(ref)`. Use it to send directly to, or close,
 * that socket.
 *
 * Get a ref from `ConnectionInfo.ref()`, `ctx.connection`, or any connection snapshot.
 */
export interface ConnectionHandle {
  /**
   * Send an event to this connection only. Returns `false` when the connection
   * is no longer live on this instance (its socket is gone).
   */
  send(event: string, payload: unknown): boolean;

  /** Close this connection only. No-op when the connection is no longer live. */
  close(code?: number, reason?: string): void;
}

/**
 * Reach any specific connection by ref, or list every live connection.
 * Available as `ctx.connections`.
 *
 * @example
 * ```ts
 * const target = ctx.connections.get(ref);
 * target.send('notice', { text: 'hello' });
 *
 * const everyone = ctx.connections.all();
 * ```
 */
export interface ConnectionsManager<Meta = Record<string, unknown>> {
  /**
   * Address one specific connection by ref. Returns a handle whose `send`
   * delivers only to that socket. Get a ref from `ctx.connection`, a
   * connection snapshot's `ref()`, or any `ConnectionRef` you hold.
   */
  get(ref: ConnectionRef): ConnectionHandle;

  /** Get a snapshot of every live connection at this moment. */
  all(): ConnectionInfo<Meta>[];
}

/**
 * A read-only snapshot of one user at a point in time — the account that owns
 * zero or more live connections.
 *
 * Returned by `UserHandle.info()`. Unlike `ConnectionInfo`, there is no flat
 * `.meta` here: metadata lives per connection, since the same user can have
 * different meta on different sockets (different device, different session).
 */
export interface UserInfo<Meta = Record<string, unknown>> {
  /** The user id. */
  readonly id: string;

  /** Whether this user has at least one live connection right now. */
  readonly online: boolean;

  /** Snapshot of this user's live connections. */
  connections(): ConnectionInfo<Meta>[];

  /** Union of channel names across this user's live connections. */
  readonly channels: readonly string[];

  /** Union of tag refs across this user's live connections. */
  readonly tags: readonly TagRef[];

  /**
   * This user's last-seen timestamp (ms), filled only when the `lastSeen()`
   * capability is listed; `null` when it has never been stamped. The field is
   * optional on every server: without `lastSeen()` it is always `undefined`.
   */
  readonly lastSeen?: number | null;

  /** Build a `UserRef` for this user — pass it to engine methods that act on the whole user (such as `kick`). */
  ref(): UserRef;
}

/**
 * A handle to one user, addressed by user id. Returned by `ctx.users.get(id)`;
 * the current connection's own user handle is `ctx.user`.
 *
 * Unlike `ConnectionHandle` (one socket), `UserHandle` acts on every live
 * connection the user currently holds — the user-level actions that have no
 * terse top-level verb.
 */
export interface UserHandle<Meta = Record<string, unknown>> {
  /** The user id. */
  readonly id: string;

  /** Build a `UserRef` for this user. */
  ref(): UserRef;

  /**
   * Broadcast an event to every live connection this user holds.
   * Returns the number of sockets the event was delivered to.
   */
  broadcast(event: string, payload: unknown): number;

  /**
   * Ask this user a question and await the first valid answer from any of
   * their live connections. Present only when the contract declares
   * `serverRequests({...})`.
   */
  request?(
    event: string,
    payload: unknown,
    opts?: OptsParameter,
  ): Promise<{ response: unknown; from: ConnectionRef }>;

  /** Merge `patch` into every live connection's `meta` (fans the same patch out to all of the user's tabs/devices). */
  setMeta(patch: Partial<Meta>): void;

  /** Snapshot of this user's live connections. */
  connections(): ConnectionInfo<Meta>[];

  /** Close every live connection this user holds. */
  close(code?: number, reason?: string): void;

  /** A snapshot of this user, or `null` when the user has no live connections. */
  info(): UserInfo<Meta> | null;
}

/**
 * Reach any user by id. Available as `ctx.users`.
 *
 * @example
 * ```ts
 * ctx.users.get(targetId).broadcast('notice', { text: 'hello' });
 * ```
 */
export interface UsersManager<Meta = Record<string, unknown>> {
  /** Address one user by id. Returns a handle usable even when the user has no live connections. */
  get(id: string): UserHandle<Meta>;
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
   * Whether to include the calling connection. Defaults to `false` inside a
   * connection handler — pass `true` to also deliver to the sender.
   */
  readonly includeSelf?: boolean;
}

/**
 * Who a targeted channel broadcast or `request` targets. Any recipient other
 * than a `ConnectionRef` is
 * intersected with the channel's membership — a `UserRef` reaches only that
 * user's sockets that are members, and a `TagRef`/`TagGroupHandle` reaches only
 * members that also hold the tag. Non-members are never delivered to.
 */
export type ChannelRecipient =
  | ConnectionRef
  | UserRef
  | TagRef
  | {
      readonly __livething: 'group-handle';
      readonly kind: 'ephemeral' | 'persistent';
      readonly group: string;
    };

/**
 * Send and broadcast helpers scoped to one channel.
 *
 * Available as `ctx.channel` inside channel handlers. `send`, `broadcastTo`,
 * and `broadcast` automatically scope the outgoing event to the current
 * channel name.
 */
export interface ScopeSendApi {
  /** The resolved name of this channel instance. */
  readonly name: string;

  /**
   * Send a channel-scoped event to the current connection — the one whose event
   * you are handling. The frame arrives on the client's handle for this channel,
   * not the top-level socket. Returns `1` when delivered and `0` otherwise.
   */
  send(event: string, payload: unknown): number;

  /**
   * Broadcast a channel-scoped event to a selected member audience. A
   * `ConnectionRef` reaches one member; a `UserRef`, `TagRef`, or
   * `TagGroupHandle` can reach many members. Returns the delivered socket count.
   */
  broadcastTo(to: ChannelRecipient, event: string, payload: unknown): number;

  /** Broadcast an event to every connection in this channel. */
  broadcast(event: string, payload: unknown, options?: BroadcastOptions): void;
}

/**
 * Extended scope send API that includes replay support.
 *
 * `sendReplay` is only available when a replay capability is registered in the same
 * scope. In the broad runtime type it is optional because not every channel
 * context has replay enabled. The precise generated/app-facing types narrow
 * it to required only when replay is actually registered for that scope.
 */
export interface ReplayScopeSendApi extends ScopeSendApi {
  /**
   * Send a replayable event scoped to this channel.
   *
   * Provide replay wire metadata so reconnecting clients can request missed
   * messages and deduplicate anything they already received.
   */
  sendReplay?(event: string, payload: unknown, wire: WireParameter): void;
}

/**
 * One member's standing in a channel's inbox backlog — the unacked rows still
 * held for it and how far its received cursor has reached. Returned by
 * `handle.inbox().backlog()` for observability (who is behind, by how many rows,
 * and for how long), not as a warning.
 */
export interface InboxBacklogEntry {
  /** The member's user id. */
  readonly userId: string;
  /** Whether this user has a live connection on this instance right now. */
  readonly online: boolean;
  /** Count of unacked rows still held for this member on this channel. */
  readonly heldRows: number;
  /** The member's `received_through` cursor for this channel. */
  readonly receivedThrough: number;
  /** `created_at` (ms) of the member's oldest unacked held row. */
  readonly oldestHeldAt: number;
  /**
   * The member's last-seen timestamp (ms). Populated only when the `lastSeen()`
   * capability is installed; `undefined` otherwise.
   */
  readonly lastSeenAt?: number | null;
}

/**
 * The inbox surface for one channel, reached via `ctx.channel.inbox` in the
 * owning scope or `handle.inbox()` on any handle. Backs guaranteed per-member
 * delivery: seed a member's queue, read who has received a message, and inspect
 * the backlog.
 */
export type ChannelBackfillMessage<
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
> = {
  [E in keyof TOutgoing & string]: Omit<BackfillMessage, 'event' | 'payload'> & {
    event: E;
    payload: TOutgoing[E];
  };
}[keyof TOutgoing & string];

export interface ChannelInbox<TOutgoing extends Record<string, unknown> = Record<string, unknown>> {
  /** Seed one user's inbox with full frames, drained on their next reconnect. */
  backfill(userId: string, messages: readonly ChannelBackfillMessage<TOutgoing>[]): void;
  /** User ids whose received cursor has reached `seq`. */
  receiversOf(seq: number): string[];
  /** One entry per member that still has unacked held rows for this channel. */
  backlog(): InboxBacklogEntry[];
}

/**
 * The read-receipts surface for one channel, reached via
 * `ctx.channel.readReceipts` in the owning scope or `handle.readReceipts()` on
 * any handle. Present only on channels that opted into `readReceipts`.
 */
export interface ChannelReadReceipts {
  /** User ids whose read cursor has reached `seq`. */
  readersOf(seq: number): string[];
}

/**
 * A handle to one resolved channel, returned by `ctx.channel` (in-channel) and
 * by `ctx.channels.get(...)` (anywhere). Use it to send to the caller, broadcast
 * to subscribers, list members, or kick tagged connections out of this exact
 * channel family.
 *
 * `TOutgoing` is typed to the events declared inside the channel's
 * sub-builder, so `send`, `broadcastTo`, and `broadcast` only accept those events. `Meta` matches
 * the per-connection metadata shape returned by your `upgrade(...)` hook.
 */
export interface ChannelHandle<
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
  Meta = Record<string, unknown>,
  TParams extends Record<string, string> = Record<string, string>,
> {
  /** The concrete channel name this handle targets. */
  readonly name: string;

  /**
   * The channel family key when this handle was resolved from a dynamic
   * family registered with `scope(key, template)`, or `null` when the handle
   * targets a static channel registered with a string name.
   */
  readonly family: string | null;

  /**
   * The `{name}` captures from the matched channel name, typed from the
   * `scope()` template (e.g. `scope('rooms', 'room:{id}')` →
   * `params.id`). Empty object for static channels and templates with no
   * params.
   */
  readonly params: TParams;

  /**
   * Send a channel-scoped event to the current connection. Returns `1` when
   * delivered and `0` otherwise.
   */
  send<E extends keyof TOutgoing & string>(event: E, payload: TOutgoing[E]): number;

  /** Broadcast a channel-scoped event to a selected member audience. */
  broadcastTo<E extends keyof TOutgoing & string>(
    to: ChannelRecipient,
    event: E,
    payload: TOutgoing[E],
  ): number;

  /**
   * Broadcast a channel-scoped event to subscribers of this exact channel family.
   *
   * Excludes the calling connection by default. Pass `{ includeSelf: true }`
   * to also deliver the event to the sender.
   */
  broadcast<E extends keyof TOutgoing & string>(
    event: E,
    payload: TOutgoing[E],
    options?: { includeSelf?: boolean },
  ): void;

  /** List the connections currently subscribed to this exact channel family. */
  members(): ConnectionInfo<Meta>[];

  /**
   * Subscribe a connection to this channel from server code.
   *
   * Runs the same flow as a client-initiated subscribe: `check`, `commit`,
   * then `onSubscribe`. If the connection is already in this channel, this
   * is a no-op.
   *
   * `payload` is passed to the channel's `check` handler and validator.
   *
   * Rejects if `check` or `commit` throws — the connection is not added.
   */
  subscribe(ref: ConnectionRef, payload?: unknown): Promise<void>;

  /**
   * Remove connections from this exact channel family. The `target` decides
   * which connections leave:
   *
   * - `UserRef` — kick every one of that user's subscribed connections.
   * - `TagRef` — kick every socket holding the given `(kind, group, key)`.
   * - `TagGroupHandle` (returned by `ctx.tags.ephemeral(...)` / `.persistent(...)`)
   *   — kick every socket with any key under the group.
   *
   * To drop one specific socket without kicking the rest of its user's
   * connections, use `ctx.connections.get(ref).close()` instead.
   *
   * Sends `__kicked__` to each removed socket, fires `onUnsubscribe`, and
   * broadcasts `__memberLeave__` / `__memberOffline__` to remaining members
   * once the member has no live connection left in the channel.
   * Every targeted connection is kicked even when a leave hook throws. After
   * all of them finished, the returned promise rejects with an
   * `AggregateError` whose `errors` hold every hook failure.
   *
   * On a persistent channel, a `UserRef` also reaches a user who is a member
   * but has no live connection in the channel: peers get `__memberLeave__`,
   * and no hooks run because there is no socket.
   *
   * Pass `revoke: true` to also drop the durable membership row for each
   * kicked connection's user, so they are NOT auto-rejoined on their next
   * reconnect (use this to revoke a user's group membership in response to
   * an external event — an auth provider webhook, an admin action, etc.).
   * Defaults to `false`: the user is booted now but auto-rejoins later, and
   * peers see `__memberJoin__` when they do. A no-op per connection when the
   * channel is ephemeral — there is no durable row to drop either way.
   */
  kick(
    target:
      | UserRef
      | TagRef
      | {
          readonly __livething: 'group-handle';
          readonly kind: 'ephemeral' | 'persistent';
          readonly group: string;
        },
    opts: OptsParameter2,
  ): Promise<void>;

  /**
   * The inbox surface for this channel, or `null` when this channel has no
   * `inbox()` enabled. Works on any handle, including `ctx.channels.get(...)`.
   */
  inbox(): ChannelInbox | null;

  /**
   * The read-receipts surface for this channel, or `null` when this channel has
   * no `readReceipts()` enabled. Works on any handle, including
   * `ctx.channels.get(...)`.
   */
  readReceipts(): ChannelReadReceipts | null;
}

/**
 * Look up a channel handle from any handler. Use the single-argument overload
 * for static channel names, and the two-argument overload for dynamic channel
 * families declared with `scope(key, pattern)`. The returned handle is bound to
 * the resolved channel so members and kicks never cross into a different family.
 *
 * Available as `ctx.channels` when the `channels()` capability is listed.
 * Inside a channel handler, prefer `ctx.channel` instead.
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
 * as `ctx` inside a `base.on(...)` handler is a narrowed view that only
 * exposes the fields relevant to what you registered on the builder. This
 * interface lists **everything the engine might provide**; your handler type
 * trims it down.
 *
 * `ConnectionContext` is passed to handlers created with: `base.on`,
 * `base.request`, `base.stream`, `base.onConnect`, `base.onDisconnect`,
 * `base.onError`, and `base.onValidationError`.
 *
 * @template Meta     Per-connection metadata set in the upgrade step.
 * @template Platform The raw platform object (e.g. a Cloudflare DO stub).
 *
 * @example
 * ```ts
 * const handleSend = base.on('send', {
 *   input: v.object({ text: v.string() }),
 *   run(ctx, input) {
 *     ctx.send('message', { text: input.text });
 *     ctx.broadcast('message', { text: input.text });
 *   },
 * });
 * base.assemble({ handlers: [handleSend] });
 * ```
 *
 * Mental model, grouped by purpose:
 * - **identity** — `connection`, `user`, `meta`, `tags` (when the `tags()` capability is listed)
 * - **messaging** — `send`, `broadcast`, `connections.get(ref).send`, `users.get(id).broadcast`
 * - **scope helpers** — `channel`, `channels`
 * - **durability / platform** — `schedule`, `cancelScheduled`, `sql`, `kv`,
 *   `log`, `platform`
 */
export interface ConnectionContext<Meta = Record<string, unknown>, Platform = unknown> {
  /**
   * A `ConnectionRef` for the current connection — the self socket address.
   * Pass it to engine methods that act on a specific socket. Equivalent to
   * calling `.ref()` on the current connection's `ConnectionInfo`, but
   * available directly here. Use `ctx.connection.id` for the bare id string.
   */
  connection: ConnectionRef;

  /**
   * A handle to the current connection's user — the account this connection
   * belongs to. Present on every connection, but on an anonymous one (upgrade
   * returned no user id) its `id` is an empty string and it reaches nobody.
   * Use `ctx.user.id` for the bare id
   * string; the handle itself carries the user-level actions (`broadcast`,
   * `request`, `setMeta`, `connections`, `close`, `info`) that fan out to
   * every live connection this user holds.
   */
  user: UserHandle<Meta>;

  /** Metadata attached during the upgrade step (e.g. role, display name). */
  meta: Meta;

  /**
   * Send an event to the current connection only. Returns `true` when the frame
   * was handed to the socket. Returns `false` when it was not sent: on a server
   * with a `translator`, the connection is closing or the `outbound` translation
   * failed (LiveThing then closes the connection). It also returns `false` when
   * the platform adapter refuses the frame. Throws for an undeclared event or a
   * non-object payload.
   */
  send(event: string, payload: unknown): boolean;

  /**
   * Send an event to all live connections except the caller. Pass
   * `{ includeSelf: true }` to also deliver the event to the calling
   * connection.
   *
   * Treat data you broadcast as untrusted by the receiving clients. The
   * server-side schema validated the inbound payload, but receivers must
   * still escape the data before rendering it. See `SECURITY.md` for the full
   * boundary.
   */
  broadcast(event: string, payload: unknown, options?: BroadcastOptions): void;

  /**
   * Merge `patch` into the current connection's `meta`. Persists on the
   * existing scope-end flush, alongside every other durable write for this
   * dispatch.
   */
  setMeta(patch: Partial<Meta>): void;

  /** Reach any connection by ref, or list every live connection. */
  connections: ConnectionsManager<Meta>;

  /** Reach any user by id. */
  users: UsersManager<Meta>;

  /** Close the current WebSocket connection. */
  close(code?: number, reason?: string): void;

  /** The total number of live connections right now. */
  connectionCount: number;

  /** Bytes still queued to be sent to this connection. Useful for back-pressure detection. */
  bufferedAmount: number;

  /** Round-trip latency in milliseconds, or `null` until the first ping/pong completes. */
  latency: number | null;

  /** A simple health label derived from recent ping/pong measurements. `null` when hibernation is enabled. */
  quality: 'excellent' | 'good' | 'degraded' | 'poor' | null;

  /**
   * The WebSocket close code, present only in `onDisconnect` handlers
   * (and plugin `onDisconnect`). Common values: `1000` graceful close,
   * `1001` going-away during server shutdown, `1006` abnormal close
   * (network failure), `4xxx` application-defined (e.g. moderator kick).
   * Undefined in every other handler — `onConnect`, `incoming`, etc.
   */
  closeCode?: number;

  /**
   * The WebSocket close reason string, paired with `closeCode`. Present
   * only in `onDisconnect` handlers (and plugin `onDisconnect`). The
   * empty string when the close did not carry a reason.
   */
  closeReason?: string;

  /** Scoped send/broadcastTo/broadcast when inside a channel handler, with optional replay support. */
  channel?: ReplayScopeSendApi;

  /** Resolve a channel handle from any handler. Only present when `channels()` is listed. */
  channels: ChannelsManager<string, string, Record<string, Record<string, unknown>>, Meta>;

  /** Queue a scheduled task to run at a specific absolute timestamp (ms since epoch). */
  schedule(taskId: string, options: OptionsParameter3): void;

  /** Cancel queued runs for a scheduled task. Pass a `filter` to cancel only matching runs. */
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;

  /** SQL storage access. */
  sql: SQLProvider;

  /** Key-value storage access. */
  kv: KVProvider;

  /** Structured logger. */
  log: Logger;

  /** Raw platform object from the adapter (Durable Object stub, etc.). */
  platform: Platform;

  /**
   * Store a typed value under a key for the current message dispatch.
   *
   * Provided values are visible to every downstream intercept and to the
   * final handler that shares this dispatch context. They are isolated
   * per dispatch — values set here are not visible to the next message.
   *
   * @see inject
   */
  provide<T>(key: LocalKey<T>, value: T): void;

  /**
   * Retrieve a value stored by an upstream `provide` call for this dispatch.
   *
   * Returns `undefined` when nothing was provided for the given key in this
   * dispatch (e.g. the providing intercept did not run, or no intercept
   * called `provide` for this key at all).
   *
   * @see provide
   */
  inject<T>(key: LocalKey<T>): T | undefined;

  /**
   * Type guard narrowing an intercept `frame` to a declared event's payload.
   * Returns `true` when the frame's event, scope, and payload all match the
   * key; the payload is run through the declared validator. Throws when the key
   * names no declared event. Channel-scoped keys use `@family::event`.
   */
  matches(key: string, frame: InterceptFrame): boolean;

  /**
   * Narrow an intercept `frame` without a runtime check — a type-only assertion
   * for when your own logic already established the payload's shape. Throws when
   * the key names no declared event. Channel-scoped keys use `@family::event`.
   */
  unsafeCast(key: string, frame: InterceptFrame): InterceptFrame;
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
export interface InitContext<Platform = unknown> {
  /** SQL database access for queries, migrations, and transactions. */
  sql: SQLProvider;

  /** Key-value storage for simple get/set/delete operations. */
  kv: KVProvider;

  /** Structured logger — writes to the platform's logging system. */
  log: Logger;

  /** The raw platform object from the adapter (e.g. DurableObjectState on Cloudflare). */
  platform: Platform;
}

/**
 * The server→client (`emits`) events read off the merged contract slots, used
 * to type `ShutdownContext.broadcast`. Falls back to a permissive map when the
 * slots type is `unknown` (the broad runtime type), so the precise app-facing
 * builder narrows it while the bare interface stays usable.
 */
type ShutdownOutgoing<TSlots> = 'outgoing' extends keyof TSlots
  ? TSlots['outgoing']
  : Record<string, unknown>;

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
  Meta = Record<string, unknown>,
  Platform = unknown,
  TSlots = unknown,
> {
  /** Close every live connection at once. */
  closeAll(code?: number, reason?: string): void;

  /**
   * Broadcast an event to every live connection. Typed against the server's
   * `emits(...)` events, so a typo or wrong payload is a compile error. To
   * target only members of a specific channel, resolve the channel through
   * your handler's typed channel surface — the shutdown context does not
   * filter by channel.
   */
  broadcast<E extends keyof ShutdownOutgoing<TSlots> & string>(
    event: E,
    payload: ShutdownOutgoing<TSlots>[E],
  ): void;

  /** SQL database access for queries, migrations, and transactions. */
  sql: SQLProvider;

  /** Key-value storage for simple get/set/delete operations. */
  kv: KVProvider;

  /** Queue a scheduled task to run at a specific time (milliseconds since epoch). */
  schedule(taskId: string, options: OptionsParameter4): void;

  /** Cancel all pending runs of a scheduled task, optionally filtered by data fields. */
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;

  /** The total number of live WebSocket connections right now. */
  connectionCount: number;

  /** Reach any specific connection by ref with `get(ref)`, or snapshot every live connection with `all()`. */
  connections: ConnectionsManager<Meta>;

  /** Reach any user by id with `get(id)` to fan out to every socket they hold. */
  users: UsersManager<Meta>;

  /** Structured logger — writes to the platform's logging system. */
  log: Logger;

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
export interface TaskContext<Meta = Record<string, unknown>, Platform = unknown> {
  /** SQL database access for queries, migrations, and transactions. */
  sql: SQLProvider;

  /** Key-value storage for simple get/set/delete operations. */
  kv: KVProvider;

  /**
   * Broadcast an event to every live connection. The task context has no
   * channel filter — for channel-scoped broadcasts, resolve a channel
   * handle from a connection-scoped handler instead.
   */
  broadcast(event: string, payload: unknown): void;

  /** Reach any specific connection by ref with `get(ref)`, or snapshot every live connection with `all()`. */
  connections: ConnectionsManager<Meta>;

  /** Reach any user by id with `get(id)` to fan out to every socket they hold. */
  users: UsersManager<Meta>;

  /** The total number of live WebSocket connections right now. */
  connectionCount: number;

  /** Queue a scheduled task to run at a specific time (milliseconds since epoch). */
  schedule(taskId: string, options: OptionsParameter5): void;

  /** Cancel all pending runs of a scheduled task, optionally filtered by data fields. */
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;

  /** Structured logger — writes to the platform's logging system. */
  log: Logger;

  /** The raw platform object from the adapter (e.g. DurableObjectState on Cloudflare). */
  platform: Platform;
}

/** Options accepted by {@link AdminContext.purgeUser}. */
export interface PurgeUserOptions {
  /**
   * Keep the content of broadcast streams the purged user created — the
   * channel-owned stream row plus its recorded chunks. Default `false`: that
   * content is deleted along with everything else the user owns. Either way,
   * the user is cleared as the stream's creator.
   */
  keepBroadcastContent?: boolean;
}

/** The channel operations available connectionlessly from an admin context. */
export interface AdminChannelHandle<Meta = Record<string, unknown>> {
  /** Broadcast a channel event to its members. */
  broadcast(event: string, payload: unknown): void;
  /** Snapshot of the channel's members. */
  members(): ConnectionInfo<Meta>[];
  /**
   * Remove a user (or everyone holding a tag) from this channel. Pass
   * `revoke: true` to also drop the durable membership row so the user does
   * not auto-rejoin on reconnect.
   */
  kick(target: UserRef | TagRef, opts: OptsParameter3): Promise<void>;
}

/** Reach a channel by name from admin — the connectionless subset of `ctx.channels`. */
export interface AdminChannels<Meta = Record<string, unknown>> {
  /** A static channel by name. */
  get(name: string): AdminChannelHandle<Meta>;
  /** A dynamic channel by family key and instance name. */
  get(family: string, instance: string): AdminChannelHandle<Meta>;
}

/**
 * The context an admin operation runs against — reached with `service.admin()`.
 *
 * Admin operations run **outside** the socket layer: from an HTTP route, an auth
 * webhook, or a cron job, where no client connection is in scope. So this
 * context has no `id`, `send`, `meta`, or `close` — there is no "current
 * connection" to act on. It exposes only engine-wide operations: broadcast to
 * everyone, reach a channel by name, drop a user everywhere, and read storage.
 *
 * `tags` admin operations are not part of this context yet.
 */
export interface AdminContext<
  Meta = Record<string, unknown>,
  Platform = unknown,
  TSlots = unknown,
> {
  /**
   * Broadcast an event to every live connection. Typed against the server's
   * `emits(...)` events, so a typo or wrong payload is a compile error.
   */
  broadcast<E extends keyof ShutdownOutgoing<TSlots> & string>(
    event: E,
    payload: ShutdownOutgoing<TSlots>[E],
  ): void;

  /** Reach a channel by name (or family + instance) to act on its members. */
  channels: AdminChannels<Meta>;

  /**
   * Drop a user everywhere: leave every channel they belong to (live and
   * durable), remove their persistent tags, wipe their inbox rows and read
   * receipts, their last-seen mark, their durable streams (and any broadcast
   * stream they merely subscribe to), and close every live socket they hold.
   * The one call the auth-webhook case (`user.deleted`) needs.
   *
   * A broadcast stream the user created belongs to the whole channel, not
   * just to them, so by default its content (the stream row and its recorded
   * chunks) is deleted along with everything else — the safe choice for a
   * delete-my-data call. Pass `{ keepBroadcastContent: true }` to keep that
   * content and only clear the user as its creator:
   *
   * ```ts
   * // Default: broadcast streams alice created are deleted too.
   * await ctx.purgeUser('alice');
   *
   * // Keep channel-owned broadcast content, just stop crediting alice as its creator.
   * await ctx.purgeUser('alice', { keepBroadcastContent: true });
   * ```
   *
   * Cleanup is best effort: every registered capability and live socket is
   * attempted even when another step fails. The promise rejects with an
   * `AggregateError` after all cleanup attempts finish.
   */
  purgeUser(userId: string, options?: PurgeUserOptions): Promise<void>;

  /**
   * Close live connections. With no filter, closes every connection; with
   * `{ userId }`, closes only that user's sockets.
   */
  closeConnections(filter?: FilterParameter, code?: number, reason?: string): void;

  /** Reach any specific connection by ref with `get(ref)`, or snapshot every live connection with `all()`. */
  connections: ConnectionsManager<Meta>;

  /** Reach any user by id with `get(id)` to fan out to every socket they hold. */
  users: UsersManager<Meta>;

  /** The total number of live WebSocket connections right now. */
  connectionCount: number;

  /** SQL database access for queries, migrations, and transactions. */
  sql: SQLProvider;

  /** Key-value storage for simple get/set/delete operations. */
  kv: KVProvider;

  /** Queue a scheduled task to run at a specific time (milliseconds since epoch). */
  schedule(taskId: string, options: OptionsParameter6): void;

  /** Cancel all pending runs of a scheduled task, optionally filtered by data fields. */
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;

  /** Structured logger — writes to the platform's logging system. */
  log: Logger;

  /** The raw platform object from the adapter (e.g. DurableObjectState on Cloudflare). */
  platform: Platform;
}
