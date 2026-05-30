/* oxlint-disable @typescript-eslint/no-explicit-any */

import type {
  ChannelHandle,
  ChannelsManager,
  ConnectionInfo,
  ConnectionRef,
  KVProvider,
  Logger,
  SQLProvider,
  TagRef,
} from '~/context.ts';
import type { LocalKey } from '~/local-key/local-key.ts';
import type { Contract } from './contract-types.ts';

// ---------------------------------------------------------------------------
// Typed messaging APIs
// ---------------------------------------------------------------------------

interface TypedSendApi<TOutgoing> {
  /** Send an event to the current connection. Returns false if the socket can't accept it. */
  send<E extends keyof TOutgoing & string>(event: E, payload: TOutgoing[E]): boolean;
  /**
   * Send an event to every other connection on this server. By default the
   * calling connection is excluded; pass `excludeSelf: false` to include it
   * in the fan-out.
   */
  broadcast<E extends keyof TOutgoing & string>(
    event: E,
    payload: TOutgoing[E],
    options?: { excludeSelf?: boolean },
  ): void;
}

// ---------------------------------------------------------------------------
// Typed tags API
// ---------------------------------------------------------------------------

/**
 * Address for every connection holding any key under one group. Built via
 * `ctx.tags.ephemeral(group)` / `ctx.tags.persistent(group)`.
 */
export interface TagGroupHandle<TValue extends string = string> {
  readonly __wskit: 'group-handle';
  readonly kind: 'ephemeral' | 'persistent';
  readonly group: string;
  /** Add a value for the current connection under this group. */
  add(key: TValue): void;
  /** Remove a value from the current connection under this group. */
  remove(key: TValue): void;
  /** Whether the current connection holds `key` under this group. */
  has(key: TValue): boolean;
  /** Active keys under this group across every connection on this server instance. */
  keys(): readonly string[];
  /** Snapshot of every connection on this server instance holding any key under this group. */
  connections(): readonly ConnectionInfo[];
  /** Number of distinct connections on this server instance holding any key under this group. */
  count(): number;
  /** Return a handle to every connection holding a specific value under this group. */
  ref(key: TValue): TagRefHandle;
}

/**
 * Handle to one specific tag — a `(group, key)` pair such as `("user", "u1")`.
 * Built via `ctx.tags.ephemeral(group).ref(key)` or `.persistent(group).ref(key)`.
 * Lets you send to or count every connection currently holding that tag.
 */
export interface TagRefHandle extends TagRef {
  /** Send an event to every connection holding this tag. */
  send(event: string, payload: unknown): void;
  /** Snapshot of every connection currently holding this tag. */
  connections(): readonly ConnectionInfo[];
  /** Count of connections currently holding this tag. */
  count(): number;
}

/**
 * Typed tag groups. Group names are strictly the ones declared on the
 * contract — passing an undeclared name is a type error and a runtime throw.
 */
export interface TagsApi<
  TEphemeral extends Record<string, string> = Record<string, string>,
  TPersistent extends Record<string, string> = Record<string, string>,
> {
  ephemeral<G extends keyof TEphemeral & string>(group: G): TagGroupHandle<TEphemeral[G]>;
  persistent<G extends keyof TPersistent & string>(group: G): TagGroupHandle<TPersistent[G]>;
  /** Snapshot of every tag currently attached to this connection. */
  list(): readonly { kind: 'ephemeral' | 'persistent'; group: string; key: string }[];
}

// ---------------------------------------------------------------------------
// Typed channels manager
// ---------------------------------------------------------------------------

type ChannelOutgoing<C> = C extends { outgoing: infer O }
  ? O extends Record<string, any>
    ? O
    : {}
  : {};

type TypedChannelsManager<TChannels, Meta> = {
  get<K extends keyof TChannels & string>(
    name: K,
  ): ChannelHandle<ChannelOutgoing<TChannels[K]>, Meta>;
  get<K extends keyof TChannels & string>(
    family: K,
    name: string,
  ): ChannelHandle<ChannelOutgoing<TChannels[K]>, Meta>;
};

// ---------------------------------------------------------------------------
// Scheduled api
// ---------------------------------------------------------------------------

