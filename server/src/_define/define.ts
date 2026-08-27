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
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { InterceptFrame, OutgoingFrame } from '~/intercept/intercept.ts';
import type { UpgradeHandler, UpgradeResult } from '~/lifecycle/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';
import type { RateLimitCapability } from '~/rate-limit/capability.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';
import type { CustomReplayHooks, ReplayCustomCapability } from '~/replay/capability.ts';
import type { ServerRequestDeclaration } from '~/request/capability.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { ScheduledCapability, ScheduledDeclaration } from '~/scheduled/capability.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { TranslatorFactory } from '~/translation/translator.ts';
import type { Validator } from '~/types.ts';
import { resolveCapabilityRequirements } from './capability-requirements.ts';
// Keep every value import off `./plugin.ts` — it is a package entry, so a
// bundler keeps it whole and one binding drags the plugin runtime into apps
// that list no plugins. Type imports are free.
import {
  assertHostObservationGranted,
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
} from './capability.ts';
import type { BuildContract, InferInput } from './contract.ts';
import type { GrantableCapability, PluginEnvRequirements } from './plugin.ts';

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

/** The `upgrade(...)` function shape. Receives the raw upgrade request. */
export type UpgradeFn<TMeta, TEphemeralGroups extends string = string> = (
  request: Request,
) => UpgradeReturn<TMeta, TEphemeralGroups> | Promise<UpgradeReturn<TMeta, TEphemeralGroups>>;

/** The ephemeral tag-group names declared across a list of capabilities. */
type EphemeralGroupsOf<TCaps extends readonly AnyCapability[]> = keyof SlotOr<
  MergeSlots<SlotsOf<TCaps[number]>>,
  'ephemeralTags'
> &
  string;

/**
 * The configuration passed to `define(...)`. Holds only bootstrap — the things
 * the runtime needs to exist and accept a connection. Every feature beyond this
 * is an entry in `capabilities`.
 */
export interface DefineConfig<
  TEnv = unknown,
  TMeta = unknown,
  // Defaults to no capabilities, not to every capability. `define(...)` infers
  // the real list from the config it is given; the default only applies when
  // this type is written out by hand, and a list of `AnyCapability` there would
  // widen every capability brand to `string` — making the ctx gating pass for
  // capabilities the server never listed.
  TCaps extends readonly AnyCapability[] = readonly [],
