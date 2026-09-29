/* oxlint-disable @typescript-eslint/no-explicit-any */
import { collectUnique } from '~/_engine/compile/utils.ts';
import { assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import { adaptChannelContext } from '~/channel/ctx-adapter.ts';
import { hibernation as hibernationFactory } from '~/hibernation/hibernation.ts';
import { incoming as incomingFactory } from '~/incoming/incoming.ts';
import {
  intercept as interceptFactory,
  outgoingHook as outgoingHookFactory,
} from '~/intercept/intercept.ts';
import {
  onConnect,
  onDisconnect,
  onError,
  onInit,
  onPing,
  onPong,
  onShutdown,
  onUpgrade,
  onValidationError,
} from '~/lifecycle/lifecycle.ts';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { ChannelBuilder, ChannelHandlerValue } from '~/channel/capability.ts';
import type { ExtractParams } from '~/channel/channel.ts';
import type {
  ChannelInbox,
  ChannelReadReceipts,
  ChannelRecipient,
  ConnectionInfo,
  ConnectionRef,
  InitContext,
  ShutdownContext,
  TagRef,
  TaskContext,
  UserRef,
} from '~/context.ts';
import type { EmitDefs, EmitsCapability } from '~/emits/emits.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { InterceptFrame, OutgoingFrame } from '~/intercept/intercept.ts';
import type { UpgradeHandler, UpgradeResult } from '~/lifecycle/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';
import type { RateLimitCapability } from '~/rate-limit/capability.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';
import type {
  ChannelCustomReplayHooks,
  CustomReplayHooks,
  ReplayCustomCapability,
} from '~/replay/capability.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { ResolvedServerRequest, ServerRequestsCapability } from '~/request/server-requests.ts';
import type { ScheduledCapability, ScheduledDeclaration } from '~/scheduled/capability.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { TranslatorFactory } from '~/translation/translator.ts';
import type { Validator } from '~/types.ts';
import { assertUniqueCapabilityKinds } from './capability-checks.ts';
import { resolveCapabilityRequirements } from './capability-requirements.ts';
// Keep every value import off `./plugins.ts` — it is a package entry, so a
// bundler retains it whole, and one binding would pull the plugin runtime into apps
// that list no plugins. Type imports are free.
import {
  assertNoChannelOnlyCapabilities,
  assertPluginDependencies,
  assertUniquePluginIds,
} from './plugin-checks.ts';
import type {
  AdminCtx,
  AppCtx,
  BroadcastRequestArm,
  BroadcastServerRequests,
  ChannelRef,
  ReplayWire,
  SelfBroadcastRequestOptions,
} from './app-ctx.ts';
import type {
  AnyCapability,
  BrandIsWidened,
  BrandsOf,
  ChannelOnlyCapability,
  Contribution,
  MergeSlots,
  SlotOr,
  SlotsOf,
  UniqueCapabilityKinds,
} from './capability.ts';
import type { BuildContract, InferInput } from './contract.ts';

type OptsParameter = { reason: string; revoke?: boolean };
type ServerRequestConfigParameter = {
  input?: Validator;
  allowInterleaving?: boolean;
  rateLimit?: RateLimitConfig;
  run: (ctx: any, input: any) => unknown;
};
type ServerCParameter = {
  input?: Validator;
  allowInterleaving?: boolean;
  run: ServerRequestConfigParameter['run'];
};
type ServerConfigParameter = { run: (ctx: any, data?: unknown) => void | Promise<void> };
type ServerAssembleConfigParameter = {
  handlers: readonly Contribution[];
  api?: (ctx: unknown) => unknown;
};

/**
 * What an `upgrade(...)` function returns to accept a connection. Return a
 * `userId` (the stable per-user key) and optional `meta`. Throw
 * `RejectUpgrade(code, reason)` to refuse the handshake.
 *
 * `tags.ephemeral` seeds initial ephemeral tags before any handler runs — the
 * keys are the ephemeral group names declared by the `tags(...)` capability.
 * Persistent tags cannot be set here; add them at runtime with
 * `ctx.tags.persistent(group).add(key)`.
 */
export interface UpgradeReturn<TMeta, TEphemeralGroups extends string = string> {
  /**
   * Stable key for the user behind this socket — used as the row key for durable
   * state. Omit it (or return `undefined`) to accept the connection as
   * **anonymous**: no user identity at all, with no cross-reconnect
   * recognition and no durable state.
   */
  readonly userId?: string;
  /** Per-connection metadata, surfaced as `ctx.meta` in every handler. */
  readonly meta?: TMeta;
  /** Initial ephemeral tags to attach: `{ ephemeral: { group: key } }`. */
  readonly tags?: { readonly ephemeral?: Partial<Record<TEphemeralGroups, string>> };
}

/**
 * The `upgrade(...)` function shape. Receives the raw upgrade request and a
 * `ctx` with storage, a logger and the platform. The same shape as the `onInit`
 * context: no connection exists yet, so there is no user, `meta` or `send`.
 */
export type UpgradeFn<TMeta, TEphemeralGroups extends string = string> = (
  request: Request,
  ctx: InitContext,
) => UpgradeReturn<TMeta, TEphemeralGroups> | Promise<UpgradeReturn<TMeta, TEphemeralGroups>>;

/** A plugin's `upgrade(...)`. It sees only the raw request, never the app's storage. */
export type ScopedUpgradeFn<TMeta, TEphemeralGroups extends string = string> = (
  request: Request,
) => UpgradeReturn<TMeta, TEphemeralGroups> | Promise<UpgradeReturn<TMeta, TEphemeralGroups>>;

/** The ephemeral tag-group names declared across a list of capabilities. */
type EphemeralGroupsOf<TCaps extends readonly AnyCapability[]> = keyof SlotOr<
  MergeSlots<SlotsOf<TCaps[number]>>,
  'ephemeralTags'
> &
  string;

/**
 * The configuration passed to `server(...)`. Holds only bootstrap — the things
 * the runtime needs to exist and accept a connection. Every feature beyond this
 * is an entry in `capabilities`.
 */
export interface ServerConfig<
  TMeta = unknown,
  // Defaults to no capabilities, not to every capability. `server(...)` infers
  // the real list from the config it is given; the default only applies when
  // this type is written out by hand, and a list of `AnyCapability` there would
  // widen every capability brand to `string` — making the ctx gating pass for
  // capabilities the server never listed.
  TCaps extends readonly AnyCapability[] = readonly [],
> {
  /** Auth gate. Return `{ userId, meta }` to accept, or throw `RejectUpgrade(...)` to deny. */
  readonly upgrade?: UpgradeFn<TMeta, EphemeralGroupsOf<TCaps>>;
  /** Turn on Cloudflare Durable Object hibernation (which disables server pings). */
  readonly hibernation?: { readonly enabled: boolean };
  /** Translate one foreign WebSocket wire format into LiveThing at this server's connection edge. */
  readonly translate?: TranslatorFactory;
  /**
   * Cap how many live connections one user may hold at once. `onExceed` decides
   * what a would-be breaching connection does: `reject` refuses the newcomer
   * (closed with `CAPACITY`), `replace` evicts the user's oldest connection(s)
   * to make room (each closed with `DUPLICATE`). Omit for unlimited; when set it
   * must be a positive whole number. Anonymous connections (no `userId`) have no
   * user identity to count against and are never capped.
   */
  readonly users?: { readonly maxConnections?: number; readonly onExceed: 'replace' | 'reject' };
  /** The features this server uses. Listing one pulls its engine code into the bundle. */
  readonly capabilities?: TCaps & UniqueCapabilityKinds<TCaps>;
  /**
   * Always absent on an app server. A scoped builder sets it instead — today
   * only `'plugin'`.
   */
  readonly scope?: undefined;
}

/**
 * A capability a plugin is allowed to list — every capability except a
 * host-owned one. Host-owned engines (`dedup`/`sequence`/`keepalive`/
 * `rateLimit`/`replay`) carry a `__hostOnly` marker, so listing one inside
 * `server({ scope: 'plugin' })` is a compile error. A plugin declares a
 * prerequisite on them instead.
 */
export type PluginSafeCapability = AnyCapability & { __hostOnly?: never };

/**
 * A capability accepted at the host or plugin top level — every capability
 * except a channel-only one. Channel-only capabilities (`inbox()`,
 * `readReceipts()`) carry a `__channelOnly` marker, so listing one in
 * `server({ capabilities })` or `server({ scope: 'plugin', capabilities })` is
 * a compile error — they only belong inside a channel's own `capabilities`.
 */
export type TopLevelCapability = AnyCapability & { __channelOnly?: never };

/**
 * The configuration for a **plugin's** scoped server definition (`scope: 'plugin'`).
 * Authored with the same builders as an app, but it declares only its own
 * namespaced slice and inherits the host's transport and global singletons. The
 * plugin cannot own host-level
 * capabilities (see `plugin(...)`).
 */
export interface ScopedServerConfig<
  TMeta = unknown,
  TCaps extends readonly PluginSafeCapability[] = readonly PluginSafeCapability[],
> {
  /** Marks this as a plugin's scoped server definition. */
  readonly scope: 'plugin';
  /**
   * The plugin's upgrade gate. Runs before the app's upgrade in the inbound
   * onion: it sees only the raw request, not the app's identity. Return
   * `meta` (shallow-merged, app wins on key conflict) and/or `tags`
   * (concatenated); throw `RejectUpgrade(...)` to veto the handshake. A plugin
   * may own `userId` — but only one upgrade hook (the app's or one plugin's)
   * may return it, or the build/runtime errors.
   */
  readonly upgrade?: ScopedUpgradeFn<TMeta, EphemeralGroupsOf<TCaps>>;
  /** The features this plugin uses. Host-owned capabilities are a compile error here. */
  readonly capabilities?: TCaps & UniqueCapabilityKinds<TCaps>;
}

/** Reads the capabilities from an inferred scoped config object. @internal */
type ScopedCapabilitiesOf<TConfig> = TConfig extends {
  readonly capabilities?: infer TCaps;
}
  ? TCaps extends readonly AnyCapability[]
    ? TCaps
    : readonly []
  : readonly [];

/** Keeps excess-property checks when a scoped config is inferred through a generic. @internal */
type NoExtraScopedConfigKeys<TConfig> = {
  readonly [K in Exclude<keyof TConfig, keyof ScopedServerConfig>]: never;
};

/** The value `base.on(...)` returns — a handler primitive that also declares its contract slot. */
export type IncomingHandlerValue<TEvent extends string, TPayload> = IncomingPrimitive<
  TEvent,
  TPayload
> &
  Contribution<{ incoming: Record<TEvent, TPayload> }>;

/**
 * The per-handler / channel-level `rateLimit?` field, present only when the
 * `rateLimit()` capability is listed. Absent otherwise, so passing a `rateLimit`
 * override without the capability is a compile-time excess-property error rather
 * than a boot-time throw.
 */
export type RateLimitField<TCaps extends readonly AnyCapability[]> =
  'rateLimit' extends BrandsOf<TCaps>
    ? {
        /** Per-handler rate-limit override — tighten, loosen, or disable the limit for this event. */
        readonly rateLimit?: RateLimitConfig;
      }
    : {};

/** Configuration object for `base.on(...)`. */
export type OnConfig<
  TSlots,
  TMeta,
  TSchema extends Validator | undefined,
  TCaps extends readonly AnyCapability[] = readonly [],
> = {
  /** Optional schema validating the incoming payload. Omit to accept any payload (typed `unknown`). */
  readonly input?: TSchema;
  /** Run this handler alongside earlier work on the same connection. Defaults to ordered execution. */
  readonly allowInterleaving?: boolean;
  /** Runs each time the client sends this event, with the validated payload. */
  run(ctx: AppCtx<TSlots, TMeta, TCaps>, input: InferInput<TSchema>): void | Promise<void>;
} & RateLimitField<TCaps>;

/** The value `base.request(...)` returns — a handler primitive that declares its request slot. */
export type RequestHandlerValue<TEvent extends string, TPayload, TResponse> = RequestPrimitive<
  TEvent,
  TPayload,
  TResponse
> &
  Contribution<{ clientRequests: Record<TEvent, { payload: TPayload; response: TResponse }> }>;

/** Configuration object for `base.request(...)`. */
export type RequestConfig<
  TSlots,
  TMeta,
  TSchema extends Validator | undefined,
  TResponse,
  TCaps extends readonly AnyCapability[] = readonly [],
> = {
  /** Optional schema validating the request payload. Omit to accept any payload (typed `unknown`). */
  readonly input?: TSchema;
  /** Run this request alongside earlier work on the same connection. Defaults to interleaved execution. */
  readonly allowInterleaving?: boolean;
  /** Runs the request and returns the reply. The reply type is inferred from the return. */
  run(
    ctx: AppCtx<TSlots, TMeta, TCaps>,
    input: InferInput<TSchema>,
  ): TResponse | Promise<TResponse>;
} & RateLimitField<TCaps>;

/** Builder method granted by the `clientRequests()` capability. */
export interface RequestMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Create a handler value for one client→server request. Like `base.on`, but the
   * client awaits a reply: whatever the handler returns becomes the response,
   * and its type is inferred from the return. Returning nothing rejects the
   * client's pending request. Pass the returned value to `assemble()` to activate it.
   */
  request<
    TEvent extends string,
    TSchema extends Validator | undefined = undefined,
    TResponse = void,
  >(
    event: TEvent,
    config: RequestConfig<TSlots, TMeta, TSchema, TResponse, TCaps>,
  ): RequestHandlerValue<TEvent, InferInput<TSchema>, Awaited<TResponse>>;
}