interface ScheduleApi<TScheduled> {
  /**
   * Queue a scheduled task to run once at `time` (a unix millisecond
   * timestamp). The body you bound via `implement(c).scheduled(taskId, ...)`
   * runs when the time arrives. `data` is delivered to that handler.
   */
  schedule<I extends keyof TScheduled & string>(
    taskId: I,
    options: TScheduled[I] extends undefined | unknown
      ? { time: number; data?: TScheduled[I] }
      : { time: number; data: TScheduled[I] },
  ): void;
  /**
   * Cancel pending runs of a scheduled task. With no `filter` it cancels all
   * pending runs for that task. With a filter it cancels every run whose
   * `data` matches the filter's keys.
   */
  cancelScheduled<I extends keyof TScheduled & string>(
    taskId: I,
    filter?: Record<string, unknown>,
  ): void;
}

// ---------------------------------------------------------------------------
// Top-level Ctx derivation
// ---------------------------------------------------------------------------

/**
 * The `ctx` object passed to handlers registered via
 * `implement(contract).on(...)`. Every method is always on the type. Calling
 * a feature method when the contract did not enable that feature throws at
 * runtime with a clear message.
 */
export type Ctx<C extends Contract> = {
  /** Unique id of this connection. Stable for the lifetime of the socket. */
  readonly id: string;
  /** App-supplied identity string returned from `onUpgrade`. Stable until disconnect. */
  readonly identity: string;
  /** A reference handle to this connection — pass to `kick`, `subscribe`, etc. */
  readonly self: ConnectionRef;
  /** App-supplied metadata attached at upgrade time. Typed via `meta: t<...>()` on the contract. */
  readonly meta: C['meta'];
  /** Adapter-injected environment (e.g. Cloudflare `env`). Typed by `env: t<Env>()` on the contract config. */
  readonly env: C['env'];
  /** Adapter-injected platform handle (e.g. Cloudflare DurableObjectState). Untyped by default. */
  readonly platform: unknown;

  /** Bytes currently buffered on the WebSocket. Use to detect a slow consumer. */
  readonly bufferedAmount: number;
  /** Last measured round-trip latency in ms, or `null` if not yet known. */
  readonly latency: number | null;
  /** Coarse health bucket derived from latency. `null` when hibernation is enabled (no server-side ping is sent). */
  readonly quality: 'excellent' | 'good' | 'degraded' | 'poor' | null;
  /** Set inside `onDisconnect` — the close code reported by the socket. */
  readonly closeCode?: number;
  /** Set inside `onDisconnect` — the close reason string reported by the socket. */
  readonly closeReason?: string;

  /** Number of currently-open connections on this server instance. */
  readonly connectionCount: number;

  /** Send an event to a specific other connection by id. Returns false if the target isn't here. */
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;
  /** Close this WebSocket. */
  close(code?: number, reason?: string): void;
  /** Snapshot of every currently-open connection on this server instance. */
  getConnections(): ConnectionInfo<C['meta']>[];

  /** Adapter-provided SQL surface. Throws if the adapter has no storage. */
  readonly sql: SQLProvider;
  /** Adapter-provided KV surface. Throws if the adapter has no storage. */
  readonly kv: KVProvider;
  /** Engine logger — `info` / `warn` / `error`. */
  readonly log: Logger;
  /** Keep a promise alive past the end of the handler (e.g. Cloudflare `waitUntil`). */
  waitUntil(promise: Promise<unknown>): void;
  /** Set the next alarm on the adapter's timer surface (unix ms). */
  setAlarm(time: number): void;

  /**
   * Store a typed value under a key for the current message dispatch. The
   * value is visible to every downstream intercept and to the final handler
   * sharing this dispatch context. Each dispatch starts with a clean store.
   * @see inject
   */
  provide<T>(key: LocalKey<T>, value: T): void;
  /**
   * Retrieve a value stored by an upstream intercept's `ctx.provide` call.
   * Returns `undefined` when nothing was provided for this key in the current
   * dispatch.
   * @see provide
   */
  inject<T>(key: LocalKey<T>): T | undefined;

  // ───── Always-on feature surface. Runtime throws if the feature was not enabled. ─────

  /** Send an `__ack__` back to the client. Requires `ack: true` on the contract. */
  ack(): void;
  /**
   * Inject a synthetic replay frame for one outgoing event. Requires
   * `replay: ...` on the contract. Use it from a custom-replay hook or to
   * seed history manually; the `wire` carries the seq/messageId the client
   * uses to dedup.
   */
  sendReplay(
    event: keyof C['outgoing'] & string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string; channelScope?: string | null },
  ): void;
  /** Send a raw binary frame to this connection. Requires `binary: true` on the contract. */
  sendBinary(data: ArrayBuffer | ArrayBufferView): boolean;
  /**
   * Send a raw binary frame to every other connection by default. Requires
   * `binary: true` on the contract. Pass `{ excludeSelf: false }` to include
   * this connection too.
   */
  broadcastBinary(data: ArrayBuffer | ArrayBufferView, options?: { excludeSelf?: boolean }): void;
} & TypedSendApi<C['outgoing']> &
  ScheduleApi<C['scheduled']> & {
    /** Look up channel handles by name. Each handle lets you send/broadcast into one channel. */
    readonly channels: keyof C['channels'] extends never
      ? ChannelsManager<string, string, Record<string, Record<string, unknown>>, C['meta']>
      : TypedChannelsManager<C['channels'], C['meta']>;
    /** Tag groups declared on the contract — attach/find connections by labelled keys. */
    readonly tags: TagsApi<C['tagGroups']['ephemeral'], C['tagGroups']['persistent']>;
  };