> {
  /** The application environment type, marked with `t<Env>()`. */
  readonly env: TypeMarker<TEnv>;
  /** Auth gate. Return `{ userId, meta }` to accept, or throw `RejectUpgrade(...)` to deny. */
  readonly upgrade?: UpgradeFn<TMeta, EphemeralGroupsOf<TCaps>>;
  /** Turn on Cloudflare Durable Object hibernation (which disables server pings). */
  readonly hibernation?: { readonly enabled: boolean };
  /** Translate one foreign WebSocket wire format into WSKit at this server's connection edge. */
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
  readonly capabilities?: TCaps;
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
 * `define({ scope: 'plugin' })` is a compile error. A plugin declares a
 * prerequisite on them instead.
 */
export type PluginSafeCapability = AnyCapability & { __hostOnly?: never };

/**
 * A capability accepted at the host or plugin top level — every capability
 * except a channel-only one. Channel-only capabilities (`inbox()`,
 * `readReceipts()`) carry a `__channelOnly` marker, so listing one in
 * `define({ capabilities })` or `define({ scope: 'plugin', capabilities })` is
 * a compile error — they only belong inside a channel's own `capabilities`.
 */
export type TopLevelCapability = AnyCapability & { __channelOnly?: never };

/**
 * The configuration for a **plugin's** scoped handler (`scope: 'plugin'`).
 * Authored with the same builders as an app, but it declares only its own
 * namespaced slice and inherits the host's runtime environment, transport, and
 * global singletons. Its optional `env` field is a type-only requirement; the
 * host still supplies the runtime value and the plugin cannot own host-level
 * capabilities (see `plugin(...)`).
 */
export interface ScopedDefineConfig<
  TMeta = unknown,
  TCaps extends readonly PluginSafeCapability[] = readonly PluginSafeCapability[],
  TEnv = unknown,
> {
  /** Marks this as a plugin's scoped handler. */
  readonly scope: 'plugin';
  /** The environment shape this plugin requires from its host, marked with `t<Env>()`. */
  readonly env?: TypeMarker<TEnv>;
  /**
   * The plugin's upgrade gate. Runs before the app's upgrade in the inbound
   * onion: it sees only the raw request, not the app's identity. Return
   * `meta` (shallow-merged, app wins on key conflict) and/or `tags`
   * (concatenated); throw `RejectUpgrade(...)` to veto the handshake. A plugin
   * may own `userId` — but only one upgrade hook (the app's or one plugin's)
   * may return it, or the build/runtime errors.
   */
  readonly upgrade?: UpgradeFn<TMeta, EphemeralGroupsOf<TCaps>>;
  /** The features this plugin uses. Host-owned capabilities are a compile error here. */
  readonly capabilities?: TCaps;
}

/** Reads the capabilities from an inferred scoped config object. @internal */
type ScopedCapabilitiesOf<TConfig> = TConfig extends {
  readonly capabilities?: infer TCaps;
}
  ? TCaps extends readonly AnyCapability[]
    ? TCaps
    : readonly []
  : readonly [];

/** Reads the type-only environment requirement from an inferred scoped config. @internal */
type ScopedEnvironmentOf<TConfig> = TConfig extends {
  readonly env?: TypeMarker<infer TEnv>;
}
  ? TEnv
  : unknown;

/** Keeps excess-property checks when a scoped config is inferred through a generic. @internal */
type NoExtraScopedConfigKeys<TConfig> = {
  readonly [K in Exclude<keyof TConfig, keyof ScopedDefineConfig>]: never;
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
  TEnv,
  TMeta,
  TSchema extends Validator | undefined,
  TCaps extends readonly AnyCapability[] = readonly [],
> = {
  /** Optional schema validating the incoming payload. Omit to accept any payload (typed `unknown`). */
  readonly input?: TSchema;
  /** Runs each time the client sends this event, with the validated payload. */
  run(ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>, input: InferInput<TSchema>): void | Promise<void>;
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
  TEnv,
  TMeta,
  TSchema extends Validator | undefined,
  TResponse,
  TCaps extends readonly AnyCapability[] = readonly [],
> = {
  /** Optional schema validating the request payload. Omit to accept any payload (typed `unknown`). */
  readonly input?: TSchema;
  /** Runs the request and returns the reply. The reply type is inferred from the return. */
  run(
    ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>,
    input: InferInput<TSchema>,
  ): TResponse | Promise<TResponse>;
} & RateLimitField<TCaps>;

/** Builder method granted by the `requests()` capability. */
export interface RequestMethods<TSlots, TEnv, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Register a handler for one client→server request. Like `base.on`, but the
   * client awaits a reply: whatever the handler returns becomes the response,
   * and its type is inferred from the return. Returning nothing rejects the
   * client's pending request.
   */
  request<
    TEvent extends string,
    TSchema extends Validator | undefined = undefined,
    TResponse = void,
  >(
    event: TEvent,
    config: RequestConfig<TSlots, TEnv, TMeta, TSchema, TResponse, TCaps>,
  ): RequestHandlerValue<TEvent, InferInput<TSchema>, Awaited<TResponse>>;
}

/** The scheduled-task map (task id → payload type), read off the merged contract slots. */
type ScheduledMap<TSlots> = SlotOr<TSlots, 'scheduled'>;

/** The value `base.scheduled(...)` returns — a carrier matched to its declaration at assembly. */
export interface ScheduledHandlerValue<TTaskId extends string> extends Contribution<{}> {
  /** Marks this value as a scheduled-task body for `assemble(...)` to merge. @internal */
  readonly __wskitScheduledHandler: true;
  /** The task id this body runs. @internal */
  readonly taskId: TTaskId;
  /** The task body. @internal */
  readonly run: (ctx: TaskContext, data?: unknown) => void | Promise<void>;
}

/** Configuration object for `base.scheduled(...)`. */
export interface ScheduledConfig<TEnv, TMeta, TData> {
  /** Runs when the task fires. Receives the typed payload for tasks that declare one. */
  run: TData extends undefined
    ? (ctx: TaskContext<TEnv, TMeta>) => void | Promise<void>
    : (ctx: TaskContext<TEnv, TMeta>, data: TData) => void | Promise<void>;
}

/** Builder method granted by the `scheduled()` capability. */
export interface ScheduledMethods<TSlots, TEnv, TMeta> {
  /**
   * Register the body for one declared scheduled task. The task id and its
   * payload type come from the `scheduled(...)` capability; binding an
   * undeclared task is a type error.
   */
  scheduled<TTaskId extends keyof ScheduledMap<TSlots> & string>(
    taskId: TTaskId,
    config: ScheduledConfig<TEnv, TMeta, ScheduledMap<TSlots>[TTaskId]>,
  ): ScheduledHandlerValue<TTaskId>;
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
   * Pause the generator until the outbound buffer is healthy, then resume.
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
type StreamCtx<TSlots, TEnv, TMeta, TNudges, TCaps extends readonly AnyCapability[]> = AppCtx<
  TSlots,
  TEnv,
  TMeta,
  TCaps
> & {
  stream: StreamHandleBase & NudgesHandle<TNudges>;
};

/** Configuration object for `base.stream(...)`. */
export interface StreamConfig<
  TSlots,
  TEnv,
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
    ctx: StreamCtx<TSlots, TEnv, TMeta, TNudges, TCaps>,
    input: InferInput<TInput>,
  ): AsyncGenerator<TChunk, void, unknown>;
}

/** Builder method granted by the `stream()` capability. */
export interface StreamMethods<TSlots, TEnv, TMeta, TCaps extends readonly AnyCapability[]> {
  /** Register a plain server-pushed stream. */
  stream<
    TEvent extends string,
    TChunk = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: StreamConfig<TSlots, TEnv, TMeta, TInput, TChunk, TNudges, TCaps>,
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
  /** How long an ended stream is kept so a quick reconnect can still resume. */
  readonly retentionAfterEndMs?: number;
}

/** The `ctx` a resumable stream generator receives — `ctx.stream` adds cursor controls. */
type ResumableStreamCtx<
  TSlots,
  TEnv,
  TMeta,
  TChunk,
  TCursor,
  TNudges,
  TCaps extends readonly AnyCapability[],
> = AppCtx<TSlots, TEnv, TMeta, TCaps> & {
  stream: StreamHandleBase &
    NudgesHandle<TNudges> & {
      /** The cursor recorded on the last run, or `null` on the first run. */
      cursor: TCursor | null;
      /** 1 on the first run, 2+ on each resume. */
      attempt: number;
      /** Attach a cursor to a chunk so the framework can resume from it. */
      withCursor(chunk: TChunk, cursor: TCursor): TChunk;
    };
};

/** Configuration object for `base.resumableStream(...)`. */
export interface ResumableStreamConfig<
  TSlots,
  TEnv,
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
    ctx: ResumableStreamCtx<TSlots, TEnv, TMeta, TChunk, TCursor, TNudges, TCaps>,
    input: InferInput<TInput>,
  ): AsyncGenerator<TChunk, void, unknown>;
}

/** Builder method granted by the `resumableStream()` capability. */
export interface ResumableStreamMethods<
  TSlots,
  TEnv,
  TMeta,
  TCaps extends readonly AnyCapability[],
> {
  /** Register a resumable server-pushed stream. */
  resumableStream<
    TEvent extends string,
    TChunk = unknown,
    TCursor = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: ResumableStreamConfig<TSlots, TEnv, TMeta, TInput, TChunk, TCursor, TNudges, TCaps>,
  ): StreamHandlerValue<
    TEvent,
    {
      payload: InferInput<TInput>;
      chunk: TChunk;
      cursor: TCursor;
      nudges: NudgesContract<TNudges>;
    },
    'resumableStreams'
  >;
}

/** Configuration object for `base.recordedStream(...)`. */
export interface RecordedStreamConfig<
  TSlots,
  TEnv,
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
    ctx: StreamCtx<TSlots, TEnv, TMeta, TNudges, TCaps>,
    input: InferInput<TInput>,
  ): AsyncGenerator<TChunk, void, unknown>;
}

/** Builder method granted by the `recordedStream()` capability. */
export interface RecordedStreamMethods<
  TSlots,
  TEnv,
  TMeta,
  TCaps extends readonly AnyCapability[],
> {
  /** Register a recorded server-pushed stream. */
  recordedStream<
    TEvent extends string,
    TChunk = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: RecordedStreamConfig<TSlots, TEnv, TMeta, TInput, TChunk, TNudges, TCaps>,
  ): StreamHandlerValue<
    TEvent,
    { payload: InferInput<TInput>; chunk: TChunk; nudges: NudgesContract<TNudges> },
    'recordedStreams'
  >;
}

/** The payload type one channel emit declaration carries. */
type EmitPayloadOf<T> =
  T extends TypeMarker<infer U> ? U : T extends Validator<infer U> ? U : unknown;

/** The map of a channel's emit declarations → payload types. */
type EmitMap<TEmits> = { [K in keyof TEmits & string]: EmitPayloadOf<TEmits[K]> };

/** The `out` (server→client payload) type one channel request declaration carries. */
type ServerRequestPayloadOf<TDeclaration> = TDeclaration extends { out: TypeMarker<infer U> }
  ? U
  : unknown;