/** The scheduled-task map (task id → payload type), read off the merged contract slots. */
type ScheduledMap<TSlots> = SlotOr<TSlots, 'scheduled'>;

/** Configuration object for `base.scheduled(...)`. */
export interface ScheduledConfig<TMeta, TData> {
  /** Runs when the task fires. Receives the typed payload for tasks that declare one. */
  run: TData extends undefined
    ? (ctx: TaskContext<TMeta>) => void | Promise<void>
    : (ctx: TaskContext<TMeta>, data: TData) => void | Promise<void>;
}

/** Builder method granted by the `scheduled()` capability. */
export interface ScheduledMethods<TSlots, TMeta> {
  /**
   * Register the body for one declared scheduled task. The task id and its
   * payload type come from the `scheduled(...)` capability; binding an
   * undeclared task is a type error.
   */
  scheduled<TTaskId extends keyof ScheduledMap<TSlots> & string>(
    taskId: TTaskId,
    config: ScheduledConfig<TMeta, ScheduledMap<TSlots>[TTaskId]>,
  ): void;
}

/** A stream's nudge map: event name → schema, or `null` for a no-payload nudge. */
export type StreamNudgeMap = Record<string, Validator | null>;

/** The payload type one nudge declaration carries, or `undefined` for a no-payload nudge. */
type NudgePayloadOf<T> = T extends Validator<infer U> ? U : undefined;

/** The union of `{ event, payload }` shapes a stream's nudges can produce. */
type NudgeMessageUnion<TNudges> = {
  [K in keyof TNudges & string]: { event: K; payload: NudgePayloadOf<TNudges[K]> };
}[keyof TNudges & string];

/** The `nudges()` reader on a stream handle — present only when the stream declares nudges. */
type NudgesHandle<TNudges> = [keyof TNudges] extends [never]
  ? {}
  : { nudges(yielded: unknown): NudgeMessageUnion<TNudges>[] };

/**
 * The base `ctx.stream` handle present on every stream generator, regardless of
 * nudges or cursor. Combined with `NudgesHandle` (and cursor controls for
 * durable streams) to form the full handle.
 */
type StreamHandleBase = {
  /**
   * Stop signal fired when the stream is cancelled, the owning client
   * disconnects, or the server shuts down. Pass it into slow awaited work (e.g.
   * `fetch(url, { signal: ctx.stream.signal })`) so it stops immediately.
   */
  readonly signal: AbortSignal;
  /**
   * Pause the generator until the outbound buffer is healthy, then continue.
   * Resolves immediately when the buffered amount is below the stream's
   * `highWaterMark` (default 256 KB). For a broadcast stream it paces against
   * the healthiest client, never the slowest. On Cloudflare, which does not
   * expose buffer fullness, `drain()` is a no-op that resolves immediately.
   */
  drain(): Promise<void>;
};

/** The contract slot shape for a stream's declared nudges. */
type NudgesContract<TNudges> = { [K in keyof TNudges & string]: NudgePayloadOf<TNudges[K]> };

/** The value the stream builders return — a primitive that declares its stream slot. */
export type StreamHandlerValue<TEvent extends string, TEntry, TSlot extends string> = Primitive &
  Contribution<{ [K in TSlot]: Record<TEvent, TEntry> }>;

/** The `ctx` a plain stream generator receives — `ctx.stream` carries nudges. */
type StreamCtx<TSlots, TMeta, TNudges, TCaps extends readonly AnyCapability[]> = AppCtx<
  TSlots,
  TMeta,
  TCaps
> & {
  stream: StreamHandleBase & NudgesHandle<TNudges>;
};

/** Configuration object for `base.stream(...)`. */
export interface StreamConfig<
  TSlots,
  TMeta,
  TInput extends Validator | undefined,
  TChunk,
  TNudges extends StreamNudgeMap,
  TCaps extends readonly AnyCapability[] = readonly [],
> {
  /** Schema validating the start payload the client sends. */
  readonly input?: TInput;
  /** Optional explicit chunk type. Otherwise inferred from what `run` yields. */
  readonly chunk?: TypeMarker<TChunk>;
  /** Client→server steering signals delivered into the running generator. */
  readonly nudges?: TNudges;
  /** Fan the stream out to every connection (or channel member) instead of one. */
  readonly broadcast?: boolean;
  /** Permit overlapping streams of the same event on one connection (default false). */
  readonly allowConcurrent?: boolean;
  /** Outbound backpressure limit in bytes used by `ctx.stream.drain()` (default 256 KB). */
  readonly highWaterMark?: number;
  /** The async generator — each yielded value is sent to the client as a chunk. */
  run(
    ctx: StreamCtx<TSlots, TMeta, TNudges, TCaps>,
    input: InferInput<TInput>,
  ): AsyncGenerator<TChunk, void, unknown>;
}

/** Builder method granted by the `stream()` capability. */
export interface StreamMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /** Create a plain server-pushed stream handler value. Pass it to `assemble()` to activate it. */
  stream<
    TEvent extends string,
    TChunk = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: StreamConfig<TSlots, TMeta, TInput, TChunk, TNudges, TCaps>,
  ): StreamHandlerValue<
    TEvent,
    { payload: InferInput<TInput>; chunk: TChunk; nudges: NudgesContract<TNudges> },
    'streams'
  >;
}

/** Retention and disconnect options shared by the durable stream kinds. */
interface DurableStreamOptions {
  /** Behavior when the owning client drops. */
  readonly onDisconnect?: 'cancel-but-buffer' | 'keep-running';
  /** How long a suspended stream is kept after the client drops. */
  readonly maxAgeMs?: number;
  /** How long an ended stream is kept so a quick reconnect can still continue. */
  readonly retentionAfterEndMs?: number;
}

/** The `ctx` a cursor stream generator receives — `ctx.stream` adds cursor controls. */
type CursorStreamCtx<
  TSlots,
  TMeta,
  TChunk,
  TCursor,
  TNudges,
  TCaps extends readonly AnyCapability[],
> = AppCtx<TSlots, TMeta, TCaps> & {
  stream: StreamHandleBase &
    NudgesHandle<TNudges> & {
      /** The cursor recorded on the last run, or `null` on the first run. */
      cursor: TCursor | null;
      /** 1 on the first run, then one higher on every reconnect (2, 3, ...). */
      attempt: number;
      /** Attach a cursor to a chunk so the framework can continue from it. */
      withCursor(chunk: TChunk, cursor: TCursor): TChunk;
    };
};

/** Configuration object for `base.cursorStream(...)`. */
export interface CursorStreamConfig<
  TSlots,
  TMeta,
  TInput extends Validator | undefined,
  TChunk,
  TCursor,
  TNudges extends StreamNudgeMap,
  TCaps extends readonly AnyCapability[] = readonly [],
> extends DurableStreamOptions {
  readonly input?: TInput;
  /** Optional explicit chunk type. Otherwise inferred from what `run` yields. */
  readonly chunk?: TypeMarker<TChunk>;
  /** The cursor type. A `t<T>()` marker is type-only; a schema also runtime-checks restored cursors. */
  readonly cursor?: TypeMarker<TCursor> | Validator<TCursor>;
  readonly nudges?: TNudges;
  readonly broadcast?: boolean;
  readonly allowConcurrent?: boolean;
  /** Outbound backpressure limit in bytes used by `ctx.stream.drain()` (default 256 KB). */
  readonly highWaterMark?: number;
  run(
    ctx: CursorStreamCtx<TSlots, TMeta, TChunk, TCursor, TNudges, TCaps>,
    input: InferInput<TInput>,
  ): AsyncGenerator<TChunk, void, unknown>;
}

/** Builder method granted by the `cursorStream()` capability. */
export interface CursorStreamMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /** Create a cursor server-pushed stream handler value. Pass it to `assemble()` to activate it. */
  cursorStream<
    TEvent extends string,
    TChunk = unknown,
    TCursor = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: CursorStreamConfig<TSlots, TMeta, TInput, TChunk, TCursor, TNudges, TCaps>,
  ): StreamHandlerValue<
    TEvent,
    {
      payload: InferInput<TInput>;
      chunk: TChunk;
      cursor: TCursor;
      nudges: NudgesContract<TNudges>;
    },
    'cursorStreams'
  >;
}

