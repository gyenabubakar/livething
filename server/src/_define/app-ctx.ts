/* oxlint-disable @typescript-eslint/no-explicit-any */
import type {
  AdminContext,
  ChannelHandle,
  ConnectionInfo,
  ConnectionRef,
  KVProvider,
  Logger,
  SQLProvider,
  UserInfo,
  UserRef,
} from '~/context.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { KeepaliveCtx } from '~/keepalive/ctx.ts';
import type { LastSeenCtx } from '~/last-seen/ctx.ts';
import type { LocalKey } from '~/local-key/local-key.ts';
import type { TagGroupHandle, TagRefHandle, TagsApi } from '~/tags/types.ts';
import type { AnyCapability, BrandsOf, FeaturesOf, SlotOr } from './capability.ts';

/**
 * A handle to one specific connection, returned by `ctx.connections.get(ref)`. Its
 * `send` is typed to the server's `emits(...)` events, so a typo or wrong
 * payload is a compile error.
 *
 * The handle is the seam for addressing one socket. It carries `send` and
 * `close` always;
 * the `requests()` capability adds the `request` arm (see `ConnectionRequestHandle`).
 *
 * @template TSlots The merged contract slots — drives the typed `send`.
 */
export interface ConnectionHandle<TSlots> {
  /**
   * Send an event to this connection only. Returns `false` when the connection
   * is no longer live on this instance.
   */
  send<E extends keyof Outgoing<TSlots> & string>(event: E, payload: Outgoing<TSlots>[E]): boolean;

  /** Close this connection only. No-op when the connection is no longer live. */
  close(code?: number, reason?: string): void;
}

/**
 * The server→client request map. Every request is callable both targeted (via
 * `request`, resolving the answer) and fan-out (via `broadcastRequest`, resolving
 * the first answer + who gave it). The verb decides which, not the declaration.
 * A declaration with no `in` is an acknowledgement — its response type is `void`.
 */
type ServerRequests<TSlots> = SlotOr<TSlots, 'serverRequests'>;

/** Same map, named for the fan-out arm: `broadcastRequest` accepts every request. */
export type BroadcastServerRequests<TSlots> = SlotOr<TSlots, 'serverRequests'>;

declare const CHANNEL_CONTRACT: unique symbol;

/**
 * A channel reference that `ctx.channels.get(...)` can fully type: a static
 * channel declaration passed directly, or a dynamic family's `.at(params)` result. The
 * phantom carries the channel's emit + request contract so the resolved handle
 * types `send`/`broadcast`/`broadcastRequest` to that channel — never read at
 * runtime.
 */
export interface ChannelRef<TOutgoing = Record<string, unknown>, TServerRequests = {}> {
  readonly [CHANNEL_CONTRACT]: { outgoing: TOutgoing; serverRequests: TServerRequests };
}

/** What a `broadcastRequest(...)` resolves to: the winning answer and who gave it. */
export interface BroadcastAnswer<R> {
  /** The first valid answer, validated against the request's `response` schema. */
  readonly response: R;
  /** The connection that answered first. */
  readonly from: ConnectionRef;
}

/**
 * The `broadcastRequest` arm a `requests()` server adds to every fan-out
 * surface. Every declared server→client request is callable here — the verb
 * decides fan-out vs targeted, not the declaration. Resolves with the first
 * valid answer and its `from` ref, or rejects with `timeout` when nobody
 * answers in time.
 *
 * @template SR The server→client request map for this scope.
 */
export interface BroadcastRequestArm<SR> {
  broadcastRequest<E extends keyof SR & string>(
    event: E,
    payload: SR[E] extends { payload: infer P } ? P : never,
    options?: { timeout?: number },
  ): Promise<BroadcastAnswer<SR[E] extends { response: infer R } ? R : never>>;
}

/**
 * The `request` arm a `requests()` server adds to a `ctx.connections.get(ref)`
 * handle. The server asks one specific connection a declared server→client
 * request and awaits its typed answer.
 */