/** The `in` (client→server answer) type one channel request declaration carries; `void` for an acknowledgement. */
type ServerRequestResponseOf<TDeclaration> = TDeclaration extends { in: Validator<infer U> }
  ? U
  : void;

/** The channel's `serverRequests` contract slot, built from its `outgoing.requests` declarations. */
type ServerRequestMap<TDeclarations> = {
  [K in keyof TDeclarations & string]: {
    payload: ServerRequestPayloadOf<TDeclarations[K]>;
    response: ServerRequestResponseOf<TDeclarations[K]>;
  };
};

/** The subscribe-payload type for a channel's `subscribe` schema, or `never` when absent. */
type SubscribePayloadOf<TSubscribe> = TSubscribe extends Validator<infer U> ? U : never;

/** A channel handle inside a channel handler — sends are typed to the channel's emits. */
interface ChannelHandle<TParams, TOutgoing, TMeta> {
  /** The matched channel name, e.g. `'lobby'` or `'rooms:abc'`. */
  readonly name: string;
  /** The family key for a dynamic channel, or `null` for a static one. */
  readonly family: string | null;
  /** The `{name}` captures from a dynamic pattern. */
  readonly params: TParams;
  /**
   * Send a channel event. Targets the calling connection by default; pass
   * `{ to }` to target a specific member — a `ConnectionRef`, a `UserRef` (all
   * that user's member sockets), or a `TagRef`/`TagGroupHandle` (members that
   * also hold the tag). Returns the number of sockets delivered to.
   */
  send<E extends keyof TOutgoing & string>(
    event: E,
    payload: TOutgoing[E],
    options?: { to?: ChannelRecipient },
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
   * Remove a user (or everyone holding a tag) from this channel. Pass
   * `revoke: true` to also drop the durable membership row so the user does
   * not auto-rejoin on reconnect.
   */
  kick(target: UserRef | TagRef, opts: { reason: string; revoke?: boolean }): Promise<void>;
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
 * The `request`/`broadcastRequest` arms added to `ctx.channel` when `requests()`
 * is listed. They resolve the CHANNEL's own `outgoing.requests` declarations
 * (short names), not the top-level `requests({...})` ones.
 */
type ChannelRequestArm<TServerRequests, TCaps extends readonly AnyCapability[]> =
  'requests' extends BrandsOf<TCaps>
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
        } & BroadcastRequestArm<ChannelBroadcastRequests<TServerRequests>>
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
  TEnv,
  TMeta,
  TParams,
  TOutgoing extends Record<string, unknown>,
  TCaps extends readonly AnyCapability[] = readonly [],
  TServerRequests = {},
  TChannelBrand extends string = never,
> = Omit<AppCtx<TSlots, TEnv, TMeta, TCaps>, 'sendReplay'> & {
  readonly channel: ChannelHandle<TParams, TOutgoing, TMeta> &
    ChannelRequestArm<TServerRequests, TCaps> &
    ChannelCapabilityArm<TChannelBrand, TOutgoing>;
};

/**
 * The looser `ctx` a channel gate/lifecycle hook receives (sends accept any
 * channel event). Replay is exposed, when active, on `ctx.channel.sendReplay`;
 * channel contexts do not expose the root `ctx.sendReplay` method.
 */
export type ChannelGateCtx<
  TSlots,
  TEnv,
  TMeta,
  TCaps extends readonly AnyCapability[] = readonly [],
  TChannelBrand extends string = never,
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
  /** `true` for check/commit/revalidate, whose ctx omits channel-only handles. */
  TIsSubscribeGate extends boolean = false,
  TServerRequests = {},
> = Omit<AppCtx<TSlots, TEnv, TMeta, TCaps, TIsSubscribeGate>, 'sendReplay'> & {
  readonly channel: ChannelHandle<Record<string, string>, Record<string, unknown>, TMeta> &
    ChannelRequestArm<TServerRequests, TCaps> &
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

/**
 * The constraint on a channel's inferred `outgoing.requests` map. With the
 * `requests()` capability listed it is the normal declaration map; without it, every
 * value must be `never`, so declaring any channel request without `requests()`
 * is a compile error (the inferred map fails this constraint). Gating the
 * constraint — rather than the field — is what enforces it through the `const
 * TRequests` inference position. The runtime also throws as a backstop.
 */
type RequestsDeclarationConstraint<TCaps extends readonly AnyCapability[]> =
  'requests' extends BrandsOf<TCaps>
    ? Record<string, ServerRequestDeclaration>
    : Record<string, never>;

/** Configuration object for `base.channel(...)`. */
export type ChannelConfig<
  TSlots,
  TEnv,
  TMeta,
  TCaps extends readonly AnyCapability[] = readonly [],
  TSubscribe extends Validator | undefined = Validator | undefined,
  TCheckResult = unknown,
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** Server→client events and requests this channel declares. */
  readonly outgoing?: {
    readonly emits?: Record<string, TypeMarker<any>>;
    /**
     * Server→client requests this channel asks its members. Same `{ out, in? }`
     * shape as the top-level `requests({...})`. Declaring these needs
     * the `requests()` capability listed; the channel overloads gate it at
     * compile time and the runtime throws as a backstop.
     */
    readonly requests?: Record<string, ServerRequestDeclaration>;
  };
  /** Schema validating the payload a client sends on subscribe. */
  readonly subscribe?: TSubscribe;
  /**
   * Async gate before the subscriber is counted. Return a value forwarded to
   * `commit`; throw to reject. Written inside this same config object, before
   * `capabilities` and channel-owned `outgoing.requests` can be read back, so
   * `ctx.channel.inbox`, `ctx.channel.readReceipts`, and
   * `ctx.channel.request` / `broadcastRequest` are not available here — read
   * channel-only surfaces in `subscribe`, `unsubscribe`, or `sessionEnd`
   * instead.
   */
  check?: (
    ctx: ChannelGateCtx<TSlots, TEnv, TMeta, TCaps, never, TOutgoing, true>,
    input: InferInput<TSubscribe>,
  ) => TCheckResult | Promise<TCheckResult>;
  /**
   * Sync gate after the subscriber is counted (members include the joiner).
   * Throw to reject. Written inside this same config object, before
   * `capabilities` and channel-owned `outgoing.requests` can be read back, so
   * `ctx.channel.inbox`, `ctx.channel.readReceipts`, and
   * `ctx.channel.request` / `broadcastRequest` are not available here — read
   * channel-only surfaces in `subscribe`, `unsubscribe`, or `sessionEnd`
   * instead.
   */
  commit?: (
    ctx: ChannelGateCtx<TSlots, TEnv, TMeta, TCaps, never, TOutgoing, true>,
    checkResult: Awaited<TCheckResult>,
  ) => void;
  /**
   * Re-authorize on auto-rejoin after reconnect (persistent memberships).
   * Throw to drop. Written inside this same config object, before
   * `capabilities` and channel-owned `outgoing.requests` can be read back, so
   * `ctx.channel.inbox`, `ctx.channel.readReceipts`, and
   * `ctx.channel.request` / `broadcastRequest` are not available here — read
   * channel-only surfaces in `subscribe`, `unsubscribe`, or `sessionEnd`
   * instead.
   */
  revalidate?: (
    ctx: ChannelGateCtx<TSlots, TEnv, TMeta, TCaps, never, TOutgoing, true>,
  ) => void | Promise<void>;
  /** Whether membership survives a reconnect (default `'persistent'`). */
  readonly membership?: 'persistent' | 'ephemeral';
  /**
   * Per-channel built-in replay opt-in/out, cascading from `define`. `true` is
   * shorthand for history mode with defaults; `false` opts this channel out.
   */
  readonly replay?: boolean;
  /**
   * This channel's own channel-only capabilities — `inbox()` for guaranteed
   * per-member delivery, `readReceipts()` (needs `inbox()` on the same
   * channel) for the read cursor. Unlike the host's `capabilities`, this list
   * is scoped to the one channel.
   */
  readonly capabilities?: readonly ChannelOnlyCapability<{}, never, string>[];
} & ChannelRateLimitField<TCaps>;

/**
 * A channel handler's return value. It declares the channel's own slice (emits,
 * subscribe payload, addressing) **and** this handler's slice under the channel,
 * and carries a reference to the channel — so passing a single handler to
 * `assemble()` gives `InferClient` the whole channel surface.
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

/** Intersect a channel's capability flags onto its contract slice. */
type ChannelFlagsContribution<TKey extends string, TBrand extends string> = Contribution<{
  channels: { [K in TKey]: ChannelCapabilityFlags<TBrand> };
}>;

/** The channel's own contract slice — declared from its config and pattern. */
type ChannelOwnSlice<
  TParams,
  TOutgoing extends Record<string, unknown>,
  TAddressing extends string,
  TSubscribe,
  TServerRequests = {},
> = {
  outgoing: TOutgoing;
  serverRequests: TServerRequests;
  params: TParams;
  __addressing: TAddressing;
} & ([TSubscribe] extends [never] ? {} : { subscribePayload: TSubscribe });

/** Configuration object for a channel `stream`. */
type ChannelStreamConfig<
  TSlots,
  TEnv,
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
    ctx: ChannelCtx<
      TSlots,
      TEnv,
      TMeta,
      TParams,
      TOutgoing,
      TCaps,
      TServerRequests,
      TChannelBrand
    > & {
      stream: StreamHandleBase & NudgesHandle<TNudges>;
    },
    input: InferInput<TInput extends Validator | undefined ? TInput : undefined>,
  ): AsyncGenerator<TChunk, void, unknown>;
} & RateLimitField<TCaps>;