/** Configuration object for `base.recordedStream(...)`. */
export interface RecordedStreamConfig<
  TSlots,
  TMeta,
  TInput extends Validator | undefined,
  TChunk,
  TNudges extends StreamNudgeMap,
  TCaps extends readonly AnyCapability[] = readonly [],
> extends DurableStreamOptions {
  readonly input?: TInput;
  /** Optional explicit chunk type. Otherwise inferred from what `run` yields. */
  readonly chunk?: TypeMarker<TChunk>;
  readonly nudges?: TNudges;
  readonly broadcast?: boolean;
  readonly allowConcurrent?: boolean;
  /** Hard cap on buffered chunks. Default: 500. */
  readonly maxChunks?: number;
  /** Outbound backpressure limit in bytes used by `ctx.stream.drain()` (default 256 KB). */
  readonly highWaterMark?: number;
  run(
    ctx: StreamCtx<TSlots, TMeta, TNudges, TCaps>,
    input: InferInput<TInput>,
  ): AsyncGenerator<TChunk, void, unknown>;
}

/** Builder method granted by the `recordedStream()` capability. */
export interface RecordedStreamMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /** Create a recorded server-pushed stream handler value. Pass it to `assemble()` to activate it. */
  recordedStream<
    TEvent extends string,
    TChunk = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: RecordedStreamConfig<TSlots, TMeta, TInput, TChunk, TNudges, TCaps>,
  ): StreamHandlerValue<
    TEvent,
    { payload: InferInput<TInput>; chunk: TChunk; nudges: NudgesContract<TNudges> },
    'recordedStreams'
  >;
}

type ChannelCapability =
  | ChannelOnlyCapability<{}, never, string>
  | EmitsCapability<EmitDefs>
  | ServerRequestsCapability;

type ChannelCapabilitySlots<TCaps extends readonly ChannelCapability[]> = MergeSlots<
  SlotsOf<TCaps[number]>
>;
type ChannelOutgoing<TCaps extends readonly ChannelCapability[]> =
  SlotOr<ChannelCapabilitySlots<TCaps>, 'outgoing'> extends infer TOutgoing extends Record<
    string,
    unknown
  >
    ? TOutgoing
    : {};
type ChannelServerRequests<TCaps extends readonly ChannelCapability[]> = SlotOr<
  ChannelCapabilitySlots<TCaps>,
  'serverRequests'
>;

/** The subscribe-payload type for a channel's `subscribe` schema, or `never` when absent. */
type SubscribePayloadOf<TSubscribe> = TSubscribe extends Validator<infer U> ? U : never;

/** A channel handle inside a channel handler — outgoing events are typed to the channel's emits. */
interface ChannelHandle<TParams, TOutgoing, TMeta> {
  /** The matched channel name, e.g. `'lobby'` or `'rooms:abc'`. */
  readonly name: string;
  /** The family key for a dynamic channel, or `null` for a static one. */
  readonly family: string | null;
  /** The `{name}` captures from a dynamic pattern. */
  readonly params: TParams;
  /**
   * Send a channel event to the calling connection. Returns `1` when delivered
   * and `0` otherwise.
   */
  send<E extends keyof TOutgoing & string>(event: E, payload: TOutgoing[E]): number;
  /** Broadcast a channel event to a selected member audience. */
  broadcastTo<E extends keyof TOutgoing & string>(
    to: ChannelRecipient,
    event: E,
    payload: TOutgoing[E],
  ): number;
  /** Broadcast a channel event to its members. */
  broadcast<E extends keyof TOutgoing & string>(
    event: E,
    payload: TOutgoing[E],
    options?: { includeSelf?: boolean },
  ): void;
  /** Snapshot of the channel's members. */
  members(): ConnectionInfo<TMeta>[];
  /** Server-side subscribe a connection to this channel. */
  subscribe(ref: ConnectionRef, payload?: unknown): Promise<void>;
  /**
   * Remove a user, everyone holding a tag, or everyone with any key under a
   * tag group (`ctx.tags.ephemeral(...)` / `.persistent(...)`) from this
   * channel. Pass `revoke: true` to also drop the durable membership row so
   * the user does not auto-rejoin on reconnect. Every targeted connection is
   * kicked even when a leave hook throws; then the promise rejects with an
   * `AggregateError` holding every hook failure.
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
    opts: OptsParameter,
  ): Promise<void>;
  /**
   * Inject a synthetic replay frame for one of this channel's outgoing events.
   * Used from a channel custom-replay handler; `wire` carries the seq/messageId
   * the client uses to dedup. It is absent when replay is not active for this
   * channel.
   */
  sendReplay?<E extends keyof TOutgoing & string>(
    event: E,
    payload: TOutgoing[E],
    wire: ReplayWire,
  ): void;
}

/** A channel's own server→client request map, filtered to targeted (non-broadcast) entries. */
type ChannelTargetedRequests<TServerRequests> = {
  [K in keyof TServerRequests as TServerRequests[K] extends { broadcast: true }
    ? never
    : K]: TServerRequests[K];
};

/** A channel's own server→client request map, filtered to broadcast-only entries. */
type ChannelBroadcastRequests<TServerRequests> = BroadcastServerRequests<{
  serverRequests: TServerRequests;
}>;

/**
 * The `request`/`broadcastRequest` arms added to `ctx.channel` when that channel
 * lists `serverRequests(...)`. They resolve the channel's own declarations.
 */
type ChannelRequestArm<
  TServerRequests,
  TChannelBrand extends string,
> = 'serverRequests' extends TChannelBrand
  ? [keyof TServerRequests] extends [never]
    ? {}
    : {
        /**
         * Ask a server→client request this channel declared and resolve its
         * typed answer. Targets the calling connection by default; pass `{ to }`
         * to ask a specific member instead — a `ConnectionRef`, or a
         * `UserRef`/`TagRef`/`TagGroupHandle`, in which case the first valid
         * answer from a matching member wins.
         */
        request<E extends keyof ChannelTargetedRequests<TServerRequests> & string>(
          event: E,
          payload: ChannelTargetedRequests<TServerRequests>[E] extends { payload: infer P }
            ? P
            : never,
          options?: { timeout?: number; to?: ChannelRecipient },
        ): Promise<
          ChannelTargetedRequests<TServerRequests>[E] extends { response: infer R } ? R : never
        >;
      } & BroadcastRequestArm<
        ChannelBroadcastRequests<TServerRequests>,
        SelfBroadcastRequestOptions
      >
  : {};

/**
 * The `inbox`/`readReceipts` arms added to `ctx.channel` when this channel's OWN
 * `capabilities` list (not the host's) carries the matching brand — `inbox()`
 * lands `ctx.channel.inbox`, `readReceipts()` lands `ctx.channel.readReceipts`.
 * Both are always-present, non-null members here (unlike the nullable
 * `handle.inbox()` / `handle.readReceipts()` methods on a `ctx.channels.get(...)`
 * handle, which may name any channel).
 *
 * `TChannelBrand` widened all the way to `string` (a capabilities array typed
 * with the bare `string` brand rather than a literal union) means every brand
 * check below would pass at once, so that case grants nothing instead.
 */
type ChannelCapabilityArm<
  TChannelBrand extends string,
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
> =
  BrandIsWidened<TChannelBrand> extends true
    ? {}
    : ('inbox' extends TChannelBrand ? { readonly inbox: ChannelInbox<TOutgoing> } : {}) &
        ('readReceipts' extends TChannelBrand
          ? { readonly readReceipts: ChannelReadReceipts }
          : {});

/**
 * The `ctx` a channel message handler receives — adds the typed `ctx.channel`.
 * Channel replay, when active, is scoped to that handle rather than the root.
 */
export type ChannelCtx<
  TSlots,
  TMeta,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TCaps extends readonly AnyCapability[] = readonly [],
  TServerRequests = {},
  TChannelBrand extends string = never,
> = Omit<AppCtx<TSlots, TMeta, TCaps>, 'sendReplay'> & {
  readonly channel: ChannelHandle<TParams, TOutgoing, TMeta> &
    ChannelRequestArm<TServerRequests, TChannelBrand> &
    ChannelCapabilityArm<TChannelBrand, TOutgoing>;
};

/**
 * The looser `ctx` a channel gate/lifecycle hook receives (sends accept any
 * channel event). Replay is exposed, when active, on `ctx.channel.sendReplay`;
 * channel contexts do not expose the root `ctx.sendReplay` method.
 */
export type ChannelGateCtx<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[] = readonly [],
  TChannelBrand extends string = never,
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
  /** `true` for check/commit/revalidate, whose ctx omits channel-only handles. */
  TIsSubscribeGate extends boolean = false,
  TServerRequests = {},
> = Omit<AppCtx<TSlots, TMeta, TCaps, TIsSubscribeGate>, 'sendReplay'> & {
  readonly channel: ChannelHandle<Record<string, string>, Record<string, unknown>, TMeta> &
    ChannelRequestArm<TServerRequests, TChannelBrand> &
    ChannelCapabilityArm<TChannelBrand, TOutgoing>;
};

/**
 * The channel-level `rateLimit?` field, present only when the `rateLimit()`
 * capability is listed. Caps every event in this channel against one bucket; a
 * per-handler `rateLimit` tightens or loosens it. Absent without the capability,
 * so passing it is a compile-time excess-property error.
 */
type ChannelRateLimitField<TCaps extends readonly AnyCapability[]> =
  'rateLimit' extends BrandsOf<TCaps>
    ? {
        /** Channel-level rate-limit rule shared by every event in this channel. */
        readonly rateLimit?: RateLimitConfig;
      }
    : {};

/** Configuration object for `base.channel(...)`. */
export type ChannelConfig<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[] = readonly [],
  TSubscribe extends Validator | undefined = Validator | undefined,
  TCheckResult = unknown,
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
  TCapabilities extends readonly ChannelCapability[] = readonly ChannelCapability[],