export interface ConnectionRequestHandle<TSlots> extends ConnectionHandle<TSlots> {
  /**
   * Ask this one connection a declared server→client request and resolve its
   * typed answer. Rejects with `timeout` if no answer arrives, `disconnected`
   * if the connection drops while waiting, or `request-invalid-response` if the
   * answer fails its declared `response` schema.
   */
  request<E extends keyof ServerRequests<TSlots> & string>(
    event: E,
    payload: ServerRequests<TSlots>[E] extends { payload: infer P } ? P : never,
    options?: { timeout?: number },
  ): Promise<ServerRequests<TSlots>[E] extends { response: infer R } ? R : never>;
}

/**
 * The `ctx.request` / `ctx.connections.get(ref).request` surface — owned by the
 * `requests()` capability. Server→client targeted requests: ask one connection
 * and await its typed answer.
 */
export interface ServerRequestCtx<TSlots> extends BroadcastRequestArm<
  BroadcastServerRequests<TSlots>
> {
  /**
   * Ask the current connection a declared server→client request and resolve its
   * typed answer. Rejects with `timeout`/`disconnected`/`request-invalid-response`.
   */
  request<E extends keyof ServerRequests<TSlots> & string>(
    event: E,
    payload: ServerRequests<TSlots>[E] extends { payload: infer P } ? P : never,
    options?: { timeout?: number },
  ): Promise<ServerRequests<TSlots>[E] extends { response: infer R } ? R : never>;
  /**
   * Ask every connection on this instance a broadcast-declared server→client
   * request; the first valid answer wins. Resolves with `{ response, from }` or
   * rejects with `timeout` when nobody answers (silence means "no").
   */
}

/**
 * The handle `ctx.connections.get(ref)` returns. It always carries the typed
 * `send`; with `requests()` listed it also carries the typed `request(...)`,
 * gated on `TCaps` so the arm is a compile error otherwise.
 */
type ConnectionGetHandle<TSlots, TCaps extends readonly AnyCapability[]> =
  'requests' extends BrandsOf<TCaps> ? ConnectionRequestHandle<TSlots> : ConnectionHandle<TSlots>;

/**
 * `ctx.connections`, always present. Reach one specific socket by ref with
 * `get(ref)`, or snapshot every live connection on this instance with `all()`.
 */
export interface ConnectionsCtx<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  connections: {
    /**
     * Address one specific connection by ref. The handle always carries `send`;
     * with `requests()` listed it also carries `request(...)`.
     */
    get(ref: ConnectionRef): ConnectionGetHandle<TSlots, TCaps>;
    /** Snapshot of every connection currently open on this server instance. */
    all(): ConnectionInfo<TMeta>[];
  };
}

/**
 * The `request` arm a `requests()` server adds to a `UserHandle`. Asks every
 * live socket the user holds and settles on the first valid answer, reporting
 * which connection gave it via `from`.
 */
export interface UserRequestArm<TSlots> {
  request<E extends keyof ServerRequests<TSlots> & string>(
    event: E,
    payload: ServerRequests<TSlots>[E] extends { payload: infer P } ? P : never,
    options?: { timeout?: number },
  ): Promise<BroadcastAnswer<ServerRequests<TSlots>[E] extends { response: infer R } ? R : never>>;
}

/**
 * A handle to one user — every live socket the user currently holds. `send` fans
 * the event to all of them and returns how many sockets received it; `setMeta`
 * fans a metadata patch the same way. Typed to the server's `emits(...)` events.
 */
export interface UserHandleBase<TSlots, TMeta> {
  /** The user id — the value `upgrade(...)` returned, or `''` on an anonymous connection. */
  readonly id: string;
  /** Build a `UserRef` for this user — pass it to `kick` and the like. */
  ref(): UserRef;
  /** Fan an event to every live socket the user holds. Returns the delivered socket count. */
  send<E extends keyof Outgoing<TSlots> & string>(event: E, payload: Outgoing<TSlots>[E]): number;
  /** Merge a metadata patch into every one of the user's live connections. */
  setMeta(patch: Partial<TMeta>): void;
  /** Snapshot the user's currently-live connections. */
  connections(): ConnectionInfo<TMeta>[];
  /** Close every one of the user's live sockets. */
  close(code?: number, reason?: string): void;
  /** A point-in-time snapshot of the user, or `null` when they have no live connection. */
  info(): UserInfo<TMeta> | null;
}

