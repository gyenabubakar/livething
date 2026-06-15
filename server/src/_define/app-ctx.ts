/* oxlint-disable @typescript-eslint/no-explicit-any */
import type {
  ChannelHandle,
  ConnectionInfo,
  ConnectionRef,
  KVProvider,
  Logger,
  SQLProvider,
} from '~/context.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { KeepaliveCtx } from '~/keepalive/ctx.ts';
import type { LocalKey } from '~/local-key/local-key.ts';
import type { TagsApi } from '~/tags/types.ts';
import type { AnyCapability, BrandsOf, FeaturesOf, SlotOr } from './capability.ts';

/**
 * The connection-scoped surface present on **every** server, whatever
 * capabilities are listed. Identity, metadata, storage, messaging, and logging
 * always exist. Capability-owned surfaces (`ctx.tags`, `ctx.channels`,
 * `ctx.schedule`, `ctx.ack`, `ctx.latency`/`ctx.quality`, `ctx.plugin`) are NOT
 * here — each is added by `CtxExtensionsOf` only when its capability is listed,
 * so reading one without its capability is a compile error.
 *
 * @template TSlots The merged contract slots — drives the typed `send`/`broadcast`.
 * @template TEnv   The platform env bindings, declared by `env: t<Env>()`.
 * @template TMeta  The per-connection metadata returned from `upgrade(...)`.
 */
export type CoreCtx<TSlots, TEnv, TMeta> = {
  /** Unique id of this connection. Stable for the lifetime of the socket. */
  readonly id: string;
  /** The identity string returned from `upgrade(...)`. Stable until disconnect. */
  readonly identity: string;
  /** A reference handle to this connection — pass it to `kick`, `subscribe`, and the like. */
  readonly self: ConnectionRef;
  /** The metadata returned from `upgrade(...)`, typed from its return value. */
  readonly meta: TMeta;
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

  /** Send an event to one other connection by id. Returns false if it is not here. */
  sendToConnection(connectionId: string, event: string, payload: unknown): boolean;
  /** Close this connection. */
  close(code?: number, reason?: string): void;
  /** Snapshot of every connection currently open on this server instance. */
  getConnections(): ConnectionInfo<TMeta>[];

  /** Adapter-provided SQL surface. Throws if the adapter has no storage. */
  readonly sql: SQLProvider;
  /** Adapter-provided key/value surface. Throws if the adapter has no storage. */
  readonly kv: KVProvider;
  /** Engine logger — `info` / `warn` / `error`. */
  readonly log: Logger;
  /** Keep a promise running past the end of the handler (for example Cloudflare `waitUntil`). */
  waitUntil(promise: Promise<unknown>): void;
  /** Set the next alarm on the adapter's timer surface (unix ms). */
  setAlarm(time: number): void;

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
   * connection is excluded by default; pass `excludeSelf: false` to include it.
   */
  broadcast<E extends keyof Outgoing<TSlots> & string>(
    event: E,
    payload: Outgoing<TSlots>[E],
    options?: { excludeSelf?: boolean },
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
  readonly channelScope?: string | null;
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

/** The `ctx.ack()` surface — owned by the `ack()` capability. */
export interface AckCtx {
  /**
   * Confirm receipt of a client message that was sent with an ack. Present only
   * when the `ack()` capability is listed.
   */
  ack(): void;
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

/** The `ctx.tags` surface — owned by the `tags()` capability. */
export interface TagsCtx<TSlots, TMeta> {
  /**
   * Tag groups for this connection. `ephemeral(group)` / `persistent(group)`
   * return a handle to add, remove, count, and address connections by tag; only
   * groups declared by the `tags(...)` capability are accepted.
   */
  readonly tags: TagsApi<
    keyof EphemeralTags<TSlots> & string,
    keyof PersistentTags<TSlots> & string,
    TMeta
  >;
}

/** The `ctx.channels` surface — owned by the `channels()` capability. */
export interface ChannelsCtx<TMeta> {
  /**
   * Look up a channel by name (or family + name) to send into it or read its
   * members from outside a channel handler.
   */
  readonly channels: {
    get(name: string): ChannelHandle<Record<string, unknown>, TMeta>;
    get(family: string, name: string): ChannelHandle<Record<string, unknown>, TMeta>;
  };
}

/** The type of `ctx.plugin(id)` for one plugin slice. */
type PluginApiOf<TSlice> = TSlice extends { __api: infer TApi } ? TApi : unknown;

/** The `ctx.plugin(id)` surface — owned by `plugin(...)` capabilities. */
export interface PluginCtx<TPlugins> {
  /**
   * Reach a registered plugin's per-connection API by its id. The id is typed to
   * the plugins actually listed, and the result is that plugin's `api` type. Pass
   * an explicit type argument to override, or `registrationId` to select an
   * instance when the same plugin is registered more than once.
   */
  plugin<TId extends keyof TPlugins & string>(
    id: TId,
    registrationId?: string,
  ): PluginApiOf<TPlugins[TId]>;
  plugin<TApi = unknown>(id: string, registrationId?: string): TApi;
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
> = ('keepalive' extends FeaturesOf<TCaps> ? KeepaliveCtx : {}) &
  ('ack' extends FeaturesOf<TCaps> ? AckCtx : {}) &
  ('replay' extends FeaturesOf<TCaps>
    ? SendReplayCtx<TSlots>
    : 'replay-custom' extends BrandsOf<TCaps>
      ? SendReplayCtx<TSlots>
      : {}) &
  ('scheduled' extends BrandsOf<TCaps> ? ScheduleCtx<TSlots> : {}) &
  ('channels' extends BrandsOf<TCaps> ? ChannelsCtx<TMeta> : {}) &
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
> = CoreCtx<TSlots, TEnv, TMeta> & FrameMatchCtx<TSlots> & CtxExtensionsOf<TSlots, TMeta, TCaps>;

/** The server→client events, read off the merged contract slots. */
type Outgoing<TSlots> = SlotOr<TSlots, 'outgoing'>;

/** The client→server events (event → payload), read off the merged contract slots. */
type Incoming<TSlots> = SlotOr<TSlots, 'incoming'>;

/** The request events (event → { payload, response }), read off the merged contract slots. */
type Requests<TSlots> = SlotOr<TSlots, 'requests'>;

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