/** Configuration object for a channel `recordedStream` — adds the durable retention options. */
type ChannelRecordedStreamConfig<
  TSlots,
  TEnv,
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
    ctx: ChannelCtx<
      TSlots,
      TEnv,
      TMeta,
      TParams,
      TOutgoing,
      TCaps,
      TServerRequests,
      TChannelBrand
    > & {
      stream: StreamHandleBase & NudgesHandle<TNudges>;
    },
    input: InferInput<TInput extends Validator | undefined ? TInput : undefined>,
  ): AsyncGenerator<TChunk, void, unknown>;
} & RateLimitField<TCaps>;

/** Configuration object for a channel `resumableStream` — adds cursor controls and retention. */
type ChannelResumableStreamConfig<
  TSlots,
  TEnv,
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
    ctx: ChannelCtx<
      TSlots,
      TEnv,
      TMeta,
      TParams,
      TOutgoing,
      TCaps,
      TServerRequests,
      TChannelBrand
    > & {
      stream: StreamHandleBase &
        NudgesHandle<TNudges> & {
          /** The cursor recorded on the last run, or `null` on the first run. */
          cursor: TCursor | null;
          /** 1 on the first run, 2+ on each resume. */
          attempt: number;
          /** Attach a cursor to a chunk so the framework can resume from it. */
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
 * lifecycle methods mutate and return void. Pass any handler value — or the
 * channel itself — to `assemble()`; the whole channel is pulled in once.
 */
interface ChannelStreamMethod<
  TSlots,
  TEnv,
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
  /** Register a plain stream scoped to this channel. */
  stream<
    TEvent extends string,
    TChunk = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: ChannelStreamConfig<
      TSlots,
      TEnv,
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
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests>,
    {
      streams: Record<
        TEvent,
        { payload: InferInput<TInput>; chunk: TChunk; nudges: NudgesContract<TNudges> }
      >;
    }
  >;
}

interface ChannelResumableStreamMethod<
  TSlots,
  TEnv,
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
  /** Register a resumable stream scoped to this channel. */
  resumableStream<
    TEvent extends string,
    TChunk = unknown,
    TCursor = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: ChannelResumableStreamConfig<
      TSlots,
      TEnv,
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
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests>,
    {
      resumableStreams: Record<
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
  TEnv,
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
  /** Register a recorded stream scoped to this channel. */
  recordedStream<
    TEvent extends string,
    TChunk = unknown,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: ChannelRecordedStreamConfig<
      TSlots,
      TEnv,
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
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests>,
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
  TEnv,
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
      TEnv,
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
  ('resumableStream' extends TBrand
    ? ChannelResumableStreamMethod<
        TSlots,
        TEnv,
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
        TEnv,
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
  TEnv,
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
  TEnv,
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
    TEnv,
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
  TEnv,
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
  | 'resumableStream'
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
      [K in TKey]: ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests>;
    };
  }> &
  ChannelCoreMethods<
    TSlots,
    TEnv,
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
  ('requests' extends BrandsOf<TCaps>
    ? ChannelRequestMethods<
        TSlots,
        TEnv,
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
    ? ChannelInterceptMethods<TSlots, TEnv, TMeta, TCaps, TChannelBrand, TOutgoing, TServerRequests>
    : {});

/** The `on` / lifecycle methods every channel object carries. */
export interface ChannelCoreMethods<
  TSlots,
  TEnv,
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
  /** Register a client→server event handler scoped to this channel. */
  on<TEvent extends string, TInput extends Validator | undefined = undefined>(
    event: TEvent,
    config: {
      input?: TInput;
      run(
        ctx: ChannelCtx<
          TSlots,
          TEnv,
          TMeta,
          TParams,
          TOutgoing,
          TCaps,
          TServerRequests,
          TChannelBrand
        >,
        input: InferInput<TInput>,
      ): void | Promise<void>;
    } & RateLimitField<TCaps>,
  ): ChannelHandlerContribution<
    TKey,
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests>,
    { incoming: Record<TEvent, InferInput<TInput>> }
  >;

  /** Runs after a client subscribes to this channel. */
  subscribe(
    handler: (
      ctx: ChannelGateCtx<
        TSlots,
        TEnv,
        TMeta,
        TCaps,
        TChannelBrand,
        TOutgoing,
        false,
        TServerRequests
      >,
    ) => void | Promise<void>,
  ): void;
  /** Runs on a true leave (explicit unsubscribe / kick), not a plain disconnect. */
  unsubscribe(
    handler: (
      ctx: ChannelGateCtx<
        TSlots,
        TEnv,
        TMeta,
        TCaps,
        TChannelBrand,
        TOutgoing,
        false,
        TServerRequests
      >,
    ) => void | Promise<void>,
  ): void;
  /** Runs on every session end, including a plain disconnect. */
  sessionEnd(
    handler: (
      ctx: ChannelGateCtx<
        TSlots,
        TEnv,
        TMeta,
        TCaps,
        TChannelBrand,
        TOutgoing,
        false,
        TServerRequests
      >,
    ) => void | Promise<void>,
  ): void;
  /** Register a custom replay strategy scoped to this channel. */
  replay(hooks: CustomReplayHooks): void;
}