> = {
  /** Schema validating the payload a client sends on subscribe. */
  readonly subscribe?: TSubscribe;
  /**
   * Async gate before the subscriber is counted. Return a value forwarded to
   * `commit`; throw to reject. Written inside this same config object, before
   * `capabilities` and channel-owned `serverRequests(...)` can be read back, so
   * `ctx.channel.inbox`, `ctx.channel.readReceipts`, and
   * `ctx.channel.request` / `broadcastRequest` are not available here — read
   * channel-only surfaces in `subscribe`, `unsubscribe`, or `sessionEnd`
   * instead.
   */
  check?: (
    ctx: ChannelGateCtx<TSlots, TMeta, TCaps, never, TOutgoing, true>,
    input: InferInput<TSubscribe>,
  ) => TCheckResult | Promise<TCheckResult>;
  /**
   * Sync gate that runs right before the subscriber is added, in the same
   * JavaScript tick as the membership write. `ctx.channel.members()` does not
   * include the joiner yet, so a cap of N rejects when `members().length >= N`,
   * and two subscribes at once cannot both pass it. Throw to reject. Written inside this same config object, before
   * `capabilities` and channel-owned `serverRequests(...)` can be read back, so
   * `ctx.channel.inbox`, `ctx.channel.readReceipts`, and
   * `ctx.channel.request` / `broadcastRequest` are not available here — read
   * channel-only surfaces in `subscribe`, `unsubscribe`, or `sessionEnd`
   * instead.
   */
  commit?: (
    ctx: ChannelGateCtx<TSlots, TMeta, TCaps, never, TOutgoing, true>,
    checkResult: Awaited<TCheckResult>,
  ) => void;
  /**
   * Re-authorize on auto-rejoin after reconnect (persistent memberships).
   * Throw to drop. Written inside this same config object, before
   * `capabilities` and channel-owned `serverRequests(...)` can be read back, so
   * `ctx.channel.inbox`, `ctx.channel.readReceipts`, and
   * `ctx.channel.request` / `broadcastRequest` are not available here — read
   * channel-only surfaces in `subscribe`, `unsubscribe`, or `sessionEnd`
   * instead.
   */
  revalidate?: (
    ctx: ChannelGateCtx<TSlots, TMeta, TCaps, never, TOutgoing, true>,
  ) => void | Promise<void>;
  /** Whether membership survives a reconnect (default `'persistent'`). */
  readonly membership?: 'persistent' | 'ephemeral';
  /**
   * Per-channel built-in replay opt-in/out, cascading from `server`. `true` is
   * shorthand for history mode with defaults; `false` opts this channel out.
   */
  readonly replay?: boolean;
  /**
   * This channel's own channel-only capabilities — `inbox()` for guaranteed
   * per-member delivery, `readReceipts()` (needs `inbox()` on the same
   * channel) for the read cursor. Unlike the host's `capabilities`, this list
   * is scoped to the one channel.
   */
  readonly capabilities?: TCapabilities & UniqueCapabilityKinds<TCapabilities>;
} & ChannelRateLimitField<TCaps>;

/**
 * A channel handler's return value. It declares the channel's own slice (emits,
 * subscribe payload, addressing) **and** this handler's slice under the channel,
 * and carries a reference to the channel — so passing a single handler to
 * `assemble()` includes that handler and the channel surface it belongs to.
 */
export type ChannelHandlerContribution<TKey extends string, TOwn, TSlice> = ChannelHandlerValue &
  Contribution<{ channels: { [K in TKey]: TOwn & TSlice } }>;

/**
 * The client-visible capability flags a channel's own `capabilities` list
 * turns on. Merged into the channel's contract slice so `InferClient` gates
 * `receiversOf` to inbox channels and `markAsRead`/`readersOf` to channels
 * with `readReceipts`. `TBrand` is the union of brands carried by the
 * channel's `capabilities` array (see `BrandsOf`) — `inbox()`/`readReceipts()`
 * each stamp their own brand, so their presence in that list lands the flag.
 */
type ChannelCapabilityFlags<TBrand extends string> = ('inbox' extends TBrand
  ? { inbox: true }
  : {}) &
  ('readReceipts' extends TBrand ? { readReceipts: true } : {});

/**
 * The channel's own contract slice — declared from its config and pattern.
 * It carries the channel's capability flags, so every handler value brings
 * them along with the rest of the channel surface.
 */
type ChannelOwnSlice<
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TServerRequests = {},
  TChannelBrand extends string = never,
> = {
  outgoing: TOutgoing;
  serverRequests: TServerRequests;
  params: TParams;
  __addressing: TAddressing;
} & ([TSubscribe] extends [never] ? {} : { subscribePayload: TSubscribe }) &
  ChannelCapabilityFlags<TChannelBrand>;

/** Configuration object for a channel `stream`. */
type ChannelStreamConfig<
  TSlots,
  TMeta,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TInput,
  TChunk,
  TNudges,
  TCaps extends readonly AnyCapability[],
  TServerRequests = {},
  TChannelBrand extends string = never,
> = {
  readonly input?: TInput;
  readonly chunk?: TypeMarker<TChunk>;
  readonly nudges?: TNudges;
  readonly broadcast?: boolean;
  readonly allowConcurrent?: boolean;
  /** Outbound backpressure limit in bytes used by `ctx.stream.drain()` (default 256 KB). */
  readonly highWaterMark?: number;
  run(
    ctx: ChannelCtx<TSlots, TMeta, TParams, TOutgoing, TCaps, TServerRequests, TChannelBrand> & {
      stream: StreamHandleBase & NudgesHandle<TNudges>;
    },
    input: InferInput<TInput extends Validator | undefined ? TInput : undefined>,
  ): AsyncGenerator<TChunk, void, unknown>;
} & RateLimitField<TCaps>;

/** Configuration object for a channel `recordedStream` — adds the durable retention options. */
type ChannelRecordedStreamConfig<
  TSlots,
  TMeta,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TInput,
  TChunk,
  TNudges,
  TCaps extends readonly AnyCapability[],
  TServerRequests = {},
  TChannelBrand extends string = never,
> = DurableStreamOptions & {
  readonly input?: TInput;
  readonly chunk?: TypeMarker<TChunk>;
  readonly nudges?: TNudges;
  readonly broadcast?: boolean;
  readonly allowConcurrent?: boolean;
  /** Hard cap on buffered chunks. Default: 500. */
  readonly maxChunks?: number;
  /** Outbound backpressure limit in bytes used by `ctx.stream.drain()` (default 256 KB). */
  readonly highWaterMark?: number;
  run(
    ctx: ChannelCtx<TSlots, TMeta, TParams, TOutgoing, TCaps, TServerRequests, TChannelBrand> & {
      stream: StreamHandleBase & NudgesHandle<TNudges>;
    },
    input: InferInput<TInput extends Validator | undefined ? TInput : undefined>,
  ): AsyncGenerator<TChunk, void, unknown>;
} & RateLimitField<TCaps>;

/** Configuration object for a channel `cursorStream` — adds cursor controls and retention. */
type ChannelCursorStreamConfig<
  TSlots,
  TMeta,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TInput,
  TChunk,
  TCursor,
  TNudges,
  TCaps extends readonly AnyCapability[],
  TServerRequests = {},
  TChannelBrand extends string = never,
> = DurableStreamOptions & {
  readonly input?: TInput;
  readonly chunk?: TypeMarker<TChunk>;
  /** The cursor type. A `t<T>()` marker is type-only; a schema also runtime-checks restored cursors. */
  readonly cursor?: TypeMarker<TCursor> | Validator<TCursor>;
  readonly nudges?: TNudges;
  readonly broadcast?: boolean;
  readonly allowConcurrent?: boolean;
  /** Outbound backpressure limit in bytes used by `ctx.stream.drain()` (default 256 KB). */
  readonly highWaterMark?: number;
  run(
    ctx: ChannelCtx<TSlots, TMeta, TParams, TOutgoing, TCaps, TServerRequests, TChannelBrand> & {
      stream: StreamHandleBase &
        NudgesHandle<TNudges> & {
          /** The cursor recorded on the last run, or `null` on the first run. */
          cursor: TCursor | null;
          /** 1 on the first run, then one higher on every reconnect (2, 3, ...). */
          attempt: number;
          /** Attach a cursor to a chunk so the framework can continue from it. */
          withCursor(chunk: TChunk, cursor: TCursor): TChunk;
        };
    },
    input: InferInput<TInput extends Validator | undefined ? TInput : undefined>,
  ): AsyncGenerator<TChunk, void, unknown>;
} & RateLimitField<TCaps>;

/**
 * The accumulating channel object returned by `base.channel(...)`. Its handler
 * methods register onto the channel and return a value carrying both the
 * client-contract type and a reference back to the channel; its gate and
 * lifecycle methods mutate and return void. Pass handler values to
 * `assemble()` to select them; passing the channel itself only includes its
 * configuration and lifecycle behavior.
 */
interface ChannelStreamMethod<
  TSlots,
  TMeta,
  TKey extends string,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TCaps extends readonly AnyCapability[],
  TServerRequests = {},
  TChannelBrand extends string = never,
