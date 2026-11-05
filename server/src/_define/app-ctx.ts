/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { BinaryInput } from '@livething/core';
import type {
  ChannelBroadcastArgs,
  ChannelHandle,
  ChannelInstance,
  ChannelRecipient,
  ConnectionInfo,
  ConnectionlessContext,
  ConnectionRef,
  KVProvider,
  Logger,
  SQLProvider,
  TagRef,
  UserInfo,
  UserRef,
} from '~/context.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { KeepaliveCtx } from '~/keepalive/ctx.ts';
import type { LastSeenCtx } from '~/last-seen/ctx.ts';
import type { LocalKey } from '~/local-key/local-key.ts';
import type { TagsApi } from '~/tags/types.ts';
import type { AnyCapability, BrandsOf, FeaturesOf, SlotOr } from './capability.ts';

/**
 * The key a channel's outgoing-event map carries its binary events under. It is only read by
 * types; it is a real, exported value so that TypeScript can name it in emitted `.d.ts` files.
 */
export const BINARY_EVENTS: unique symbol = Symbol('livething.binary-events');

/**
 * A channel's binary events (event → info), carried on its outgoing-event map under a
 * symbol key. `keyof … & string` leaves a symbol key out, so the JSON senders never see
 * a binary event, and the `.binary` senders read the events back with `BinaryEventsOf`.
 *
 * @internal
 */
// A type alias, not an interface: a `Record<string, unknown>` must still accept the map.
export type BinaryEventsCarrier<TBinary> = {
  readonly [BINARY_EVENTS]: TBinary;
};

/**
 * A channel's contract slice for its outgoing events: `outgoing` holds the JSON events, and
 * `binaryOutgoing` the binary ones when there are any. @internal
 */
export type ChannelOutgoingSlice<TOutgoing> =
  TOutgoing extends BinaryEventsCarrier<infer TBinary>
    ? { outgoing: Omit<TOutgoing, typeof BINARY_EVENTS>; binaryOutgoing: TBinary }
    : { outgoing: TOutgoing };

/** Add binary events to an outgoing-event map, or leave it as it is when there are none. @internal */
export type WithBinaryEvents<TOutgoing, TBinary> = [keyof TBinary] extends [never]
  ? TOutgoing
  : TOutgoing & BinaryEventsCarrier<TBinary>;

/**
 * The `.binary` senders of one kind of top-level sender when `binary()` is listed (its
 * capability adds the `binaryOutgoing` slot), else `never`, so any use of it is a compile
 * error. Each sender holds it as a property: a property type is only worked out when code
 * reads it, so a server without `binary()` pays almost nothing for the key.
 */
type BinarySendersOf<
  TSlots,
  TSenders extends 'ctx' | 'connection' | 'user' | 'broadcast',
> = TSlots extends { binaryOutgoing: infer TBinary } ? RootSenders<TBinary>[TSenders] : never;

interface RootSenders<TBinary> {
  ctx: CtxBinarySenders<TBinary>;
  connection: ConnectionBinarySenders<TBinary>;
  user: UserBinarySenders<TBinary>;
  broadcast: BroadcastBinarySenders<TBinary>;
}

/** The `.binary` key of connectionless code: `ctx.binary.broadcast` with `binary()` listed. */
interface ConnectionlessBinaryCtx<TSlots> {
  readonly binary: BinarySendersOf<TSlots, 'broadcast'>;
}

/** `ctx.binary`: the binary versions of `ctx.send` and `ctx.broadcast`. */
interface CtxBinarySenders<TBinary> {
  /**
   * Send a binary event to the current connection: its info, then its bytes. Returns
   * `false` when the platform adapter refused the frame.
   */
  send<E extends keyof TBinary & string>(event: E, info: TBinary[E], bytes?: BinaryInput): boolean;
  /** Send a binary event to every other connection; `includeSelf: true` adds the sender. */
  broadcast<E extends keyof TBinary & string>(
    event: E,
    info: TBinary[E],
    bytes?: BinaryInput,
    options?: { includeSelf?: boolean },
  ): void;
}