/** A `UserHandle`, plus the `request` arm when `requests()` is listed. */
type UserHandleCtx<TSlots, TMeta, TCaps extends readonly AnyCapability[]> = UserHandleBase<
  TSlots,
  TMeta
> &
  ('requests' extends BrandsOf<TCaps> ? UserRequestArm<TSlots> : {});

/**
 * `ctx.user` (the current connection's user) and `ctx.users` (reach any user by
 * id), always present. A user is one or more connections sharing the id
 * `upgrade(...)` returned. An anonymous connection has no user identity —
 * `ctx.user` is still there but reaches nobody.
 */
export interface UsersCtx<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /** The user behind the current connection. */
  user: UserHandleCtx<TSlots, TMeta, TCaps>;
  /** Reach any user by id. */
  users: { get(id: string): UserHandleCtx<TSlots, TMeta, TCaps> };
}

/**
 * The connection-scoped surface present on **every** server, whatever
 * capabilities are listed. Identity, metadata, storage, messaging, and logging
 * always exist. Capability-owned surfaces (`ctx.tags`, `ctx.channels`,
 * `ctx.schedule`, `ctx.latency`/`ctx.quality`, `ctx.plugin`) are NOT
 * here — each is added by `CtxExtensionsOf` only when its capability is listed,
 * so reading one without its capability is a compile error.
 *
 * @template TSlots The merged contract slots — drives the typed `send`/`broadcast`.
 * @template TEnv   The platform env bindings, declared by `env: t<Env>()`.
 * @template TMeta  The per-connection metadata returned from `upgrade(...)`.
 */
export type CoreCtx<TSlots, TEnv, TMeta> = {
  /**
   * A `ConnectionRef` for the current connection — the self socket address. Read
   * `ctx.connection.id` for the connection id and `ctx.connection.userId` for the
   * user id; pass the ref itself to `kick`, `subscribe`, and the like.
   */
  readonly connection: ConnectionRef;
  /** The metadata returned from `upgrade(...)`, typed from its return value. */
  readonly meta: TMeta;
  /** Merge a patch into this connection's `meta`. Persists once at the end of the handler. */
  setMeta(patch: Partial<TMeta>): void;
  /** The platform env bindings (for example Cloudflare Workers `Env`). */
  readonly env: TEnv;
  /** The raw platform handle (for example a Durable Object state). Untyped by default. */
  readonly platform: unknown;

  /** Bytes currently buffered on the socket. A rising value signals a slow client. */
  readonly bufferedAmount: number;
  /** The socket close code — set only inside the disconnect hook. */
  readonly closeCode?: number;
  /** The socket close reason — set only inside the disconnect hook. */
  readonly closeReason?: string;

  /** Number of connections currently open on this server instance. */
  readonly connectionCount: number;

  /** Close this connection. */
  close(code?: number, reason?: string): void;

  /** Adapter-provided SQL surface. Throws if the adapter has no storage. */
  readonly sql: SQLProvider;
  /** Adapter-provided key/value surface. Throws if the adapter has no storage. */
  readonly kv: KVProvider;
  /** Engine logger — `info` / `warn` / `error`. */
  readonly log: Logger;
  /** Keep a promise running past the end of the handler (for example Cloudflare `waitUntil`). */
  waitUntil(promise: Promise<unknown>): void;
  /**
   * Store a typed value for the current message dispatch. Every downstream
   * intercept and the final handler sharing this dispatch can read it back with
   * `inject`. Each dispatch starts with an empty store.
   */
  provide<T>(key: LocalKey<T>, value: T): void;
  /**
   * Read a value stored earlier in this dispatch with `provide`. Returns
   * `undefined` when nothing was stored for the key.
   */
  inject<T>(key: LocalKey<T>): T | undefined;

  /** Send an event to the current connection. Returns false if the socket can't accept it. */
  send<E extends keyof Outgoing<TSlots> & string>(event: E, payload: Outgoing<TSlots>[E]): boolean;
  /**
   * Send an event to every other connection on this server. The calling
   * connection is excluded by default; pass `includeSelf: true` to include it.
   */
  broadcast<E extends keyof Outgoing<TSlots> & string>(
    event: E,
    payload: Outgoing<TSlots>[E],
    options?: { includeSelf?: boolean },
  ): void;
};