> {
  /** Create a plain stream handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  stream<
    TEvent extends string,
    TChunk = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: ChannelStreamConfig<
      TSlots,
      TMeta,
      TParams,
      TOutgoing,
      TInput,
      TChunk,
      TNudges,
      TCaps,
      TServerRequests,
      TChannelBrand
    >,
  ): ChannelHandlerContribution<
    TKey,
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests, TChannelBrand>,
    {
      streams: Record<
        TEvent,
        { payload: InferInput<TInput>; chunk: TChunk; nudges: NudgesContract<TNudges> }
      >;
    }
  >;
}

interface ChannelCursorStreamMethod<
  TSlots,
  TMeta,
  TKey extends string,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TCaps extends readonly AnyCapability[],
  TServerRequests = {},
  TChannelBrand extends string = never,
> {
  /** Create a cursor stream handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  cursorStream<
    TEvent extends string,
    TChunk = unknown,
    TCursor = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: ChannelCursorStreamConfig<
      TSlots,
      TMeta,
      TParams,
      TOutgoing,
      TInput,
      TChunk,
      TCursor,
      TNudges,
      TCaps,
      TServerRequests,
      TChannelBrand
    >,
  ): ChannelHandlerContribution<
    TKey,
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests, TChannelBrand>,
    {
      cursorStreams: Record<
        TEvent,
        {
          payload: InferInput<TInput>;
          chunk: TChunk;
          cursor: TCursor;
          nudges: NudgesContract<TNudges>;
        }
      >;
    }
  >;
}

interface ChannelRecordedStreamMethod<
  TSlots,
  TMeta,
  TKey extends string,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TCaps extends readonly AnyCapability[],
  TServerRequests = {},
  TChannelBrand extends string = never,
> {
  /** Create a recorded stream handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  recordedStream<
    TEvent extends string,
    TChunk = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: ChannelRecordedStreamConfig<
      TSlots,
      TMeta,
      TParams,
      TOutgoing,
      TInput,
      TChunk,
      TNudges,
      TCaps,
      TServerRequests,
      TChannelBrand
    >,
  ): ChannelHandlerContribution<
    TKey,
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests, TChannelBrand>,
    {
      recordedStreams: Record<
        TEvent,
        { payload: InferInput<TInput>; chunk: TChunk; nudges: NudgesContract<TNudges> }
      >;
    }
  >;
}

/**
 * The stream methods a channel exposes, each present only when its matching
 * stream capability is listed — mirroring the top-level brand gating.
 */
export type ChannelStreamMethods<
  TSlots,
  TMeta,
  TKey extends string,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TBrand extends string,
  TCaps extends readonly AnyCapability[],
  TServerRequests = {},
  TChannelBrand extends string = never,
> = ('stream' extends TBrand
  ? ChannelStreamMethod<
      TSlots,
      TMeta,
      TKey,
      TParams,
      TOutgoing,
      TAddressing,
      TSubscribe,
      TCaps,
      TServerRequests,
      TChannelBrand
    >
  : {}) &
  ('cursorStream' extends TBrand
    ? ChannelCursorStreamMethod<
        TSlots,
        TMeta,
        TKey,
        TParams,
        TOutgoing,
        TAddressing,
        TSubscribe,
        TCaps,
        TServerRequests,
        TChannelBrand
      >
    : {}) &
  ('recordedStream' extends TBrand
    ? ChannelRecordedStreamMethod<
        TSlots,
        TMeta,
        TKey,
        TParams,
        TOutgoing,
        TAddressing,
        TSubscribe,
        TCaps,
        TServerRequests,
        TChannelBrand
      >
    : {});

export type ChannelObject<
  TSlots,
  TMeta,
  TKey extends string,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TCaps extends readonly AnyCapability[] = readonly [],
  TServerRequests = {},
  TChannelBrand extends string = never,
> = ChannelObjectCore<
  TSlots,
  TMeta,
  TKey,
  TParams,
  TOutgoing,
  TAddressing,
  TSubscribe,
  TCaps,
  TServerRequests,
  TChannelBrand
> &
  ChannelStreamMethods<
    TSlots,
    TMeta,
    TKey,
    TParams,
    TOutgoing,
    TAddressing,
    TSubscribe,
    BrandsOf<TCaps>,
    TCaps,
    TServerRequests,
    TChannelBrand
  > &
  ChannelRefForm<TParams, TOutgoing, TAddressing, TServerRequests>;

/**
 * How a channel declaration is referenced in `ctx.channels.get(...)`. A static channel
 * IS a ref (pass it directly). A dynamic family is not — it exposes `.at(params)`
 * to bind an instance, and only that ref carries the channel's contract. So
 * `.at(...)` exists only on family declarations.
 */
type ChannelRefForm<
  TParams,
  TOutgoing,
  TAddressing extends string,
  TServerRequests,
> = TAddressing extends 'dynamic'
  ? { at(params: TParams): ChannelRef<TOutgoing, TServerRequests> }
  : ChannelRef<TOutgoing, TServerRequests>;

/**
 * The channel methods present whatever stream capabilities are listed. It drops
 * the runtime builder's loosely-typed handler and lifecycle methods so the
 * precisely-typed versions here (and the brand-gated stream methods in
 * `ChannelStreamMethods`) are the only source — that is what makes the typing
 * and gating real.
 */
export type ChannelObjectCore<
  TSlots,
  TMeta,
  TKey extends string,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TCaps extends readonly AnyCapability[] = readonly [],
  TServerRequests = {},
  TChannelBrand extends string = never,
> = Omit<
  ChannelBuilder,
  | 'on'
  | 'request'
  | 'stream'
  | 'cursorStream'
  | 'recordedStream'
  | 'subscribe'
  | 'unsubscribe'
  | 'sessionEnd'
  | 'intercept'
  | 'replay'
  | 'at'
> &
  Contribution<{
    channels: {
      [K in TKey]: ChannelOwnSlice<
        TParams,
        TOutgoing,
        TAddressing,
        TSubscribe,
        TServerRequests,
        TChannelBrand
      >;
    };
  }> &
  ChannelCoreMethods<
    TSlots,
    TMeta,
    TKey,
    TParams,
    TOutgoing,
    TAddressing,
    TSubscribe,
    TCaps,
    TServerRequests,
    TChannelBrand
  > &
  ('clientRequests' extends BrandsOf<TCaps>
    ? ChannelRequestMethods<
        TSlots,
        TMeta,
        TKey,
        TParams,
        TOutgoing,
        TAddressing,
        TSubscribe,
        TCaps,
        TServerRequests,
        TChannelBrand
      >
    : {}) &
  ('intercepts' extends BrandsOf<TCaps>
    ? ChannelInterceptMethods<TSlots, TMeta, TCaps, TChannelBrand, TOutgoing, TServerRequests>
    : {});

/** The `on` / lifecycle methods every channel object carries. */
export interface ChannelCoreMethods<
  TSlots,
  TMeta,
  TKey extends string,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TCaps extends readonly AnyCapability[] = readonly [],
  TServerRequests = {},
  TChannelBrand extends string = never,
> {
  /** Create a client→server event handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  on<TEvent extends string, TInput extends Validator | undefined = undefined>(
    event: TEvent,
    config: {
      input?: TInput;
      /** Run this handler alongside earlier work on the same connection. Defaults to ordered execution. */
      allowInterleaving?: boolean;
      run(
        ctx: ChannelCtx<TSlots, TMeta, TParams, TOutgoing, TCaps, TServerRequests, TChannelBrand>,
        input: InferInput<TInput>,
      ): void | Promise<void>;
    } & RateLimitField<TCaps>,
  ): ChannelHandlerContribution<
    TKey,
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests, TChannelBrand>,
    { incoming: Record<TEvent, InferInput<TInput>> }
  >;

  /** Runs after a client subscribes to this channel. */
  subscribe(
    handler: (
      ctx: ChannelGateCtx<TSlots, TMeta, TCaps, TChannelBrand, TOutgoing, false, TServerRequests>,
    ) => void | Promise<void>,
  ): void;
  /** Runs on a true leave (explicit unsubscribe / kick), not a plain disconnect. */
  unsubscribe(
    handler: (
      ctx: ChannelGateCtx<TSlots, TMeta, TCaps, TChannelBrand, TOutgoing, false, TServerRequests>,
    ) => void | Promise<void>,
  ): void;
  /** Runs on every session end, including a plain disconnect. */
  sessionEnd(
    handler: (
      ctx: ChannelGateCtx<TSlots, TMeta, TCaps, TChannelBrand, TOutgoing, false, TServerRequests>,
    ) => void | Promise<void>,
  ): void;
  /** Register a custom replay strategy scoped to this channel. */
  replay(hooks: ChannelCustomReplayHooks): void;
}

/** Channel `request(...)`, granted by the `clientRequests()` capability. */
export interface ChannelRequestMethods<
  TSlots,
  TMeta,
  TKey extends string,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TCaps extends readonly AnyCapability[] = readonly [],
  TServerRequests = {},
  TChannelBrand extends string = never,
> {
  /** Create a client→server request handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  request<
    TEvent extends string,
    TInput extends Validator | undefined = undefined,
    TResponse = void,
  >(
    event: TEvent,
    config: {
      input?: TInput;
      /** Run this request alongside earlier work on the same connection. Defaults to interleaved execution. */
      allowInterleaving?: boolean;
      run(
        ctx: ChannelCtx<TSlots, TMeta, TParams, TOutgoing, TCaps, TServerRequests, TChannelBrand>,
        input: InferInput<TInput>,
      ): TResponse | Promise<TResponse>;
    } & RateLimitField<TCaps>,
  ): ChannelHandlerContribution<
    TKey,
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests, TChannelBrand>,
    {
      clientRequests: Record<TEvent, { payload: InferInput<TInput>; response: Awaited<TResponse> }>;
    }
  >;
}

/** Channel `intercept(...)`, granted by the `intercepts()` capability. */
export interface ChannelInterceptMethods<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TChannelBrand extends string = never,
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
  TServerRequests = {},
> {
  /** Inspect every incoming frame in this channel before routing. One per channel. */
  intercept(
    handler: (
      ctx: ChannelGateCtx<TSlots, TMeta, TCaps, TChannelBrand, TOutgoing, false, TServerRequests>,
      frame: InterceptFrame,
    ) => unknown | void,
  ): void;
}

/**
 * Validates a channel's own `capabilities` array: `readReceipts()` needs
 * `inbox()` listed on the SAME channel. An invalid combination collapses the
 * accepted element type to `never`, so `readReceipts()` without `inbox()` in
 * the same array is a compile error at the call site.
 *
 * A `T` whose brand has widened to `string` (rather than a literal union)
 * can't be checked for that rule at all — 'readReceipts' extends BrandsOf<T>`
 * would pass regardless of what's actually listed — so it is rejected the
 * same way: the accepted element brand collapses to `never`, and the widened
 * array fails to satisfy it at the call site.
 */
type ValidChannelCapabilities<
  T extends readonly ChannelCapability[],
  THostCaps extends readonly AnyCapability[],
> =
  BrandIsWidened<NonNullable<T[number]['__brand']>> extends true
    ? readonly ChannelOnlyCapability<{}, never, never>[]
    : 'readReceipts' extends BrandsOf<T>
      ? 'inbox' extends BrandsOf<T>
        ? ValidChannelServerRequests<T, THostCaps>
        : readonly ChannelOnlyCapability<{}, never, Exclude<BrandsOf<T>, 'readReceipts'>>[]
      : ValidChannelServerRequests<T, THostCaps>;

type ValidChannelServerRequests<
  T extends readonly ChannelCapability[],
  THostCaps extends readonly AnyCapability[],
> =
  'serverRequests' extends BrandsOf<T>
    ? 'serverRequests' extends BrandsOf<THostCaps>
      ? T
      : readonly Exclude<T[number], ServerRequestsCapability>[]
    : T;

/** Builder method granted by the `channels()` capability. */
export interface ChannelMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /** Declare a static channel. */
  channel<
    TName extends string,
    TSubscribe extends Validator | undefined = undefined,
    TCheckResult = unknown,
    const TCapabilities extends readonly ChannelCapability[] = readonly [],
  >(
    name: TName,
    config?: ChannelConfig<
      TSlots,
      TMeta,
      TCaps,
      TSubscribe,
      TCheckResult,
      ChannelOutgoing<TCapabilities>,
      TCapabilities
    > & {
      readonly capabilities?: ValidChannelCapabilities<TCapabilities, TCaps>;
    },
  ): ChannelObject<
    TSlots,
    TMeta,
    TName,
    {},
    ChannelOutgoing<TCapabilities>,
    'static',
    SubscribePayloadOf<TSubscribe>,
    TCaps,
    ChannelServerRequests<TCapabilities>,
    BrandsOf<TCapabilities>
  >;
  /** Declare a dynamic channel family from `[familyKey, pattern]`. */
  channel<
    TFamily extends string,
    TPattern extends string,
    TSubscribe extends Validator | undefined = undefined,
    TCheckResult = unknown,
    const TCapabilities extends readonly ChannelCapability[] = readonly [],
  >(
    pattern: readonly [TFamily, TPattern],
    config?: ChannelConfig<
      TSlots,
      TMeta,
      TCaps,
      TSubscribe,
      TCheckResult,
      ChannelOutgoing<TCapabilities>,
      TCapabilities
    > & {
      readonly capabilities?: ValidChannelCapabilities<TCapabilities, TCaps>;
    },
  ): ChannelObject<
    TSlots,
    TMeta,
    TFamily,
    ExtractParams<TPattern>,
    ChannelOutgoing<TCapabilities>,
    'dynamic',
    SubscribePayloadOf<TSubscribe>,
    TCaps,
    ChannelServerRequests<TCapabilities>,
    BrandsOf<TCapabilities>
  >;
}