/** `ctx.connections.get(ref).binary`. */
interface ConnectionBinarySenders<TBinary> {
  /** Send a binary event to this connection only. `false` when it is no longer live. */
  send<E extends keyof TBinary & string>(event: E, info: TBinary[E], bytes?: BinaryInput): boolean;
}

/** `ctx.user.binary` / `ctx.users.get(id).binary`. */
interface UserBinarySenders<TBinary> {
  /** Send a binary event to every live socket the user holds. Returns the socket count. */
  broadcast<E extends keyof TBinary & string>(
    event: E,
    info: TBinary[E],
    bytes?: BinaryInput,
  ): number;
}

/** The `.binary` key of a channel handle: the binary versions of its senders. */
interface ChannelBinarySenders<TBinary> {
  /** Send a binary channel event to the calling connection. Returns `1` when delivered, else `0`. */
  send<E extends keyof TBinary & string>(event: E, info: TBinary[E], bytes?: BinaryInput): number;
  /** Send a binary channel event to a selected member audience. Returns the socket count. */
  broadcastTo<E extends keyof TBinary & string>(
    to: ChannelRecipient,
    event: E,
    info: TBinary[E],
    bytes?: BinaryInput,
  ): number;
  /** Send a binary channel event to its members, as one frame. The sender is left out by default. */
  broadcast<E extends keyof TBinary & string>(
    event: E,
    info: TBinary[E],
    bytes?: BinaryInput,
    options?: { includeSelf?: boolean },
  ): void;
}

/**
 * The `.binary` key of a channel handle: its senders when the channel declares binary
 * events, else `never`. Held as a property, so it costs nothing until code reads it.
 */
export interface ChannelBinaryArm<TOutgoing> {
  readonly binary: TOutgoing extends BinaryEventsCarrier<infer TBinary>
    ? ChannelBinarySenders<TBinary>
    : never;
}

/** The `broadcast`-only `.binary` key of a connectionless channel handle. */
interface ConnectionlessChannelBinaryArm<TOutgoing> {
  readonly binary: TOutgoing extends BinaryEventsCarrier<infer TBinary>
    ? BroadcastBinarySenders<TBinary>
    : never;
}

/** A `broadcast`-only `.binary` key: connectionless code has no caller to send to. */
interface BroadcastBinarySenders<TBinary> {
  /** Send a binary event to every member (or every connection), as one frame. */
  broadcast<E extends keyof TBinary & string>(
    event: E,
    info: TBinary[E],
    bytes?: BinaryInput,
  ): void;
}

/** The binary events the server's handlers receive (event → info). */
type BinaryIncoming<TSlots> = SlotOr<TSlots, 'binaryIncoming'>;

/**
 * A handle to one specific connection, returned by `ctx.connections.get(ref)`. Its
 * `send` is typed to the server's `emits(...)` events, so a typo or wrong
 * payload is a compile error.
 *
 * The handle is the seam for addressing one socket. It carries `send` and
 * `close` always;
 * the `serverRequests()` capability adds the `request` arm (see `ConnectionRequestHandle`).
 *
 * @template TSlots The merged contract slots — drives the typed `send`.
 */
interface ConnectionHandle<TSlots> {
  /**
   * Send an event to this connection only. Returns `false` when the connection
   * is no longer live on this instance.
   */
  send<E extends keyof Outgoing<TSlots> & string>(event: E, payload: Outgoing<TSlots>[E]): boolean;

  /** The binary version of `send`, with `binary()` listed. */
  readonly binary: BinarySendersOf<TSlots, 'connection'>;

  /** Close this connection only. No-op when the connection is no longer live. */
  close(code?: number, reason?: string): void;
}

/**
 * The server→client request map. A declaration with no `in` is an
 * acknowledgement — its response type is `void`.
 */
type ServerRequests<TSlots> = SlotOr<TSlots, 'serverRequests'>;

declare const CHANNEL_CONTRACT: unique symbol;

/**
 * A channel reference that `ctx.channels.get(...)` can fully type: a static
 * channel declaration passed directly, or a dynamic family's `.at(params)` result. The
 * phantom carries the channel's emit contract so the resolved handle types
 * `send`/`broadcastTo`/`broadcast` to that channel — never read at runtime.
 */