/** The incoming/request payload one top-level event key narrows a frame to. */
type TopPayload<TSlots, TEvent extends string> = TEvent extends keyof Incoming<TSlots>
  ? Incoming<TSlots>[TEvent]
  : TEvent extends keyof Requests<TSlots>
    ? Requests<TSlots>[TEvent] extends { payload: infer P }
      ? P
      : unknown
    : unknown;

/** The incoming/request payload one channel-scoped key narrows a frame to. */
type ChannelPayload<
  TSlots,
  TFamily extends string,
  TEvent extends string,
> = TFamily extends keyof Channels<TSlots>
  ? Channels<TSlots>[TFamily] extends { incoming: infer I }
    ? TEvent extends keyof I
      ? I[TEvent]
      : ChannelRequestPayload<Channels<TSlots>[TFamily], TEvent>
    : ChannelRequestPayload<Channels<TSlots>[TFamily], TEvent>
  : unknown;

/** The request payload for a channel-scoped key, when the event is a channel request. */
type ChannelRequestPayload<TChannel, TEvent extends string> = TChannel extends {
  requests: infer R;
}
  ? TEvent extends keyof R
    ? R[TEvent] extends { payload: infer P }
      ? P
      : unknown
    : unknown
  : unknown;

/** The payload a `ctx.matches` / `ctx.unsafeCast` key narrows a frame to. */
type PayloadForKey<TSlots, TKey extends string> = TKey extends `@${infer Family}::${infer Event}`
  ? ChannelPayload<TSlots, Family, Event>
  : TopPayload<TSlots, TKey>;

/** An `InterceptFrame` whose `payload` is narrowed to the key's declared input type. */
type NarrowedFrame<TSlots, TKey extends string> = Omit<InterceptFrame, 'payload'> & {
  readonly payload: PayloadForKey<TSlots, TKey>;
};

/**
 * The frame-narrowing methods on every connection ctx — typed against the
 * server's event catalog so a matched frame's payload narrows to that event's
 * input type. Mainly used inside an intercept.
 */
export interface FrameMatchCtx<TSlots> {
  /**
   * Type guard narrowing an intercept `frame` to a declared event's payload.
   * Returns `true` when the frame's event, scope, and payload all match the
   * key; the payload is validated against the declared schema. Throws when the
   * key names no declared event. Channel-scoped keys use `@family::event`.
   */
  matches<TKey extends string>(
    key: TKey,
    frame: InterceptFrame,
  ): frame is NarrowedFrame<TSlots, TKey>;
  /**
   * Narrow an intercept `frame` without a runtime check — a type-only assertion
   * for when your own logic already established the payload's shape. Throws when
   * the key names no declared event. Channel-scoped keys use `@family::event`.
   */
  unsafeCast<TKey extends string>(key: TKey, frame: InterceptFrame): NarrowedFrame<TSlots, TKey>;
}

/** The wire metadata a replay resend carries so the client can dedup it. */
export interface ReplayWire {
  /** Monotonic sequence number for this replayed message. */
  readonly seq: number;
  /** Stable message id the client uses to dedup the replayed frame. */
  readonly messageId: string;
  /** The channel name, for a channel-scoped replay. */
  readonly channel?: string;
  /** The dynamic channel family key, or `null` for a static channel. */
  readonly channelFamily?: string | null;
}

/** The `ctx.sendReplay(...)` surface — owned by a replay capability. */
export interface SendReplayCtx<TSlots> {
  /**
   * Inject a synthetic replay frame for one outgoing event. Present only when a
   * replay capability is listed (`replay.history` / `replay.snapshot` /
   * `replay.custom`). Use it from a custom replay handler or to seed history;
   * `wire` carries the seq/messageId the client uses to dedup.
   */
  sendReplay(event: keyof Outgoing<TSlots> & string, payload: unknown, wire: ReplayWire): void;
}