// ---------------------------------------------------------------------------
// Channel-scoped ctx
// ---------------------------------------------------------------------------

type ChannelOutgoingOf<T> = T extends { outgoing: infer O } ? O : Record<string, unknown>;

/**
 * The `ctx` your channel handlers receive. Same as the top-level `Ctx<C>`,
 * but `ctx.channel.send` and `.broadcast` are typed against this channel's
 * own outgoing events, and `ctx.channel.subscribe` / `.kick` / `.members`
 * operate on this channel's membership.
 */
export type ChannelCtx<TChannelContract, C extends Contract> = Omit<Ctx<C>, 'channel'> & {
  readonly channel: {
    readonly name: string;
    readonly scope: string | null;
    send<E extends keyof ChannelOutgoingOf<TChannelContract> & string>(
      event: E,
      payload: ChannelOutgoingOf<TChannelContract>[E],
    ): boolean;
    broadcast<E extends keyof ChannelOutgoingOf<TChannelContract> & string>(
      event: E,
      payload: ChannelOutgoingOf<TChannelContract>[E],
      options?: { excludeSelf?: boolean },
    ): void;
    members(): ConnectionInfo<C['meta']>[];
    subscribe(ref: ConnectionRef, payload?: unknown): Promise<void>;
    kick(target: ConnectionRef | TagRef | TagGroupHandle, reason: string): Promise<void>;
    removeMember(identity: string): Promise<void>;
    sendReplay(
      event: keyof ChannelOutgoingOf<TChannelContract> & string,
      payload: unknown,
      wire: { seq: number; messageId: string; channel?: string; channelScope?: string | null },
    ): void;
  };
};

// ---------------------------------------------------------------------------
// Namespace-scoped ctx
// ---------------------------------------------------------------------------

/**
 * The `ctx` your namespace handlers receive. Same as the top-level `Ctx<C>`,
 * but `ctx.namespace.send` and `.broadcast` are typed against this namespace's
 * own outgoing events and only reach clients in this namespace.
 */
export type NamespaceCtx<TNamespaceContract, C extends Contract> = Omit<Ctx<C>, 'namespace'> & {
  readonly namespace: {
    readonly name: string;
    send<E extends keyof ChannelOutgoingOf<TNamespaceContract> & string>(
      event: E,
      payload: ChannelOutgoingOf<TNamespaceContract>[E],
    ): boolean;
    broadcast<E extends keyof ChannelOutgoingOf<TNamespaceContract> & string>(
      event: E,
      payload: ChannelOutgoingOf<TNamespaceContract>[E],
      options?: { excludeSelf?: boolean },
    ): void;
  };
};