export interface ChannelRef<TOutgoing = Record<string, unknown>> {
  readonly [CHANNEL_CONTRACT]: { outgoing: TOutgoing };
}

/** What a user `request(...)` resolves to: the first valid answer and who gave it. */
interface UserRequestAnswer<R> {
  /** The first valid answer, validated against the request's `response` schema. */
  readonly response: R;
  /** The connection that answered first. */
  readonly from: ConnectionRef;
}

/**
 * The `request` arm a `serverRequests()` server adds to a `ctx.connections.get(ref)`
 * handle. The server asks one specific connection a declared server→client
 * request and awaits its typed answer.
 */
interface ConnectionRequestHandle<TSlots> extends ConnectionHandle<TSlots> {
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
 * `serverRequests()` capability. Server→client targeted requests: ask one connection
 * and await its typed answer.
 */
interface ServerRequestCtx<TSlots> {
  /**
   * Ask the current connection a declared server→client request and resolve its
   * typed answer. Rejects with `timeout`/`disconnected`/`request-invalid-response`.
   */
  request<E extends keyof ServerRequests<TSlots> & string>(
    event: E,
    payload: ServerRequests<TSlots>[E] extends { payload: infer P } ? P : never,
    options?: { timeout?: number },
  ): Promise<ServerRequests<TSlots>[E] extends { response: infer R } ? R : never>;
}

/**
 * The handle `ctx.connections.get(ref)` returns. It always carries the typed
 * `send`; with `serverRequests()` listed it also carries the typed `request(...)`,
 * gated on `TCaps` so the arm is a compile error otherwise.
 */
type ConnectionGetHandle<TSlots, TCaps extends readonly AnyCapability[]> =
  'serverRequests' extends BrandsOf<TCaps>
    ? ConnectionRequestHandle<TSlots>
    : ConnectionHandle<TSlots>;

/**
 * `ctx.connections`, always present. Reach one specific socket by ref with
 * `get(ref)`, or snapshot every live connection on this instance with `all()`.
 */
interface ConnectionsCtx<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  connections: {
    /**
     * Address one specific connection by ref. The handle always carries `send`;
     * with `serverRequests()` listed it also carries `request(...)`.
     */
    get(ref: ConnectionRef): ConnectionGetHandle<TSlots, TCaps>;
    /** Snapshot of every connection currently open on this server instance. */
    all(): ConnectionInfo<TMeta>[];
  };
}

/**
 * The `request` arm a `serverRequests()` server adds to a `UserHandle`. Asks every
 * live socket the user holds and settles on the first valid answer, reporting
 * which connection gave it via `from`.
 */
interface UserRequestArm<TSlots> {
  request<E extends keyof ServerRequests<TSlots> & string>(
    event: E,
    payload: ServerRequests<TSlots>[E] extends { payload: infer P } ? P : never,
    options?: { timeout?: number },
  ): Promise<
    UserRequestAnswer<ServerRequests<TSlots>[E] extends { response: infer R } ? R : never>
  >;
}

/**
 * A handle to one user — every live socket the user currently holds. `broadcast` fans
 * the event to all of them and returns how many sockets received it; `setMeta`
 * fans a metadata patch the same way. Typed to the server's `emits(...)` events.
 */
interface UserHandleBase<TSlots, TMeta> {
  /** The user id — the value `upgrade(...)` returned, or `''` on an anonymous connection. */
  readonly id: string;
  /** Build a `UserRef` for this user — pass it to `kick` and the like. */
  ref(): UserRef;
  /** Broadcast an event to every live socket the user holds. Returns the delivered socket count. */
  broadcast<E extends keyof Outgoing<TSlots> & string>(
    event: E,
    payload: Outgoing<TSlots>[E],
  ): number;
  /** The binary version of `broadcast`, with `binary()` listed. */
  readonly binary: BinarySendersOf<TSlots, 'user'>;
  /** Merge a metadata patch into every one of the user's live connections. */
  setMeta(patch: Partial<TMeta>): void;
  /** Snapshot the user's currently-live connections. */
  connections(): ConnectionInfo<TMeta>[];
  /** Close every one of the user's live sockets. */
  close(code?: number, reason?: string): void;
  /** A point-in-time snapshot of the user, or `null` when they have no live connection. */
  info(): UserInfo<TMeta> | null;
  /** Whether the user has a live connection on this server instance. Builds no snapshot. */
  isOnline(): boolean;
}