/** Builder method granted by the `replay.custom()` capability. */
export interface ReplayMethods {
  /**
   * Register a custom replay strategy: your own storage and resend. The
   * `replay` hook (the resend) is required; `beforeBroadcast` /
   * `afterBroadcast` are optional. One registration per server.
   */
  replay(hooks: CustomReplayHooks): void;
}

/**
 * The builder methods the listed capabilities grant `base`, selected by each
 * capability's brand. A capability with no brand grants nothing.
 */
export type CapabilityMethods<
  TSlots,
  TMeta,
  TBrand extends string,
  TCaps extends readonly AnyCapability[],
> = ('clientRequests' extends TBrand ? RequestMethods<TSlots, TMeta, TCaps> : {}) &
  ('scheduled' extends TBrand ? ScheduledMethods<TSlots, TMeta> : {}) &
  ('replay-custom' extends TBrand ? ReplayMethods : {}) &
  ('intercepts' extends TBrand ? InterceptMethods<TSlots, TMeta, TCaps> : {}) &
  ('stream' extends TBrand ? StreamMethods<TSlots, TMeta, TCaps> : {}) &
  ('cursorStream' extends TBrand ? CursorStreamMethods<TSlots, TMeta, TCaps> : {}) &
  ('recordedStream' extends TBrand ? RecordedStreamMethods<TSlots, TMeta, TCaps> : {}) &
  ('channels' extends TBrand ? ChannelMethods<TSlots, TMeta, TCaps> : {});

/** Builder method granted by the `intercepts()` capability. */
export interface InterceptMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Inspect every incoming frame before routing and validation. Throw to reject;
   * return a value to replace the payload. One intercept per server.
   */
  intercept(
    handler: (
      ctx: AppCtx<TSlots, TMeta, TCaps>,
      frame: InterceptFrame<PluginIdsOf<TSlots>>,
    ) => unknown | void,
  ): void;
}

/**
 * The builder returned by `server(...)`. Carries the methods every server has
 * (`on`, the lifecycle hooks, `onOutgoing`, `assemble`) plus any methods the
 * listed capabilities grant through their brands — for example, `intercept`
 * exists only when `intercepts()` is listed.
 */
export type Base<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TScoped extends boolean = false,
> = CoreBase<TSlots, TMeta, TCaps, TScoped> &
  CapabilityMethods<TSlots, TMeta, BrandsOf<TCaps>, TCaps>;

/**
 * The union of installed plugin ids, read off the merged `plugins` slot. Used
 * to type `frame.owner.id` on app-level `intercept` / `outgoing` callbacks so
 * authors get autocomplete. Falls back to `string` when no plugins are listed.
 */
export type PluginIdsOf<TSlots> = keyof SlotOr<TSlots, 'plugins'> extends never
  ? string
  : keyof SlotOr<TSlots, 'plugins'> & string;

/** The methods present on every `base`, whatever capabilities are listed. */
export interface CoreBase<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TScoped extends boolean = false,
> {
  /**
   * Unique id of this `base`, copied onto every definition it assembles. The
   * `context.*` accessors compare it against the running definition.
   * @internal
   */
  readonly __baseId: symbol;

  /**
   * Create a handler value for one client→server event. Pass it to `assemble(...)`
   * to activate it. Exactly one assembled handler per event name is allowed in one
   * server definition.
   */
  on<TEvent extends string, TSchema extends Validator | undefined = undefined>(
    event: TEvent,
    config: OnConfig<TSlots, TMeta, TSchema, TCaps>,
  ): IncomingHandlerValue<TEvent, InferInput<TSchema>>;

  /** Run once at server startup, before any connection. Use it for schema creation or migrations. */
  onInit(handler: (ctx: InitContext) => void | Promise<void>): void;
  /** Run each time a connection opens, after `upgrade(...)` succeeds. */
  onConnect(handler: (ctx: AppCtx<TSlots, TMeta, TCaps>) => void | Promise<void>): void;
  /** Run each time a connection closes, for any reason. `ctx.closeCode` / `ctx.closeReason` are set. */
  onDisconnect(handler: (ctx: AppCtx<TSlots, TMeta, TCaps>) => void | Promise<void>): void;
  /**
   * Run each time a client sends a `ping`. The server has already replied
   * `pong` by then — this is for observing, not for answering.
   */
  onPing(handler: (ctx: AppCtx<TSlots, TMeta, TCaps>) => void | Promise<void>): void;
  /**
   * Run each time a client answers a server `ping` with a `pong`. With
   * `keepalive()` listed, the round-trip is already recorded, so `ctx.latency`
   * is fresh here.
   */
  onPong(handler: (ctx: AppCtx<TSlots, TMeta, TCaps>) => void | Promise<void>): void;
  /**
   * Run on any unhandled error from a handler. `event` is set when the error came from one.
   * In a plugin (`server({ scope: 'plugin' })`), it runs only for the plugin's own
   * events and channels, and `event` is the name the plugin declared, without the
   * `__<id>::` prefix.
   */
  onError(
    handler: (
      ctx: AppCtx<TSlots, TMeta, TCaps>,
      error: unknown,
      event?: string,
    ) => void | Promise<void>,
  ): void;
  /**
   * Run when an incoming payload fails its schema validation. In a plugin, it
   * runs only for the plugin's own events, and `event` is the name the plugin
   * declared, without the `__<id>::` prefix.
   */
  onValidationError(
    handler: (
      ctx: AppCtx<TSlots, TMeta, TCaps>,
      event: string,
      error: unknown,
    ) => void | Promise<void>,
  ): void;
  /** Run once when the server is shutting down. `ctx` is a server-wide context, with no single connection. */
  onShutdown(handler: (ctx: ShutdownContext<TMeta, unknown, TSlots>) => void | Promise<void>): void;

  /**
   * Inspect every outgoing frame before it is serialized. Return a value to
   * rewrite the payload, or nothing to observe. The event is locked. One
   * `onOutgoing` hook per server.
   *
   * `ctx` is the context of the connection whose `on`, `request` or `stream`
   * handler, intercept, or `onConnect` hook is running when the frame is sent.
   * For a broadcast from that code, `ctx` is the sender, not each receiver. In
   * every other case `ctx` is `undefined` — for example, a send from a channel
   * `subscribe` hook, `onDisconnect`, `onError`, a scheduled task, `onInit`,
   * `onShutdown`, or the admin API.
   */
  onOutgoing(
    handler: (
      ctx: AppCtx<TSlots, TMeta, TCaps> | undefined,
      frame: OutgoingFrame<PluginIdsOf<TSlots>>,
    ) => unknown | void,
  ): void;

  /**
   * Collect every routed handler into the final server definition the platform adapter runs.
   * Pass them as `{ handlers: [...] }` — each `base.on(...)` (and, with their
   * capabilities, `request` / `stream` / `channel`) value. A channel handler
   * enables only itself; passing the channel includes its configuration but no
   * handlers. Scheduled task bodies, lifecycle hooks, the upgrade hook, the
   * intercept, and listed capabilities are folded in automatically.
   *
   * A scoped plugin server definition (`server({ scope: 'plugin' })`) may also pass `api` —
   * the per-connection surface the host reaches via `ctx.plugin(id)`. Its `ctx`
   * is the plugin's own scoped ctx, the same one its handlers receive.
   *
   * Capabilities belong in `server({ capabilities: [...] })`, not here — passing
   * one is a type error.
   */
  assemble<const THandlers extends readonly AssembleInput[], TApi = unknown>(config: {
    readonly handlers: THandlers;
    readonly api?: (
      ctx: TScoped extends true
        ? AppCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TMeta, TCaps>
        : AdminCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TMeta, TCaps>,
    ) => TApi;
  }): ServerDefinition<
    readonly Primitive[],
    BuildContract<MergeSlots<TSlots | SlotsOf<THandlers[number]>>>,
    AppCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TMeta, TCaps>,
    TApi
  >;
}

/** A value `assemble(...)` accepts — a routed handler or channel, never a capability. */
export type AssembleInput = Contribution & { readonly __livethingCapability?: never };

/** The rate-limit slots `assemble(...)` reads off a collected channel object. @internal */
interface ChannelRateLimitSource {
  readonly __key: string;
  readonly __rateLimit?: RateLimitConfig;
  readonly __rateLimitOverrides?: ReadonlyMap<
    Primitive,
    { event: string; config: RateLimitConfig }
  >;
}

/**
 * The primitive kinds that route by event name. An event name can belong to at
 * most one of these across a scope, so two of them sharing a name collide.
 */
const ROUTING_KINDS = new Set([
  'incoming',
  'request',
  'stream-generate',
  'cursor-stream-generate',
  'recorded-stream-generate',
]);

/**
 * Refuse two handlers that bind the same event. Compile catches this at engine
 * boot too, but catching it here gives a clearer, earlier build error —
 * including a collision across different kinds (for example `base.on('x')` and
 * `base.request('x')`), which the per-kind identity check alone would miss.
 */
function assertUniqueHandlers(handlers: readonly Primitive[]): void {
  const seen = new Map<symbol, Set<string>>();
  const routedEvents = new Map<string, string>();
  for (const handler of handlers) {
    const [key, registrationId] = handler.__identity;
    let registered = seen.get(key);
    if (!registered) {
      registered = new Set();
      seen.set(key, registered);
    }

    const id = registrationId ?? '';
    if (registered.has(id)) {
      throw new Error(
        `[livething] Duplicate ${handler.__livething} handler` +
          `${registrationId ? ` for '${registrationId}'` : ''} passed to assemble(). ` +
          'An event can only be bound once — drop the duplicate.',
      );
    }

    registered.add(id);

    if (ROUTING_KINDS.has(handler.__livething)) {
      const event = (handler as { event?: string }).event;
      if (event !== undefined) {
        const owner = routedEvents.get(event);
        if (owner !== undefined && owner !== handler.__livething) {
          throw new Error(
            `[livething] Event name '${event}' is bound by both a ${owner} handler and a ` +
              `${handler.__livething} handler passed to assemble(). An event name can only be one ` +
              'kind within a scope — pick a different name.',
          );
        }

        routedEvents.set(event, handler.__livething);
      }
    }
  }
}

interface ServerRequestsPrimitive extends Primitive {
  readonly __livething: 'server-requests';
  readonly __serverRequests: ReadonlyMap<string, ResolvedServerRequest>;
  readonly __withServerRequests: (
    declarations: ReadonlyMap<string, ResolvedServerRequest>,
  ) => Primitive;
}