/** The `ctx.schedule` / `ctx.cancelScheduled` surface — owned by `scheduled()`. */
export interface ScheduleCtx<TSlots> {
  /**
   * Queue a scheduled task to run once at `time` (unix ms). The body bound with
   * `base.scheduled(taskId, ...)` runs then, receiving `data`. Only tasks
   * declared by the `scheduled(...)` capability are accepted.
   */
  schedule<TTaskId extends keyof Scheduled<TSlots> & string>(
    taskId: TTaskId,
    options: Scheduled<TSlots>[TTaskId] extends undefined
      ? { time: number; data?: undefined }
      : { time: number; data: Scheduled<TSlots>[TTaskId] },
  ): void;
  /**
   * Cancel pending runs of a scheduled task. With no filter it cancels every
   * pending run; with a filter it cancels runs whose `data` matches its keys.
   */
  cancelScheduled<TTaskId extends keyof Scheduled<TSlots> & string>(
    taskId: TTaskId,
    filter?: Record<string, unknown>,
  ): void;
}

/** A tag ref handle, plus the broadcast arm when `requests()` is listed. */
type TagRefWithBroadcast<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[],
> = TagRefHandle<TMeta> &
  ('requests' extends BrandsOf<TCaps> ? BroadcastRequestArm<BroadcastServerRequests<TSlots>> : {});

/** A tag group handle, plus the broadcast arm (group + ref) when `requests()` is listed. */
type TagGroupWithBroadcast<TSlots, TMeta, TCaps extends readonly AnyCapability[]> = Omit<
  TagGroupHandle<TMeta>,
  'ref'
> & {
  ref(key: string): TagRefWithBroadcast<TSlots, TMeta, TCaps>;
} & ('requests' extends BrandsOf<TCaps>
    ? BroadcastRequestArm<BroadcastServerRequests<TSlots>>
    : {});

/** The `ctx.tags` surface — owned by the `tags()` capability. */
export interface TagsCtx<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Tag groups for this connection. `ephemeral(group)` / `persistent(group)`
   * return a handle to add, remove, count, and address connections by tag; only
   * groups declared by the `tags(...)` capability are accepted. With `requests()`
   * listed, the group and ref handles also carry `broadcastRequest(...)`.
   */
  readonly tags: Omit<
    TagsApi<keyof EphemeralTags<TSlots> & string, keyof PersistentTags<TSlots> & string, TMeta>,
    'ephemeral' | 'persistent'
  > & {
    ephemeral(
      group: keyof EphemeralTags<TSlots> & string,
    ): TagGroupWithBroadcast<TSlots, TMeta, TCaps>;
    persistent(
      group: keyof PersistentTags<TSlots> & string,
    ): TagGroupWithBroadcast<TSlots, TMeta, TCaps>;
  };
}

/**
 * A `ctx.channels.get(...)` handle, plus the broadcast arm when `requests()` is
 * listed. The arm resolves TOP-LEVEL broadcast requests (addressed to the named
 * channel's members): a top-level handler is typed from define-time slots and so
 * cannot see a channel's own request types — those exist only on the active
 * `ctx.channel` handle inside that channel's handler.
 */
type ChannelHandleForContext<
  TOutgoing extends Record<string, unknown>,
  TMeta,
  TGate extends boolean,
> = TGate extends true
  ? Omit<ChannelHandle<TOutgoing, TMeta>, 'inbox' | 'readReceipts'>
  : ChannelHandle<TOutgoing, TMeta>;

type ChannelsGetHandle<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TGate extends boolean,
> = ChannelHandleForContext<Record<string, unknown>, TMeta, TGate> &
  ('requests' extends BrandsOf<TCaps> ? BroadcastRequestArm<BroadcastServerRequests<TSlots>> : {});