/** Channel `request(...)`, granted by the `requests()` capability. */
export interface ChannelRequestMethods<
  TSlots,
  TEnv,
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
  /** Register a client→server request handler scoped to this channel. */
  request<
    TEvent extends string,
    TInput extends Validator | undefined = undefined,
    TResponse = void,
  >(
    event: TEvent,
    config: {
      input?: TInput;
      run(
        ctx: ChannelCtx<
          TSlots,
          TEnv,
          TMeta,
          TParams,
          TOutgoing,
          TCaps,
          TServerRequests,
          TChannelBrand
        >,
        input: InferInput<TInput>,
      ): TResponse | Promise<TResponse>;
    } & RateLimitField<TCaps>,
  ): ChannelHandlerContribution<
    TKey,
    ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests>,
    {
      clientRequests: Record<TEvent, { payload: InferInput<TInput>; response: Awaited<TResponse> }>;
    }
  >;
}

/** Channel `intercept(...)`, granted by the `intercepts()` capability. */
export interface ChannelInterceptMethods<
  TSlots,
  TEnv,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TChannelBrand extends string = never,
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
  TServerRequests = {},
> {
  /** Inspect every incoming frame in this channel before routing. One per channel. */
  intercept(
    handler: (
      ctx: ChannelGateCtx<
        TSlots,
        TEnv,
        TMeta,
        TCaps,
        TChannelBrand,
        TOutgoing,
        false,
        TServerRequests
      >,
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
type ValidChannelCapabilities<T extends readonly ChannelOnlyCapability<{}, never, string>[]> =
  BrandIsWidened<NonNullable<T[number]['__brand']>> extends true
    ? readonly ChannelOnlyCapability<{}, never, never>[]
    : 'readReceipts' extends BrandsOf<T>
      ? 'inbox' extends BrandsOf<T>
        ? T
        : readonly ChannelOnlyCapability<{}, never, Exclude<BrandsOf<T>, 'readReceipts'>>[]
      : T;

/** Builder method granted by the `channels()` capability. */
export interface ChannelMethods<TSlots, TEnv, TMeta, TCaps extends readonly AnyCapability[]> {
  /** Declare a static channel. */
  channel<
    TName extends string,
    const TEmits extends Record<string, TypeMarker<any> | Validator> = {},
    const TRequests extends RequestsDeclarationConstraint<TCaps> = {},
    TSubscribe extends Validator | undefined = undefined,
    TCheckResult = unknown,
    const TCapabilities extends readonly ChannelOnlyCapability<{}, never, string>[] = readonly [],
  >(
    name: TName,
    config?: ChannelConfig<
      TSlots,
      TEnv,
      TMeta,
      TCaps,
      TSubscribe,
      TCheckResult,
      EmitMap<TEmits>
    > & {
      readonly outgoing?: {
        readonly emits?: TEmits;
        readonly requests?: TRequests;
      };
      readonly capabilities?: ValidChannelCapabilities<TCapabilities>;
    },
  ): ChannelObject<
    TSlots,
    TEnv,
    TMeta,
    TName,
    {},
    EmitMap<TEmits>,
    'static',
    SubscribePayloadOf<TSubscribe>,
    TCaps,
    ServerRequestMap<TRequests>,
    BrandsOf<TCapabilities>
  > &
    ChannelFlagsContribution<TName, BrandsOf<TCapabilities>>;
  /** Declare a dynamic channel family from `[familyKey, pattern]`. */
  channel<
    TFamily extends string,
    TPattern extends string,
    const TEmits extends Record<string, TypeMarker<any> | Validator> = {},
    const TRequests extends RequestsDeclarationConstraint<TCaps> = {},
    TSubscribe extends Validator | undefined = undefined,
    TCheckResult = unknown,
    const TCapabilities extends readonly ChannelOnlyCapability<{}, never, string>[] = readonly [],
  >(
    pattern: readonly [TFamily, TPattern],
    config?: ChannelConfig<
      TSlots,
      TEnv,
      TMeta,
      TCaps,
      TSubscribe,
      TCheckResult,
      EmitMap<TEmits>
    > & {
      readonly outgoing?: {
        readonly emits?: TEmits;
        readonly requests?: TRequests;
      };
      readonly capabilities?: ValidChannelCapabilities<TCapabilities>;
    },
  ): ChannelObject<
    TSlots,
    TEnv,
    TMeta,
    TFamily,
    ExtractParams<TPattern>,
    EmitMap<TEmits>,
    'dynamic',
    SubscribePayloadOf<TSubscribe>,
    TCaps,
    ServerRequestMap<TRequests>,
    BrandsOf<TCapabilities>
  > &
    ChannelFlagsContribution<TFamily, BrandsOf<TCapabilities>>;
}

/** Builder method granted by the `replay.custom()` capability. */
export interface ReplayMethods {
  /**
   * Register a custom replay strategy: your own storage and resend. The
   * `replay` hook (the resend) is required; `beforeSend` / `afterSend` are
   * optional. One registration per server.
   */
  replay(hooks: CustomReplayHooks): void;
}

/**
 * The builder methods the listed capabilities grant `base`, selected by each
 * capability's brand. A capability with no brand grants nothing.
 */
export type CapabilityMethods<
  TSlots,
  TEnv,
  TMeta,
  TBrand extends string,
  TCaps extends readonly AnyCapability[],
> = ('requests' extends TBrand ? RequestMethods<TSlots, TEnv, TMeta, TCaps> : {}) &
  ('scheduled' extends TBrand ? ScheduledMethods<TSlots, TEnv, TMeta> : {}) &
  ('replay-custom' extends TBrand ? ReplayMethods : {}) &
  ('intercepts' extends TBrand ? InterceptMethods<TSlots, TEnv, TMeta, TCaps> : {}) &
  ('stream' extends TBrand ? StreamMethods<TSlots, TEnv, TMeta, TCaps> : {}) &
  ('resumableStream' extends TBrand ? ResumableStreamMethods<TSlots, TEnv, TMeta, TCaps> : {}) &
  ('recordedStream' extends TBrand ? RecordedStreamMethods<TSlots, TEnv, TMeta, TCaps> : {}) &
  ('channels' extends TBrand ? ChannelMethods<TSlots, TEnv, TMeta, TCaps> : {});

/** Builder method granted by the `intercepts()` capability. */
export interface InterceptMethods<TSlots, TEnv, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Inspect every incoming frame before routing and validation. Throw to reject;
   * return a value to replace the payload. One intercept per server.
   */
  intercept(
    handler: (
      ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>,
      frame: InterceptFrame<PluginIdsOf<TSlots>>,
    ) => unknown | void,
  ): void;
}

/**
 * The builder returned by `define(...)`. Carries the methods every server has
 * (`on`, the lifecycle hooks, `intercept`, `assemble`) plus any methods the
 * listed capabilities grant through their brands.
 */
export type Base<
  TSlots,
  TEnv,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TScoped extends boolean = false,
> = CoreBase<TSlots, TEnv, TMeta, TCaps, TScoped> &
  CapabilityMethods<TSlots, TEnv, TMeta, BrandsOf<TCaps>, TCaps>;

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
  TEnv,
  TMeta,
  TCaps extends readonly AnyCapability[],
  TScoped extends boolean = false,
> {
  /**
   * Register a handler for one client→server event. The handler is an
   * exportable value — pass it to `assemble(...)`. Exactly one handler per event
   * name is allowed across the whole server.
   */
  on<TEvent extends string, TSchema extends Validator | undefined = undefined>(
    event: TEvent,
    config: OnConfig<TSlots, TEnv, TMeta, TSchema, TCaps>,
  ): IncomingHandlerValue<TEvent, InferInput<TSchema>>;

  /** Run once at server startup, before any connection. Use it for schema creation or migrations. */
  onInit(handler: (ctx: InitContext<TEnv>) => void | Promise<void>): void;
  /** Run each time a connection opens, after `upgrade(...)` succeeds. */
  onConnect(handler: (ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>) => void | Promise<void>): void;
  /** Run each time a connection closes, for any reason. `ctx.closeCode` / `ctx.closeReason` are set. */
  onDisconnect(handler: (ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>) => void | Promise<void>): void;
  /**
   * Run each time a client sends a `ping`. The server has already replied
   * `pong` by then — this is for observing, not for answering.
   */
  onPing(handler: (ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>) => void | Promise<void>): void;
  /**
   * Run each time a client answers a server `ping` with a `pong`. With
   * `keepalive()` listed, the round-trip is already recorded, so `ctx.latency`
   * is fresh here.
   */
  onPong(handler: (ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>) => void | Promise<void>): void;
  /** Run on any unhandled error from a handler. `event` is set when the error came from one. */
  onError(
    handler: (
      ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>,
      error: unknown,
      event?: string,
    ) => void | Promise<void>,
  ): void;
  /** Run when an incoming payload fails its schema validation. */
  onValidationError(
    handler: (
      ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>,
      event: string,
      error: unknown,
    ) => void | Promise<void>,
  ): void;
  /** Run once when the server is shutting down. `ctx` is a server-wide context, with no single connection. */
  onShutdown(
    handler: (ctx: ShutdownContext<TEnv, TMeta, unknown, TSlots>) => void | Promise<void>,
  ): void;

  /**
   * Inspect every outgoing frame before it is serialized. Return a value to
   * rewrite the payload, or nothing to observe. The event is locked. One
   * `onOutgoing` hook per server.
   */
  onOutgoing(
    handler: (
      ctx: AppCtx<TSlots, TEnv, TMeta, TCaps>,
      frame: OutgoingFrame<PluginIdsOf<TSlots>>,
    ) => unknown | void,
  ): void;

  /**
   * Collect every handler into the final server the platform adapter runs. Pass
   * the handlers as `{ handlers: [...] }` — each `base.on(...)` (and, with their
   * capabilities, `request` / `stream` / `channel` / `scheduled`) value. The
   * upgrade hook, the lifecycle hooks, the intercept, and the listed capabilities
   * are folded in automatically.
   *
   * A scoped plugin handler (`define({ scope: 'plugin' })`) may also pass `api` —
   * the per-connection surface the host reaches via `ctx.plugin(id)`. Its `ctx`
   * is the plugin's own scoped ctx, the same one its handlers receive.
   *
   * Capabilities belong in `define({ capabilities: [...] })`, not here — passing
   * one is a type error.
   */
  assemble<const THandlers extends readonly AssembleInput[], TApi = unknown>(config: {
    readonly handlers: THandlers;
    readonly api?: (
      ctx: TScoped extends true
        ? AppCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TEnv, TMeta, TCaps>
        : AdminCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TEnv, TMeta, TCaps>,
    ) => TApi;
  }): ServerDefinition<
    readonly Primitive[],
    BuildContract<MergeSlots<TSlots | SlotsOf<THandlers[number]>>>,
    AppCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TEnv, TMeta, TCaps>,
    TApi
  >;
}

/** A value `assemble(...)` accepts — a handler, never a capability. */
export type AssembleInput = Contribution & { readonly __wskitCapability?: never };

/**
 * Compile-time check that a host's environment satisfies every listed plugin's
 * environment requirement. A plugin with no requirement contributes nothing.
 */
type PluginEnvCheck<TEnv, TCaps extends readonly AnyCapability[]> = [
  PluginEnvRequirements<TCaps>,
] extends [never]
  ? {}
  : TEnv extends PluginEnvRequirements<TCaps>
    ? {}
    : {
        readonly __wskit_plugin_env_error: 'The host environment must satisfy every plugin environment requirement.';
      };

/** The rate-limit slots `assemble(...)` reads off a collected channel object. @internal */
interface ChannelRateLimitSource {
  readonly __key: string;
  readonly __rateLimit?: RateLimitConfig;
  readonly __rateLimitOverrides?: ReadonlyMap<string, RateLimitConfig>;
}

function isScheduledCarrier(value: Contribution): value is ScheduledHandlerValue<string> {
  return (value as { __wskitScheduledHandler?: unknown }).__wskitScheduledHandler === true;
}

/**
 * The primitive kinds that route by event name. An event name can belong to at
 * most one of these across a scope, so two of them sharing a name collide.
 */
const ROUTING_KINDS = new Set([
  'incoming',
  'request',
  'stream-generate',
  'resumable-stream-generate',
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
        `[wskit] Duplicate ${handler.__wskit} handler` +
          `${registrationId ? ` for '${registrationId}'` : ''} passed to assemble(). ` +
          'An event can only be bound once — drop the duplicate.',
      );
    }
    registered.add(id);

    if (ROUTING_KINDS.has(handler.__wskit)) {
      const event = (handler as { event?: string }).event;
      if (event !== undefined) {
        const owner = routedEvents.get(event);
        if (owner !== undefined && owner !== handler.__wskit) {
          throw new Error(
            `[wskit] Event name '${event}' is bound by both a ${owner} handler and a ` +
              `${handler.__wskit} handler passed to assemble(). An event name can only be one ` +
              'kind within a scope — pick a different name.',
          );
        }
        routedEvents.set(event, handler.__wskit);
      }
    }
  }
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
        `[wskit] No handler for scheduled task '${taskId}'. ` +
          `Add base.scheduled('${taskId}', ...) and pass it to assemble().`,
      );
    }
    primitives.push(build!(taskId, declaration, body));
  }
  for (const taskId of bodies.keys()) {
    if (!declarations.has(taskId)) {
      throw new Error(
        `[wskit] base.scheduled('${taskId}') has no matching declaration. ` +
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
    if (key !== undefined) refs.push({ __wskit: 'tag-ref', kind: 'ephemeral', group, key });
  }
  return refs;
}

/** Wrap a bootstrap `upgrade(...)` function as the engine's builder upgrade hook. */
function adaptUpgrade(fn: UpgradeFn<any>): UpgradeHandler {
  return async (request: Request): Promise<UpgradeResult> => {
    const result = await fn(request);
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
    __wskit: 'onUpgrade',
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
 * Create a WSKit server. `define(...)` holds only bootstrap (`env`, `upgrade`,
 * `hibernation`); every feature is a capability you list. It returns a `base`
 * builder whose methods are typed against your env, metadata, and capabilities.
 *
 * ```ts
 * import { define, emits, t } from '@wskit/server';
 * import * as v from 'valibot';
 *
 * const base = define({
 *   env: t<Env>(),
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
 * export const handler = base.assemble({ handlers: [handlePing] });
 * ```
 */
export function define<
  TEnv = unknown,
  TMeta = unknown,
  const TCaps extends readonly (GrantableCapability & TopLevelCapability)[] = readonly [],
>(
  config: DefineConfig<TEnv, TMeta, TCaps> & PluginEnvCheck<TEnv, TCaps>,
): Base<MergeSlots<SlotsOf<TCaps[number]>>, TEnv, TMeta, TCaps>;
export function define<
  TMeta = unknown,
  const TConfig extends ScopedDefineConfig<
    TMeta,
    readonly (PluginSafeCapability & TopLevelCapability)[],
    unknown
  > = ScopedDefineConfig<TMeta, readonly (PluginSafeCapability & TopLevelCapability)[], unknown>,
>(
  config: TConfig & NoExtraScopedConfigKeys<TConfig>,
): Base<
  MergeSlots<SlotsOf<ScopedCapabilitiesOf<TConfig>[number]>>,
  ScopedEnvironmentOf<TConfig>,
  TMeta,
  ScopedCapabilitiesOf<TConfig>,
  true
>;
export function define(config: any): any {
  const scoped = config.scope === 'plugin';
  const lifecyclePrimitives: Primitive[] = [];
  const seen = new Set<string>();

  function registerOnce(slot: string, primitive: Primitive): void {
    if (seen.has(slot)) {
      throw new Error(
        `[wskit] Duplicate ${slot} hook on this server. Only one ${slot} hook can be attached.`,
      );
    }
    seen.add(slot);
    lifecyclePrimitives.push(primitive);
  }

  type StreamBuild = (event: string, streamConfig: unknown) => Primitive;

  function streamBuilder(
    kind: 'plain' | 'resumable' | 'recorded',
    method: string,
    capabilityName: string,
  ): StreamBuild {
    for (const cap of config.capabilities ?? []) {
      const built = (cap as { __streamBuild?: { kind: string; build: StreamBuild } }).__streamBuild;
      if (built?.kind === kind) return built.build;
    }
    throw new Error(
      `[wskit] base.${method}() needs the ${capabilityName} capability. ` +
        `Add ${capabilityName} to capabilities.`,
    );
  }

  const base = {
    on(event: string, config: OnConfig<any, any, any, any> & { rateLimit?: RateLimitConfig }) {
      const primitive = incomingFactory(
        event,
        config.run as any,
        config.input ? { validator: config.input } : undefined,
      );
      if (config.rateLimit) {
        (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = config.rateLimit;
      }
      return primitive;
    },
    request(
      event: string,
      requestConfig: {
        input?: Validator;
        rateLimit?: RateLimitConfig;
        run: (ctx: any, input: any) => unknown;
      },
    ) {
      type Build = (
        e: string,
        c: { input?: Validator; run: typeof requestConfig.run },
      ) => Primitive;
      let build: Build | undefined;
      for (const cap of config.capabilities ?? []) {
        const candidate = (cap as { __buildRequest?: Build }).__buildRequest;
        if (candidate) build = candidate;
      }
      if (!build) {
        throw new Error(
          '[wskit] base.request() needs the requests() capability. Add requests() to capabilities.',
        );
      }
      const primitive = build(event, { input: requestConfig.input, run: requestConfig.run });
      if (requestConfig.rateLimit) {
        (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = requestConfig.rateLimit;
      }
      return primitive;
    },
    scheduled(taskId: string, config: { run: (ctx: any, data?: unknown) => void | Promise<void> }) {
      return {
        __wskitScheduledHandler: true as const,
        taskId,
        run: config.run,
      };
    },
    stream(event: string, streamConfig: unknown) {
      return streamBuilder('plain', 'stream', 'stream()')(event, streamConfig);
    },
    resumableStream(event: string, streamConfig: unknown) {
      return streamBuilder(
        'resumable',
        'resumableStream',
        'resumableStream()',
      )(event, streamConfig);
    },
    recordedStream(event: string, streamConfig: unknown) {
      return streamBuilder('recorded', 'recordedStream', 'recordedStream()')(event, streamConfig);
    },
    channel(pattern: unknown, channelConfig?: unknown) {
      let factory: ((p: unknown, c: unknown, deps: unknown) => unknown) | undefined;
      const streamBuilders: Record<string, unknown> = {};
      let buildCustomReplay: unknown;
      let buildBuiltinReplay: unknown;
      let buildRequest: unknown;
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
        const request = (cap as { __buildRequest?: unknown }).__buildRequest;
        if (request) buildRequest = request;
        const registerSR = (cap as { __registerServerRequests?: unknown }).__registerServerRequests;
        if (registerSR) registerServerRequests = registerSR;
      }
      if (!factory) {
        throw new Error(
          '[wskit] base.channel() needs the channels() capability. Add channels() to capabilities.',
        );
      }
      return factory(pattern, channelConfig, {
        streamBuilders,
        buildCustomReplay,
        buildBuiltinReplay,
        buildRequest,
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
            throw new Error('[wskit] replay.custom() is listed more than once. List it once.');
          }
          build = candidate;
        }
      }
      if (!build) {
        throw new Error(
          '[wskit] base.replay() needs the replay.custom() capability. ' +
            'Add replay.custom() to capabilities.',
        );
      }
      registerOnce('replay', build(hooks));
    },
    assemble(assembleConfig: {
      handlers: readonly Contribution[];
      api?: (ctx: unknown) => unknown;
    }) {
      const items = assembleConfig.handlers;
      const api = assembleConfig.api;
      assertUniquePluginIds(config.capabilities ?? []);
      assertPluginDependencies(config.capabilities ?? []);
      assertHostObservationGranted(config.capabilities ?? []);
      assertNoChannelOnlyCapabilities(config.capabilities ?? []);
      const handlerPrimitives: Primitive[] = [];
      const scheduledBodies = new Map<
        string,
        (ctx: TaskContext, data?: unknown) => void | Promise<void>
      >();
      const channelObjects = new Set<{ __build(): Primitive }>();
      for (const item of items) {
        if ((item as { __wskitCapability?: unknown }).__wskitCapability) {
          throw new Error(
            '[wskit] A capability was passed to assemble(). List capabilities in ' +
              'define({ capabilities: [...] }) and pass only handlers (base.on, ...) to assemble().',
          );
        }
        const channel = (item as { __channel?: { __build(): Primitive } }).__channel;
        if (channel) {
          channelObjects.add(channel);
          continue;
        }
        if (isScheduledCarrier(item)) {
          if (scheduledBodies.has(item.taskId)) {
            throw new Error(
              `[wskit] Duplicate scheduled handler for '${item.taskId}' passed to assemble(). ` +
                'A task can only be bound once — drop the duplicate.',
            );
          }
          scheduledBodies.set(item.taskId, item.run);
          continue;
        }
        handlerPrimitives.push(item as Primitive);
      }
      assertUniqueHandlers(handlerPrimitives);

      const channelPrimitives = [...channelObjects].map((ch) => ch.__build());

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

      let buildRateLimit: RateLimitCapability['__buildRateLimit'] | undefined;
      for (const cap of config.capabilities ?? []) {
        const build = (cap as Partial<RateLimitCapability>).__buildRateLimit;
        if (build) {
          if (buildRateLimit) {
            throw new Error(
              '[wskit] rateLimit() is listed more than once. Set one global rule, or none.',
            );
          }
          buildRateLimit = build;
        }
      }
      const overrides = new Map<string, Map<string, RateLimitConfig>>();
      const channelRules = new Map<string, RateLimitConfig>();
      let hasRateLimitConfig = false;

      const topOverrides = new Map<string, RateLimitConfig>();
      for (const handler of handlerPrimitives) {
        const override = (handler as { __rateLimit?: RateLimitConfig }).__rateLimit;
        const event = (handler as { event?: string }).event;
        if (override && event !== undefined) topOverrides.set(event, override);
      }
      if (topOverrides.size > 0) {
        overrides.set('top', topOverrides);
        hasRateLimitConfig = true;
      }

      const channelKeys = new Set<string>();
      for (const channel of channelObjects) {
        const ch = channel as unknown as ChannelRateLimitSource;
        channelKeys.add(ch.__key);
        if (ch.__rateLimit) {
          channelRules.set(ch.__key, ch.__rateLimit);
          hasRateLimitConfig = true;
        }
        if (ch.__rateLimitOverrides && ch.__rateLimitOverrides.size > 0) {
          overrides.set(`channel:${ch.__key}`, new Map(ch.__rateLimitOverrides));
          hasRateLimitConfig = true;
        }
      }

      if (!buildRateLimit && hasRateLimitConfig) {
        throw new Error(
          '[wskit] a per-handler rateLimit override needs the rateLimit() capability. ' +
            'Add rateLimit() to capabilities.',
        );
      }
      const rateLimitPrimitive = buildRateLimit
        ? buildRateLimit({ overrides, channelRules, channelKeys })
        : null;

      const primitives: Primitive[] = [];
      if (config.upgrade) {
        primitives.push(
          scoped
            ? scopedUpgradePrimitive(adaptUpgrade(config.upgrade))
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

      const declaredErrors = primitives
        .filter((p): p is ErrorsPrimitive => p.__wskit === 'errors')
        .flatMap((p) => p.defs);
      collectUnique(declaredErrors, (def) => def.code, {
        kind: 'error code',
        context: 'define({ capabilities: [...] })',
      });

      const builtinReplayCount = primitives.filter(
        (p) => p.__wskit === 'replay' && !(p as { disabled?: boolean }).disabled,
      ).length;
      const hasCustomReplay = primitives.some((p) => p.__wskit === 'replayCustom');
      if (builtinReplayCount > 1) {
        throw new Error(
          '[wskit] built-in replay (replay.history() / replay.snapshot()) is listed more than ' +
            'once. Use one replay strategy per scope.',
        );
      }
      if (builtinReplayCount > 0 && hasCustomReplay) {
        throw new Error(
          '[wskit] built-in replay and custom base.replay() are both configured. ' +
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
          p.__wskit === 'resumable-stream-generate' || p.__wskit === 'recorded-stream-generate'
        );
      }
      // A durable stream can be declared at the top level or nested inside a
      // channel, so scan both — otherwise a channel-only durable stream would
      // miss the retention sweep below.
      const hasDurableStream = primitives.some(
        (p) =>
          isDurableGenerate(p) ||
          (p.__wskit === 'channel' &&
            ((p as { primitives?: readonly Primitive[] }).primitives ?? []).some(
              isDurableGenerate,
            )),
      );

      // Install the durable-stream retention sweep only when a resumable/recorded
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
          'define({ users })',
        );
      }

      return Object.freeze({
        __wskit: 'server' as const,
        primitives: Object.freeze(primitives) as readonly Primitive[],
        __features: Object.freeze(features) as ReadonlySet<string>,
        ...(config.translate ? { __translate: config.translate } : {}),
        ...(config.users ? { __usersPolicy: config.users } : {}),
        // Read by plugin() on a scoped handler, by Engine.admin() on an app one.
        ...(api ? { __apiFactory: api } : {}),
        ...(scoped
          ? { __scoped: true as const, __hostDependencies: Object.freeze(hostDependencies) }
          : {}),
      });
    },
  };

  return base as unknown as Base<any, any, any, any>;
}