/** Install one server-request runtime containing every host and plugin declaration. */
function mergeServerRequestPrimitives(primitives: Primitive[]): void {
  const carriers = primitives.flatMap((primitive, index) =>
    primitive.__livething === 'server-requests'
      ? ([[index, primitive as ServerRequestsPrimitive]] as const)
      : [],
  );
  if (carriers.length < 2) return;

  const declarations = new Map<string, ResolvedServerRequest>();
  for (const [, carrier] of carriers) {
    for (const [key, declaration] of carrier.__serverRequests) {
      if (declarations.has(key)) {
        throw new Error(
          `[livething] duplicate serverRequests() declaration for '${key}'. ` +
            'Each request can only be declared once per scope.',
        );
      }

      declarations.set(key, declaration);
    }
  }

  const [firstIndex, firstCarrier] = carriers[0]!;
  const rest = carriers.slice(1);
  primitives[firstIndex] = firstCarrier.__withServerRequests(declarations);
  for (const [index] of rest.reverse()) primitives.splice(index, 1);
}

/**
 * Pair every declared scheduled task with its body and build the task
 * primitives. A declared task with no body, or a body with no declaration, is a
 * build error.
 */
function mergeScheduled(
  declarations: ReadonlyMap<string, ScheduledDeclaration>,
  bodies: ReadonlyMap<string, (ctx: TaskContext, data?: unknown) => void | Promise<void>>,
  build: ScheduledCapability['__buildScheduled'] | undefined,
): Primitive[] {
  const primitives: Primitive[] = [];
  for (const [taskId, declaration] of declarations) {
    const body = bodies.get(taskId);
    if (!body) {
      throw new Error(
        `[livething] No body for scheduled task '${taskId}'. ` +
          `Register it with base.scheduled('${taskId}', ...).`,
      );
    }

    primitives.push(build!(taskId, declaration, body));
  }

  for (const taskId of bodies.keys()) {
    if (!declarations.has(taskId)) {
      throw new Error(
        `[livething] base.scheduled('${taskId}') has no matching declaration. ` +
          `Declare it in the scheduled({ ... }) capability.`,
      );
    }
  }

  return primitives;
}

/** Turn the `upgrade` ephemeral-tag sugar `{ group: key }` into the engine's tag refs. */
function toEphemeralTagRefs(ephemeral: Record<string, string | undefined> | undefined): TagRef[] {
  if (!ephemeral) return [];

  const refs: TagRef[] = [];
  for (const [group, key] of Object.entries(ephemeral)) {
    if (key !== undefined) refs.push({ __livething: 'tag-ref', kind: 'ephemeral', group, key });
  }

  return refs;
}

/** Wrap a bootstrap `upgrade(...)` function as the engine's builder upgrade hook. */
function adaptUpgrade(fn: UpgradeFn<any>): UpgradeHandler {
  return async (request, helpers): Promise<UpgradeResult> => {
    const result = await fn(request, helpers.ctx);
    const tags = toEphemeralTagRefs(result.tags?.ephemeral);
    return {
      // An anonymous upgrade omits userId; the engine keys it by connection id.
      userId: result.userId ?? '',
      meta: result.meta,
      ...(tags.length > 0 ? { tags } : {}),
    };
  };
}

/** Symbol key for a plugin's scoped upgrade primitive. */
const SCOPED_UPGRADE_KEY = Symbol('scopedUpgrade');

/**
 * Build the carrier for a plugin's `upgrade(...)`. It is tagged `onUpgrade` so it
 * is visible to `assertSupported`, but carries `__scopedUpgrade` so
 * `namespacePluginPrimitives` reroutes its `__setup` to `registerPluginUpgrade`
 * (bound to the real plugin id) — never the app's single builder slot.
 */
function scopedUpgradePrimitive(handler: UpgradeHandler): Primitive {
  return {
    __livething: 'onUpgrade',
    __kind: 'lifecycle',
    __identity: [SCOPED_UPGRADE_KEY],
    __requires: {},
    __scopedUpgrade: true,
    handler,
    __setup() {
      // Rewritten by namespacePluginPrimitives to bind the plugin id. Left inert
      // so a stray scoped upgrade that never went through plugin(...) is a no-op.
    },
  } as unknown as Primitive;
}

/**
 * Create a LiveThing server. `server(...)` holds only bootstrap (`upgrade`,
 * `hibernation`); every feature is a capability you list. It returns a `base`
 * builder whose methods are typed against your metadata and capabilities.
 *
 * ```ts
 * import { server, emits, t } from '@livething/server';
 * import * as v from 'valibot';
 *
 * const base = server({
 *   async upgrade(request) {
 *     const username = new URL(request.url).searchParams.get('username');
 *     if (!username) throw RejectUpgrade(4001, 'Missing username');
 *     return { userId: username, meta: { username } };
 *   },
 *   capabilities: [emits({ welcome: t<{ username: string }>() })],
 * });
 *
 * export const handlePing = base.on('ping', {
 *   input: v.object({ text: v.string() }),
 *   run(ctx, input) { ctx.send('welcome', { username: input.text }); },
 * });
 *
 * export const serverDefinition = base.assemble({ handlers: [handlePing] });
 * ```
 */
export function server<
  TMeta = unknown,
  const TCaps extends readonly (AnyCapability & TopLevelCapability)[] = readonly [],
>(config: ServerConfig<TMeta, TCaps>): Base<MergeSlots<SlotsOf<TCaps[number]>>, TMeta, TCaps>;
export function server<
  TMeta = unknown,
  const TConfig extends ScopedServerConfig<
    TMeta,
    readonly (PluginSafeCapability & TopLevelCapability)[]
  > = ScopedServerConfig<TMeta, readonly (PluginSafeCapability & TopLevelCapability)[]>,
>(
  config: TConfig &
    NoExtraScopedConfigKeys<TConfig> & {
      readonly capabilities?: ScopedCapabilitiesOf<TConfig> &
        UniqueCapabilityKinds<ScopedCapabilitiesOf<TConfig>>;
    },
): Base<
  MergeSlots<SlotsOf<ScopedCapabilitiesOf<TConfig>[number]>>,
  TMeta,
  ScopedCapabilitiesOf<TConfig>,
  true