/**
 * The fully-typed `ctx.channels.get(ref)` handle. `send`/`broadcast` are typed to
 * the referenced channel's emits, and `broadcastRequest` to its broadcast requests
 * when `requests()` is listed. The channel handle has no current connection, so
 * only the broadcast verb is added (not the targeted `request`).
 */
type TypedChannelsGetHandle<
  R,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TGate extends boolean,
> =
  R extends ChannelRef<infer TOutgoing extends Record<string, unknown>, infer TServerRequests>
    ? ChannelHandleForContext<TOutgoing, TMeta, TGate> &
        ('requests' extends BrandsOf<TCaps>
          ? BroadcastRequestArm<BroadcastServerRequests<{ serverRequests: TServerRequests }>>
          : {})
    : never;

/** The `ctx.channels` surface — owned by the `channels()` capability. */
export interface ChannelsCtx<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TGate extends boolean = false,
> {
  /**
   * Look up a channel to send into it, read its members, or ask its members a
   * broadcast request — from any handler.
   *
   * Pass a channel declaration (or a dynamic family's `.at(params)` ref) for a fully
   * typed handle: `send`/`broadcast` are checked against the channel's emits and
   * `broadcastRequest` against its requests. Pass a raw name (or `family, name`)
   * for the loose escape hatch when the name is only known at runtime.
   */
  readonly channels: {
    get<R extends ChannelRef>(ref: R): TypedChannelsGetHandle<R, TMeta, TCaps, TGate>;
    get(name: string): ChannelsGetHandle<TSlots, TMeta, TCaps, TGate>;
    get(family: string, name: string): ChannelsGetHandle<TSlots, TMeta, TCaps, TGate>;
  };
}

/** The type of `ctx.plugin(id)` for one plugin slice. */
type PluginApiOf<TSlice> = TSlice extends { __api: infer TApi } ? TApi : unknown;

/** The `ctx.plugin(id)` surface — owned by `plugin(...)` capabilities. */
export interface PluginCtx<TPlugins> {
  /**
   * Reach a registered plugin's API by its id. The id is typed to the plugins
   * actually listed, and the result is that plugin's `api` type — pass an explicit
   * type argument to override. A plugin id is unique (one plugin per id), so the
   * lookup is unambiguous; the API is built once per context and reused.
   */
  plugin<TId extends keyof TPlugins & string>(id: TId): PluginApiOf<TPlugins[TId]>;
  plugin<TApi = unknown>(id: string): TApi;
}

/** True when `T` is a non-empty record (the slot is actually declared). */
type HasKeys<T> = [keyof T] extends [never] ? false : true;

/**
 * The capability-owned ctx fields, intersected onto `CoreCtx` based on what the
 * server lists. Each fragment appears only when its owning capability is
 * present — gated by a feature flag, a builder brand, or a declared contract
 * slot. When a capability is absent, its ctx field does not exist on the type,
 * so reading it is a compile error (not a present-but-null field).
 *
 * @template TCaps The capabilities listed in `define({ capabilities: [...] })`.
 */
export type CtxExtensionsOf<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TGate extends boolean = false,
> = ('keepalive' extends FeaturesOf<TCaps> ? KeepaliveCtx : {}) &
  ('last-seen' extends FeaturesOf<TCaps> ? LastSeenCtx : {}) &
  ('requests' extends BrandsOf<TCaps> ? ServerRequestCtx<TSlots> : {}) &
  ('replay' extends FeaturesOf<TCaps>
    ? SendReplayCtx<TSlots>
    : 'replay-custom' extends BrandsOf<TCaps>
      ? SendReplayCtx<TSlots>
      : {}) &
  ('scheduled' extends BrandsOf<TCaps> ? ScheduleCtx<TSlots> : {}) &
  ('channels' extends BrandsOf<TCaps> ? ChannelsCtx<TSlots, TMeta, TCaps, TGate> : {}) &
  (HasKeys<EphemeralTags<TSlots>> extends true
    ? TagsCtx<TSlots, TMeta, TCaps>
    : HasKeys<PersistentTags<TSlots>> extends true
      ? TagsCtx<TSlots, TMeta, TCaps>
      : {}) &
  (HasKeys<Plugins<TSlots>> extends true ? PluginCtx<Plugins<TSlots>> : {});