/** A `UserHandle`, plus the `request` arm when `serverRequests()` is listed. */
type UserHandleCtx<TSlots, TMeta, TCaps extends readonly AnyCapability[]> = UserHandleBase<
  TSlots,
  TMeta
> &
  ('serverRequests' extends BrandsOf<TCaps> ? UserRequestArm<TSlots> : {});

/**
 * `ctx.user` (the current connection's user) and `ctx.users` (reach any user by
 * id), always present. A user is one or more connections sharing the id
 * `upgrade(...)` returned. An anonymous connection has no user identity —
 * `ctx.user` is still there but reaches nobody.
 */
interface UsersCtx<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
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
 * @template TMeta  The per-connection metadata returned from `upgrade(...)`.
 */
type CoreCtx<TSlots, TMeta> = {
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
  /** The raw platform object from the adapter (on Cloudflare, `Platform<Env>`). Untyped by default. */
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

  /**
   * The binary versions of `send` and `broadcast`, with `binary()` listed. Without it the
   * key is `never`, so any use of it is a compile error. A property type is read only when
   * code uses it, so this costs a server without `binary()` almost nothing.
   */
  readonly binary: BinarySendersOf<TSlots, 'ctx'>;

  /**
   * Send an event to the current connection. Returns `true` when the frame was
   * handed to the socket, and `false` when the platform adapter refuses it or
   * strict replay could not store it.
   */
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
  : TEvent extends keyof BinaryIncoming<TSlots>
    ? BinaryIncoming<TSlots>[TEvent]
    : TopRequestPayload<TSlots, TEvent>;

/** The request payload one top-level event key narrows a frame to. */
type TopRequestPayload<TSlots, TEvent extends string> = TEvent extends keyof Requests<TSlots>
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
      : ChannelBinaryPayload<Channels<TSlots>[TFamily], TEvent>
    : ChannelBinaryPayload<Channels<TSlots>[TFamily], TEvent>
  : unknown;

/** The info a channel-scoped binary key narrows a frame to, else the request payload. */
type ChannelBinaryPayload<TChannel, TEvent extends string> = TChannel extends {
  binaryIncoming: infer B;
}
  ? TEvent extends keyof B
    ? B[TEvent]
    : ChannelRequestPayload<TChannel, TEvent>
  : ChannelRequestPayload<TChannel, TEvent>;

/** The request payload for a channel-scoped key, when the event is a channel request. */
type ChannelRequestPayload<TChannel, TEvent extends string> = TChannel extends {
  clientRequests: infer R;
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
interface FrameMatchCtx<TSlots> {
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
  /** The global delivery sequence number of the replayed message. */
  readonly deliverySeq: number;
  /** Stable message id the client uses to dedup the replayed frame. */
  readonly messageId: string;
}

/**
 * The `wire` of a top-level `ctx.sendReplay` that targets one channel.
 * `channel` is a static channel declaration, or a family declaration's
 * `.at(params)` ref — the same values `ctx.channels.get(...)` takes.
 */
interface ChannelReplayWire<R extends ChannelRef = ChannelRef> extends ReplayWire {
  /** The channel the replayed frame belongs to. */
  readonly channel: R;
}

/** The events (event → payload) a `ChannelRef` declares. */
type ChannelRefOutgoing<R> = R extends ChannelRef<infer TOutgoing> ? TOutgoing : never;

/** The `ctx.sendReplay(...)` surface — owned by a replay capability. */
interface SendReplayCtx<TSlots> {
  /**
   * Inject a synthetic replay frame for one top-level outgoing event. Present
   * only when a replay capability is listed (`replay.history` /
   * `replay.snapshot`). Use it to seed history; `wire`
   * carries the seq/messageId the client uses to dedup.
   */
  sendReplay<E extends keyof Outgoing<TSlots> & string>(
    event: E,
    payload: Outgoing<TSlots>[E],
    wire: ReplayWire,
  ): void;
  /**
   * Inject a synthetic replay frame for one channel's outgoing event. Name the
   * channel in `wire.channel` with its declaration (static channel) or
   * `.at(params)` ref (channel family); the event and payload are checked
   * against that channel's `emits(...)`.
   */
  sendReplay<R extends ChannelRef, E extends keyof ChannelRefOutgoing<R> & string>(
    event: E,
    payload: ChannelRefOutgoing<R>[E],
    wire: ChannelReplayWire<R>,
  ): void;
}

/** The `ctx.schedule` / `ctx.cancelScheduled` surface — owned by `scheduled()`. */
interface ScheduleCtx<TSlots> {
  /**
   * Queue a scheduled task to run once at `time` (unix ms). The body bound with
   * `base.scheduled(taskId, ...)` (passed to `assemble()`) runs then, receiving
   * `data`. Only tasks declared by the `scheduled(...)` capability are accepted.
   *
   * For a recurring (`every`) task that `cancelScheduled(taskId)` stopped, this
   * starts the task again: it runs at `time`, then every `every` ms after that.
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
   *
   * With no filter, a recurring (`every`) task is stopped: it does not come
   * back after a restart or a wake from hibernation. Call
   * `schedule(taskId, { time })` to start it again.
   */
  cancelScheduled<TTaskId extends keyof Scheduled<TSlots> & string>(
    taskId: TTaskId,
    filter?: Record<string, unknown>,
  ): void;
}

/** The `ctx.tags` surface — owned by the `tags()` capability. */
interface TagsCtx<TSlots, TMeta> {
  /**
   * Tag groups for this connection. `ephemeral(group)` / `persistent(group)`
   * return a handle to add, remove, count, and address connections by tag; only
   * groups declared by the `tags(...)` capability are accepted.
   */
  readonly tags: TagsApi<
    keyof EphemeralTags<TSlots> & string,
    keyof PersistentTags<TSlots> & string,
    TMeta,
    TSlots
  >;
}

/** A `ctx.channels.get(...)` handle; gate callbacks get it without `inbox`/`readReceipts`. */
type ChannelHandleForContext<
  TOutgoing extends Record<string, unknown>,
  TMeta,
  TGate extends boolean,
> = (TGate extends true
  ? Omit<ChannelHandle<TOutgoing, TMeta>, 'inbox' | 'readReceipts'>
  : ChannelHandle<TOutgoing, TMeta>) &
  ChannelBinaryArm<TOutgoing>;

/**
 * The fully-typed `ctx.channels.get(ref)` handle. `send`/`broadcastTo`/`broadcast`
 * are typed to the referenced channel's emits.
 */
type TypedChannelsGetHandle<R, TMeta, TGate extends boolean> =
  R extends ChannelRef<infer TOutgoing extends Record<string, unknown>>
    ? ChannelHandleForContext<TOutgoing, TMeta, TGate>
    : never;

/** The `ctx.channels` surface — owned by the `channels()` capability. */
interface ChannelsCtx<TMeta, TGate extends boolean = false> {
  /**
   * Look up a channel to send into it or read its members — from any handler.
   *
   * Pass a channel declaration (or a dynamic family's `.at(params)` ref) for a fully
   * typed handle: `send`/`broadcastTo`/`broadcast` are checked against the channel's
   * emits. Pass a raw name (or `family, name`) for the loose escape hatch when the
   * name is only known at runtime.
   */
  readonly channels: {
    get<R extends ChannelRef>(ref: R): TypedChannelsGetHandle<R, TMeta, TGate>;
    get(name: string): ChannelHandleForContext<Record<string, unknown>, TMeta, TGate>;
    get(
      family: string,
      name: string,
    ): ChannelHandleForContext<Record<string, unknown>, TMeta, TGate>;
  };
}

/** The type of `ctx.plugin(id)` for one plugin slice. */
type PluginApiOf<TSlice> = TSlice extends { __api: infer TApi } ? TApi : unknown;

/** The `ctx.plugin(id)` surface — owned by `plugin(...)` capabilities. */
interface PluginCtx<TPlugins> {
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
 * @template TCaps The capabilities listed in `server({ capabilities: [...] })`.
 */
type CtxExtensionsOf<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TGate extends boolean = false,
> = ('keepalive' extends FeaturesOf<TCaps> ? KeepaliveCtx : {}) &
  ('last-seen' extends FeaturesOf<TCaps> ? LastSeenCtx : {}) &
  ('serverRequests' extends BrandsOf<TCaps> ? ServerRequestCtx<TSlots> : {}) &
  ('replay' extends FeaturesOf<TCaps> ? SendReplayCtx<TSlots> : {}) &
  ('scheduled' extends BrandsOf<TCaps> ? ScheduleCtx<TSlots> : {}) &
  ('channels' extends BrandsOf<TCaps> ? ChannelsCtx<TMeta, TGate> : {}) &
  (HasKeys<EphemeralTags<TSlots>> extends true
    ? TagsCtx<TSlots, TMeta>
    : HasKeys<PersistentTags<TSlots>> extends true
      ? TagsCtx<TSlots, TMeta>
      : {}) &
  (HasKeys<Plugins<TSlots>> extends true ? PluginCtx<Plugins<TSlots>> : {});

/**
 * The `ctx` object every connection-scoped handler receives — the handlers you
 * register with `base.on(...)` and the connect/disconnect lifecycle hooks.
 *
 * `send`, `broadcastTo`, and `broadcast` are typed against the server's `emits(...)` events, so
 * a typo or wrong payload is a compile error. Capability-owned surfaces are
 * present only when their capability is listed (see `CtxExtensionsOf`).
 *
 * @template TSlots The merged contract slots — drives the typed `send`/`broadcast`.
 * @template TMeta  The per-connection metadata returned from `upgrade(...)`.
 * @template TCaps  The capabilities listed, gating the capability-owned ctx fields.
 */
export type AppCtx<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[] = readonly [],
  TGate extends boolean = false,
> = CoreCtx<TSlots, TMeta> &
  ConnectionsCtx<TSlots, TMeta, TCaps> &
  UsersCtx<TSlots, TMeta, TCaps> &
  FrameMatchCtx<TSlots> &
  CtxExtensionsOf<TSlots, TMeta, TCaps, TGate>;

/** The events one declared channel emits, read off its key in the contract slots. */
type ChannelOutgoingOf<TSlots, K> = K extends keyof Channels<TSlots>
  ? Channels<TSlots>[K] extends { outgoing: infer O extends Record<string, unknown> }
    ? Channels<TSlots>[K] extends { binaryOutgoing: infer B }
      ? O & BinaryEventsCarrier<B>
      : O
    : Record<string, unknown>
  : Record<string, unknown>;

/**
 * A channel handle with no connection in scope. `broadcast` is typed to the
 * channel's own `emits(...)` events, and `binary.broadcast` to its `binary({ emits })`.
 */
type ConnectionlessChannelHandleCtx<TOutgoing, TMeta> = ConnectionlessChannelHandleBase<
  TOutgoing,
  TMeta
> &
  ConnectionlessChannelBinaryArm<TOutgoing>;

interface ConnectionlessChannelHandleBase<TOutgoing, TMeta> {
  /** Broadcast a channel event to its members. */
  broadcast<E extends keyof TOutgoing & string>(event: E, payload: TOutgoing[E]): void;
  /** Snapshot of the channel's members. */
  members(): ConnectionInfo<TMeta>[];
  /**
   * Remove a user (or everyone holding a tag) from this channel for good. The
   * durable membership row is dropped, so the user does not auto-rejoin on
   * reconnect.
   */
  kick(target: UserRef | TagRef, opts: { reason: string }): Promise<void>;
}

/**
 * `ctx.channels` with no connection in scope — owned by the `channels()`
 * capability. Pass a channel declaration (or a family's `.at(params)` ref), or
 * the name of a channel this definition declares, for a handle whose
 * `broadcast` is checked against that channel's emits. Any other name gets the
 * loose handle, for names only known at runtime.
 */
interface ConnectionlessChannelsCtx<TSlots, TMeta> {
  readonly channels: {
    get<R extends ChannelRef>(ref: R): ConnectionlessChannelHandleCtx<ChannelRefOutgoing<R>, TMeta>;
    get<K extends keyof Channels<TSlots> & string>(
      name: K,
    ): ConnectionlessChannelHandleCtx<ChannelOutgoingOf<TSlots, K>, TMeta>;
    get<K extends keyof Channels<TSlots> & string>(
      family: K,
      instance: string,
    ): ConnectionlessChannelHandleCtx<ChannelOutgoingOf<TSlots, K>, TMeta>;
    get(name: string): ConnectionlessChannelHandleCtx<Record<string, unknown>, TMeta>;
    get(
      family: string,
      instance: string,
    ): ConnectionlessChannelHandleCtx<Record<string, unknown>, TMeta>;
    /**
     * Broadcast a channel event to that channel's members. Name a static
     * channel by its name, or a family's channel by `{ family, name }`. The
     * event and payload are checked against that channel's emits.
     */
    broadcast(...args: ChannelBroadcastArgs<Channels<TSlots>>): void;
    /**
     * The binary version of `broadcast`, with `binary()` listed (else `never`). Name the
     * channel as for `broadcast`; the info is checked against the channel's `binary({ emits })`.
     */
    readonly binary: TSlots extends { binaryOutgoing: unknown }
      ? ConnectionlessChannelsBinary<TSlots>
      : never;
  };
}

/** `ctx.channels.binary` with no connection in scope. */
interface ConnectionlessChannelsBinary<TSlots> {
  broadcast(...args: ChannelBinaryBroadcastArgs<Channels<TSlots>>): void;
}

/** The `(channel, event, info, bytes?)` tuples `channels.binary.broadcast` takes. */
type ChannelBinaryBroadcastArgs<TChannels> = string extends keyof TChannels
  ? [channel: string | ChannelInstance, event: string, info: unknown, bytes?: BinaryInput]
  : {
      [K in keyof TChannels & string]: TChannels[K] extends {
        binaryOutgoing: infer TBinary;
        __addressing: infer TAddressing;
      }
        ? {
            [E in keyof TBinary & string]: [
              channel: TAddressing extends 'dynamic' ? ChannelInstance<K> : K,
              event: E,
              info: TBinary[E],
              bytes?: BinaryInput,
            ];
          }[keyof TBinary & string]
        : never;
    }[keyof TChannels & string];

/** `ctx.connections` and `ctx.users` with no connection in scope, typed to the server's emits. */
interface ConnectionlessManagersCtx<TSlots, TMeta> {
  /** Reach one connection by ref with `get(ref)`, or snapshot every live connection with `all()`. */
  connections: {
    get(ref: ConnectionRef): ConnectionHandle<TSlots>;
    all(): ConnectionInfo<TMeta>[];
  };
  /** Reach any user by id with `get(id)` to fan out to every socket they hold. */
  users: { get(id: string): UserHandleBase<TSlots, TMeta> };
}

/**
 * The `ctx` for code with no connection in scope — `onShutdown` hooks,
 * scheduled task bodies, and the `api` factory on `assemble({ handlers, api })`
 * — gated the same way {@link AppCtx} is.
 *
 * `schedule`/`cancelScheduled` and `channels` are owned by the `scheduled()`
 * and `channels()` capabilities, so they appear only when that capability is
 * listed. Without it the underlying engine service is absent and the operation
 * would quietly do nothing, so reading it is a compile error instead.
 *
 * `purgeUser` is deliberately not gated: it belongs to the context itself and
 * no-ops when there is nothing durable to clean up.
 *
 * @template TSlots The merged contract slots — drives the typed `broadcast` and `send`.
 * @template TMeta  The per-connection metadata returned from `upgrade(...)`.
 * @template TCaps  The capabilities listed, gating the capability-owned fields.
 */
export type ConnectionlessCtx<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[] = readonly [],
> = Omit<
  ConnectionlessContext<TMeta, unknown, TSlots>,
  'schedule' | 'cancelScheduled' | 'channels' | 'connections' | 'users'
> &
  ConnectionlessManagersCtx<TSlots, TMeta> &
  ConnectionlessBinaryCtx<TSlots> &
  ('scheduled' extends BrandsOf<TCaps> ? ScheduleCtx<TSlots> : {}) &
  ('channels' extends BrandsOf<TCaps> ? ConnectionlessChannelsCtx<TSlots, TMeta> : {});

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