>;
export function server(config: any): any {
  assertUniqueCapabilityKinds(config.capabilities ?? [], 'server({ capabilities: [...] })');

  const scoped = config.scope === 'plugin';
  const lifecyclePrimitives: Primitive[] = [];
  const scheduledBodies = new Map<
    string,
    (ctx: TaskContext, data?: unknown) => void | Promise<void>
  >();
  const seen = new Set<string>();

  function registerOnce(slot: string, primitive: Primitive): void {
    if (seen.has(slot)) {
      throw new Error(
        `[livething] Duplicate ${slot} hook on this server. Only one ${slot} hook can be attached.`,
      );
    }

    seen.add(slot);
    lifecyclePrimitives.push(primitive);
  }

  type StreamBuild = (event: string, streamConfig: unknown) => Primitive;

  function streamBuilder(
    kind: 'plain' | 'cursor' | 'recorded',
    method: string,
    capabilityName: string,
  ): StreamBuild {
    for (const cap of config.capabilities ?? []) {
      const built = (cap as { __streamBuild?: { kind: string; build: StreamBuild } }).__streamBuild;
      if (built?.kind === kind) return built.build;
    }

    throw new Error(
      `[livething] base.${method}() needs the ${capabilityName} capability. ` +
        `Add ${capabilityName} to capabilities.`,
    );
  }

  function buildRateLimitPrimitive(
    handlerPrimitives: readonly Primitive[],
    channelObjects: ReadonlyMap<
      { __build(selectedHandlers?: ReadonlySet<Primitive>): Primitive },
      ReadonlySet<Primitive>
    >,
  ): Primitive | null {
    let buildRateLimit: RateLimitCapability['__buildRateLimit'] | undefined;
    for (const cap of config.capabilities ?? []) {
      const build = (cap as Partial<RateLimitCapability>).__buildRateLimit;
      if (!build) continue;

      if (buildRateLimit) {
        throw new Error(
          '[livething] rateLimit() is listed more than once. Set one global rule, or none.',
        );
      }

      buildRateLimit = build;
    }

    const overrides = new Map<string, Map<string, RateLimitConfig>>();
    const channelRules = new Map<string, RateLimitConfig>();
    const topOverrides = new Map<string, RateLimitConfig>();
    for (const handler of handlerPrimitives) {
      const override = (handler as { __rateLimit?: RateLimitConfig }).__rateLimit;
      const event = (handler as { event?: string }).event;
      if (override && event !== undefined) topOverrides.set(event, override);
    }

    if (topOverrides.size > 0) overrides.set('top', topOverrides);

    const channelKeys = new Set<string>();
    for (const [channel, handlers] of channelObjects) {
      const source = channel as unknown as ChannelRateLimitSource;
      channelKeys.add(source.__key);
      if (source.__rateLimit) channelRules.set(source.__key, source.__rateLimit);
      if (source.__rateLimitOverrides?.size) {
        const channelOverrides = new Map<string, RateLimitConfig>();
        for (const [handler, declaration] of source.__rateLimitOverrides) {
          if (handlers.has(handler)) channelOverrides.set(declaration.event, declaration.config);
        }

        if (channelOverrides.size > 0) {
          overrides.set(`channel:${source.__key}`, channelOverrides);
        }
      }
    }

    const hasOverrides = overrides.size > 0 || channelRules.size > 0;
    if (!buildRateLimit && hasOverrides) {
      throw new Error(
        '[livething] a per-handler rateLimit override needs the rateLimit() capability. ' +
          'Add rateLimit() to capabilities.',
      );
    }

    return buildRateLimit ? buildRateLimit({ overrides, channelRules, channelKeys }) : null;
  }

  const baseId = Symbol('livething.base');

  const base = {
    __baseId: baseId,
    on(event: string, config: OnConfig<any, any, any, any> & { rateLimit?: RateLimitConfig }) {
      const primitive = incomingFactory(event, config.run as any, {
        validator: config.input,
        allowInterleaving: config.allowInterleaving,
      });
      if (config.rateLimit) {
        (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = config.rateLimit;
      }

      return primitive;
    },
    request(event: string, requestConfig: ServerRequestConfigParameter) {
      type Build = (e: string, c: ServerCParameter) => Primitive;
      let build: Build | undefined;
      for (const cap of config.capabilities ?? []) {
        const candidate = (cap as { __buildClientRequest?: Build }).__buildClientRequest;
        if (candidate) build = candidate;
      }

      if (!build) {
        throw new Error(
          '[livething] base.request() needs clientRequests(). Add clientRequests() to capabilities.',
        );
      }

      const primitive = build(event, {
        input: requestConfig.input,
        allowInterleaving: requestConfig.allowInterleaving,
        run: requestConfig.run,
      });

      if (requestConfig.rateLimit) {
        (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = requestConfig.rateLimit;
      }

      return primitive;
    },
    scheduled(taskId: string, config: ServerConfigParameter) {
      if (scheduledBodies.has(taskId)) {
        throw new Error(
          `[livething] Duplicate scheduled task '${taskId}' on this server. ` +
            'A task can only be registered once.',
        );
      }

      scheduledBodies.set(taskId, config.run);
    },
    stream(event: string, streamConfig: unknown) {
      return streamBuilder('plain', 'stream', 'stream()')(event, streamConfig);
    },
    cursorStream(event: string, streamConfig: unknown) {
      return streamBuilder('cursor', 'cursorStream', 'cursorStream()')(event, streamConfig);
    },
    recordedStream(event: string, streamConfig: unknown) {
      return streamBuilder('recorded', 'recordedStream', 'recordedStream()')(event, streamConfig);
    },
    channel(pattern: unknown, channelConfig?: unknown) {
      let factory: ((p: unknown, c: unknown, deps: unknown) => unknown) | undefined;
      const streamBuilders: Record<string, unknown> = {};
      let buildCustomReplay: unknown;
      let buildBuiltinReplay: unknown;
      let buildClientRequest: unknown;

      let registerServerRequests: unknown;
      for (const cap of config.capabilities ?? []) {
        const candidate = (
          cap as { __channelFactory?: (p: unknown, c: unknown, deps: unknown) => unknown }
        ).__channelFactory;
        if (candidate) factory = candidate;
        const streamBuild = (cap as { __streamBuild?: { kind: string; build: unknown } })
          .__streamBuild;
        if (streamBuild) streamBuilders[streamBuild.kind] = streamBuild.build;
        const customReplay = (cap as { __buildCustomReplay?: unknown }).__buildCustomReplay;

        if (customReplay) buildCustomReplay = customReplay;
        const builtinReplay = (cap as { __buildBuiltinReplay?: unknown }).__buildBuiltinReplay;
        if (builtinReplay) buildBuiltinReplay = builtinReplay;
        const request = (cap as { __buildClientRequest?: unknown }).__buildClientRequest;
        if (request) buildClientRequest = request;

        const registerSR = (cap as { __registerServerRequests?: unknown }).__registerServerRequests;
        if (registerSR) registerServerRequests = registerSR;
      }

      if (!factory) {
        throw new Error(
          '[livething] base.channel() needs the channels() capability. Add channels() to capabilities.',
        );
      }

      return factory(pattern, channelConfig, {
        baseId,
        streamBuilders,
        buildCustomReplay,
        buildBuiltinReplay,
        buildClientRequest,
        registerServerRequests,
      });
    },
    onInit(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('onInit', onInit(handler));
    },
    onConnect(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('onConnect', onConnect(handler));
    },
    onDisconnect(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('onDisconnect', onDisconnect(handler));
    },
    onPing(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('onPing', onPing(handler));
    },
    onPong(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('onPong', onPong(handler));
    },
    onError(handler: (ctx: any, error: unknown, event?: string) => void | Promise<void>) {
      registerOnce(
        'onError',
        onError((ctx: any, error: unknown, event?: string) =>
          handler(adaptChannelContext(ctx), error, event),
        ),
      );
    },
    onValidationError(handler: (ctx: any, event: string, error: unknown) => void | Promise<void>) {
      registerOnce(
        'onValidationError',
        onValidationError((ctx: any, event: string, error: unknown) =>
          handler(adaptChannelContext(ctx), event, error),
        ),
      );
    },
    onShutdown(handler: (ctx: any) => void | Promise<void>) {
      registerOnce('onShutdown', onShutdown(handler));
    },
    intercept(handler: (ctx: any, frame: InterceptFrame) => unknown | void) {
      registerOnce('intercept', interceptFactory(handler));
    },
    onOutgoing(handler: (ctx: any, frame: OutgoingFrame) => unknown | void) {
      registerOnce('onOutgoing', outgoingHookFactory(handler));
    },
    replay(hooks: CustomReplayHooks) {
      let build: ReplayCustomCapability['__buildCustomReplay'] | undefined;
      for (const cap of config.capabilities ?? []) {
        const candidate = (cap as Partial<ReplayCustomCapability>).__buildCustomReplay;
        if (candidate) {
          if (build) {
            throw new Error('[livething] replay.custom() is listed more than once. List it once.');
          }

          build = candidate;
        }
      }

      if (!build) {
        throw new Error(
          '[livething] base.replay() needs the replay.custom() capability. ' +
            'Add replay.custom() to capabilities.',
        );
      }

      registerOnce('replay', build(hooks));
    },
    assemble(assembleConfig: ServerAssembleConfigParameter) {
      const items = assembleConfig.handlers;
      const api = assembleConfig.api;
      assertUniquePluginIds(config.capabilities ?? []);
      assertPluginDependencies(config.capabilities ?? []);
      assertNoChannelOnlyCapabilities(config.capabilities ?? []);

      const handlerPrimitives: Primitive[] = [];
      const channelObjects = new Map<
        { __build(selectedHandlers?: ReadonlySet<Primitive>): Primitive },
        Set<Primitive>
      >();
      for (const item of items) {
        if ((item as { __livethingCapability?: unknown }).__livethingCapability) {
          throw new Error(
            '[livething] A capability was passed to assemble(). List capabilities in ' +
              'server({ capabilities: [...] }) and pass routed handler values or channel objects to assemble().',
          );
        }

        const channel = (
          item as {
            __channel?: { __build(selectedHandlers?: ReadonlySet<Primitive>): Primitive };
          }
        ).__channel;
        if (channel) {
          if ((item as { __livethingChannel?: boolean }).__livethingChannel) {
            if (!channelObjects.has(channel)) channelObjects.set(channel, new Set());
          } else {
            const handler = (item as { __handler?: Primitive }).__handler;
            if (handler) {
              if (!channelObjects.has(channel)) channelObjects.set(channel, new Set());
              channelObjects.get(channel)?.add(handler);
            }
          }

          continue;
        }

        handlerPrimitives.push(item as Primitive);
      }

      assertUniqueHandlers(handlerPrimitives);

      const channelPrimitives = [...channelObjects].map((entry) => entry[0].__build(entry[1]));

      const scheduledDeclarations = new Map<string, ScheduledDeclaration>();
      let buildScheduled: ScheduledCapability['__buildScheduled'] | undefined;
      for (const cap of config.capabilities ?? []) {
        const declared = (cap as Partial<ScheduledCapability>).__scheduled;
        if (declared) {
          for (const [taskId, declaration] of declared)
            scheduledDeclarations.set(taskId, declaration);
          buildScheduled = (cap as Partial<ScheduledCapability>).__buildScheduled;
        }
      }

      const scheduledPrimitives = mergeScheduled(
        scheduledDeclarations,
        scheduledBodies,
        buildScheduled,
      );

      const rateLimitPrimitive = buildRateLimitPrimitive(handlerPrimitives, channelObjects);

      const primitives: Primitive[] = [];
      if (config.upgrade) {
        primitives.push(
          scoped
            ? scopedUpgradePrimitive(adaptUpgrade((request) => config.upgrade(request)))
            : onUpgrade(adaptUpgrade(config.upgrade)),
        );
      }

      if (config.hibernation?.enabled) primitives.push(hibernationFactory(true));
      for (const cap of config.capabilities ?? []) primitives.push(...cap.__primitives);
      if (rateLimitPrimitive) primitives.push(rateLimitPrimitive);

      primitives.push(...lifecyclePrimitives);
      primitives.push(...handlerPrimitives);
      primitives.push(...scheduledPrimitives);
      primitives.push(...channelPrimitives);
      mergeServerRequestPrimitives(primitives);

      const declaredErrors = primitives
        .filter((p): p is ErrorsPrimitive => p.__livething === 'errors')
        .flatMap((p) => p.defs);
      collectUnique(declaredErrors, (def) => def.code, {
        kind: 'error code',
        context: 'server({ capabilities: [...] })',
      });

      const builtinReplayCount = primitives.filter(
        (p) => p.__livething === 'replay' && !(p as { disabled?: boolean }).disabled,
      ).length;
      const hasCustomReplay = primitives.some((p) => p.__livething === 'replayCustom');
      if (builtinReplayCount > 1) {
        throw new Error(
          '[livething] built-in replay (replay.history() / replay.snapshot()) is listed more than ' +
            'once. Use one replay strategy per scope.',
        );
      }

      if (builtinReplayCount > 0 && hasCustomReplay) {
        throw new Error(
          '[livething] built-in replay and custom base.replay() are both configured. ' +
            'Use one or the other.',
        );
      }

      const features = new Set<string>();
      for (const cap of config.capabilities ?? []) {
        for (const feature of cap.__features) features.add(feature);
      }

      if (config.hibernation?.enabled) features.add('hibernation');

      function isDurableGenerate(p: Primitive): boolean {
        return (
          p.__livething === 'cursor-stream-generate' || p.__livething === 'recorded-stream-generate'
        );
      }

      // A durable stream can be declared at the top level or nested inside a
      // channel, so scan both — otherwise a channel-only durable stream would
      // miss the retention sweep below.
      const hasDurableStream = primitives.some(
        (p) =>
          isDurableGenerate(p) ||
          (p.__livething === 'channel' &&
            ((p as { primitives?: readonly Primitive[] }).primitives ?? []).some(
              isDurableGenerate,
            )),
      );

      // Install the durable-stream retention sweep only when a cursor/recorded
      // stream handler actually exists — not merely because the capability is
      // listed. Both stream capabilities carry the same sweep builder, and the
      // engine rejects duplicate scheduled task names, so register exactly one.
      if (hasDurableStream) {
        for (const cap of config.capabilities ?? []) {
          const sweep = (cap as { __durableSweep?: () => Primitive }).__durableSweep;
          if (typeof sweep === 'function') {
            primitives.push(sweep());
            break;
          }
        }
      }

      // Enforce every primitive's capability requirements against what is
      // listed. On an app a missing one throws; on a plugin a host-owned
      // requirement is returned as a host dependency the host must satisfy.
      const { hostDependencies } = resolveCapabilityRequirements(
        primitives,
        config.capabilities ?? [],
        { scoped },
      );

      if (config.users) {
        assertOptionalPositiveInteger(
          config.users.maxConnections,
          'maxConnections',
          'server({ users })',
        );
      }

      return Object.freeze({
        __livething: 'server' as const,
        __baseId: baseId,
        primitives: Object.freeze(primitives) as readonly Primitive[],
        __features: Object.freeze(features) as ReadonlySet<string>,
        ...(config.translate ? { __translate: config.translate } : {}),
        ...(config.users ? { __usersPolicy: config.users } : {}),
        // Read by plugin() on a scoped server definition, by Engine.admin() on an app one.
        ...(api ? { __apiFactory: api } : {}),
        ...(scoped
          ? { __scoped: true as const, __hostDependencies: Object.freeze(hostDependencies) }
          : {}),
      });
    },
  };

  return base as unknown as Base<any, any, any, any>;
}