/**
 * The `ctx` object every connection-scoped handler receives — the handlers you
 * register with `base.on(...)` and the connect/disconnect lifecycle hooks.
 *
 * `send` and `broadcast` are typed against the server's `emits(...)` events, so
 * a typo or wrong payload is a compile error. Capability-owned surfaces are
 * present only when their capability is listed (see `CtxExtensionsOf`).
 *
 * @template TSlots The merged contract slots — drives the typed `send`/`broadcast`.
 * @template TEnv   The platform env bindings, declared by `env: t<Env>()`.
 * @template TMeta  The per-connection metadata returned from `upgrade(...)`.
 * @template TCaps  The capabilities listed, gating the capability-owned ctx fields.
 */
export type AppCtx<
  TSlots,
  TEnv,
  TMeta,
  TCaps extends readonly AnyCapability[] = readonly [],
  TGate extends boolean = false,
> = CoreCtx<TSlots, TEnv, TMeta> &
  ConnectionsCtx<TSlots, TMeta, TCaps> &
  UsersCtx<TSlots, TMeta, TCaps> &
  FrameMatchCtx<TSlots> &
  CtxExtensionsOf<TSlots, TMeta, TCaps, TGate>;

/**
 * The `ctx` the `api` factory on `assemble({ handlers, api })` receives — the
 * connectionless admin surface, gated the same way {@link AppCtx} is.
 *
 * `schedule`/`cancelScheduled` and `channels` are owned by the `scheduled()`
 * and `channels()` capabilities, so they appear only when that capability is
 * listed. Without it the underlying engine service is absent and the operation
 * would quietly do nothing, so reading it is a compile error instead.
 *
 * `purgeUser` is deliberately not gated: it belongs to the admin surface
 * itself and no-ops when there is nothing durable to clean up.
 *
 * @template TSlots The merged contract slots — drives the typed `broadcast`.
 * @template TEnv   The platform env bindings, declared by `env: t<Env>()`.
 * @template TMeta  The per-connection metadata returned from `upgrade(...)`.
 * @template TCaps  The capabilities listed, gating the capability-owned fields.
 */
export type AdminCtx<
  TSlots,
  TEnv,
  TMeta,
  TCaps extends readonly AnyCapability[] = readonly [],
> = Omit<AdminContext<TEnv, TMeta, unknown, TSlots>, 'schedule' | 'cancelScheduled' | 'channels'> &
  ('scheduled' extends BrandsOf<TCaps> ? ScheduleCtx<TSlots> : {}) &
  ('channels' extends BrandsOf<TCaps>
    ? Pick<AdminContext<TEnv, TMeta, unknown, TSlots>, 'channels'>
    : {});

/** The server→client events, read off the merged contract slots. */
type Outgoing<TSlots> = SlotOr<TSlots, 'outgoing'>;

/** The client→server events (event → payload), read off the merged contract slots. */
type Incoming<TSlots> = SlotOr<TSlots, 'incoming'>;

/** The request events (event → { payload, response }), read off the merged contract slots. */
type Requests<TSlots> = SlotOr<TSlots, 'clientRequests'>;

/** The channel families (family → channel slice), read off the merged contract slots. */
type Channels<TSlots> = SlotOr<TSlots, 'channels'>;

/** The scheduled-task map (task id → payload type), read off the merged contract slots. */
type Scheduled<TSlots> = SlotOr<TSlots, 'scheduled'>;

/** The ephemeral tag-group map (group name → value type), read off the merged contract slots. */
type EphemeralTags<TSlots> = SlotOr<TSlots, 'ephemeralTags'>;

/** The persistent tag-group map (group name → value type), read off the merged contract slots. */
type PersistentTags<TSlots> = SlotOr<TSlots, 'persistentTags'>;

/** The per-plugin contract slices, read off the merged contract slots. */
type Plugins<TSlots> = SlotOr<TSlots, 'plugins'>;
