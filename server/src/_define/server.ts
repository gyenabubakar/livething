/* oxlint-disable @typescript-eslint/no-explicit-any */
import { LiveThingConfigError } from '@livething/core';
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { collectUnique } from '~/_engine/compile/utils.ts';
import { assertOneOf, assertOptionalPositiveInteger } from '~/_engine/validation.ts';
import { hibernation as hibernationFactory } from '~/hibernation/hibernation.ts';
import { incoming as incomingFactory, refuseRecordedBinaryStream } from '~/incoming/incoming.ts';
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
} from '~/lifecycle/lifecycle.ts';
import type { BinaryInput } from '@livething/core';
import type { TypeMarker } from '~/_api/definitions.ts';
import type { BinaryCapability } from '~/binary/capability.ts';
import type { ChannelBuilder, ChannelHandlerValue } from '~/channel/capability.ts';
import type { ExtractParams, ValidChannelTemplate } from '~/channel/channel.ts';
import type {
  ChannelInbox,
  ChannelReadReceipts,
  ChannelRecipient,
  ConnectionInfo,
  ConnectionlessContext,
  ConnectionRef,
  InitContext,
  TagRef,
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
import type { ClientRequestsCapability, RequestBuildConfig } from '~/request/client-requests.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { ResolvedServerRequest, ServerRequestsCapability } from '~/request/server-requests.ts';
import type { ScheduledCapability, ScheduledDeclaration } from '~/scheduled/capability.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type {
  ClientResponse,
  DurableWireChunk,
  Jsonify,
  Payload,
  PayloadObject,
  Validator,
} from '~/types.ts';
import { assertConfigShape, assertUniqueCapabilityKinds } from './capability-checks.ts';
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
  AppCtx,
  ChannelBinaryArm,
  ChannelOutgoingSlice,
  ChannelRef,
  ConnectionlessCtx,
  ReplayWire,
  WithBinaryEvents,
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
  UnionToIntersection,
  UniqueCapabilityKinds,
} from './capability.ts';
import type { BuildContract, InferInput } from './contract.ts';

type OptsParameter = { reason: string };
type ServerRequestConfigParameter = {
  input?: Validator;
  allowInterleaving?: boolean;
  rateLimit?: RateLimitConfig;
  maxBytes?: number;
  run: (ctx: any, input: any, bytes?: Uint8Array) => unknown;
};
type ServerConfigParameter = { run: (ctx: any, data?: unknown) => void | Promise<void> };
type BinaryOnConfigParameter = {
  input?: Validator;
  maxBytes?: number;
  allowInterleaving?: boolean;
  rateLimit?: RateLimitConfig;
  run: (ctx: any, input: any, bytes?: Uint8Array) => void | Promise<void>;
};
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
  /**
   * Initial ephemeral tags to attach: `{ ephemeral: { group: key } }`, or a list
   * of keys to put the connection under several keys of one group.
   */
  readonly tags?: {
    readonly ephemeral?: Partial<Record<TEphemeralGroups, string | readonly string[]>>;
  };
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

/**
 * A plugin's `upgrade(...)`. Receives the raw upgrade request and the plugin's own scoped
 * `ctx`: the same shape as the app's, with `ctx.kv` namespaced to the plugin like the `ctx`
 * of its handlers.
 */
export type ScopedUpgradeFn<TMeta, TEphemeralGroups extends string = string> = (
  request: Request,
  ctx: InitContext,
) => UpgradeReturn<TMeta, TEphemeralGroups> | Promise<UpgradeReturn<TMeta, TEphemeralGroups>>;

/** The ephemeral tag-group names declared across a list of capabilities. */
type EphemeralGroupsOf<TCaps extends readonly AnyCapability[]> = keyof SlotOr<
  MergeSlots<SlotsOf<TCaps[number]>>,
  'ephemeralTags'
> &
  string;

/**
 * The hooks of a server, written in `server({ ... })`. List `upgrade` and
 * `capabilities` before them: TypeScript reads the object from top to bottom, so
 * a hook above `upgrade` sees `ctx.meta` as `unknown`.
 */
interface ServerHooks<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /** Run once at server startup, before any connection. Use it for schema creation or migrations. */
  readonly onInit?: (ctx: InitContext) => void | Promise<void>;
  /** Run each time a connection opens, after `upgrade(...)` succeeds. */
  readonly onConnect?: (ctx: AppCtx<TSlots, TMeta, TCaps>) => void | Promise<void>;
  /** Run each time a connection closes, for any reason. `ctx.closeCode` / `ctx.closeReason` are set. */
  readonly onDisconnect?: (ctx: AppCtx<TSlots, TMeta, TCaps>) => void | Promise<void>;
  /**
   * Run each time a client sends a `ping`. The server has already replied
   * `pong` by then — this is for observing, not for answering.
   */
  readonly onPing?: (ctx: AppCtx<TSlots, TMeta, TCaps>) => void | Promise<void>;
  /**
   * Run each time a client answers a server `ping` with a `pong`. With
   * `keepalive()` listed, the round-trip is already recorded, so `ctx.latency`
   * is fresh here.
   */
  readonly onPong?: (ctx: AppCtx<TSlots, TMeta, TCaps>) => void | Promise<void>;
  /**
   * Run on any unhandled error from a handler. `event` is set when the error came from one.
   * In a plugin (`server({ scope: 'plugin' })`), it runs only for the plugin's own
   * events and channels, and `event` is the name the plugin declared, without the
   * `__<id>::` prefix.
   */
  readonly onError?: (
    ctx: AppCtx<TSlots, TMeta, TCaps>,
    error: unknown,
    event?: string,
  ) => void | Promise<void>;
  /** Run once when the server is shutting down. `ctx` is a server-wide context, with no single connection. */
  readonly onShutdown?: (ctx: ConnectionlessCtx<TSlots, TMeta, TCaps>) => void | Promise<void>;
  /**
   * Inspect every incoming frame before routing and validation. Throw to reject;
   * return a value to replace the payload.
   */
  readonly intercept?: (
    ctx: AppCtx<TSlots, TMeta, TCaps>,
    frame: InterceptFrame<PluginIdsOf<TSlots>>,
  ) => unknown | void;
  /**
   * Watch every app frame the server sends, once per send, after the frame
   * went out. A send to many connections is one call: `frame.target` says who
   * it was addressed to and `frame.recipients` how many sockets got it. The
   * hook cannot change or stop a frame. A send made inside the hook goes out
   * but is not shown to any `onOutgoing` hook.
   *
   * `ctx` is the context of the connection whose `on`, `request` or `stream`
   * handler, intercept, or `onConnect`, `onError`, `onPing` or `onPong` hook is
   * running when the frame is sent. For a broadcast from that code, `ctx` is the
   * sender, not each receiver. In every other case `ctx` is `undefined` — for
   * example, a send from a channel `onSubscribe` hook, `onDisconnect`, a scheduled
   * task, `onInit`, `onShutdown`, or the admin API.
   */
  readonly onOutgoing?: (
    ctx: AppCtx<TSlots, TMeta, TCaps> | undefined,
    frame: OutgoingFrame<PluginIdsOf<TSlots>>,
  ) => void | Promise<void>;
}

/**
 * The configuration passed to `server(...)`. Holds bootstrap — the things the
 * runtime needs to exist and accept a connection — and the server's hooks. Every
 * feature beyond this is an entry in `capabilities`.
 */
export interface ServerConfig<
  TMeta = unknown,
  // Defaults to no capabilities, not to every capability. `server(...)` infers
  // the real list from the config it is given; the default only applies when
  // this type is written out by hand, and a list of `AnyCapability` there would
  // widen every capability brand to `string` — making the ctx gating pass for
  // capabilities the server never listed.
  TCaps extends readonly AnyCapability[] = readonly [],
> extends ServerHooks<MergeSlots<SlotsOf<TCaps[number]>>, TMeta, TCaps> {
  /** Auth gate. Return `{ userId, meta }` to accept, or throw `RejectUpgrade(...)` to deny. */
  readonly upgrade?: UpgradeFn<TMeta, EphemeralGroupsOf<TCaps>>;
  /** Turn on Cloudflare Durable Object hibernation (which disables server pings). */
  readonly hibernation?: boolean;
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
> extends ServerHooks<MergeSlots<SlotsOf<TCaps[number]>>, TMeta, TCaps> {
  /** Marks this as a plugin's scoped server definition. */
  readonly scope: 'plugin';
  /**
   * The plugin's upgrade gate. Runs before the app's upgrade in the inbound
   * onion: it sees the raw request and the plugin's scoped `ctx`, not the app's identity.
   * `context.upgrade(pluginBase)` returns that `ctx` inside it. Return
   * `meta` (shallow-merged, app wins on key conflict) and/or `tags`
   * (concatenated); throw `RejectUpgrade(...)` to veto the handshake. A plugin
   * may own `userId` — but only one upgrade hook (the app's or one plugin's)
   * may return it, or the build/runtime errors.
   */
  readonly upgrade?: ScopedUpgradeFn<TMeta, EphemeralGroupsOf<TCaps>>;
  /** The features this plugin uses. Host-owned capabilities are a compile error here. */
  readonly capabilities?: TCaps & UniqueCapabilityKinds<TCaps>;
}

/** The value `base.scheduled(...)` returns. Pass it to `assemble()` to activate the task. */
export interface ScheduledHandlerValue<TTaskId extends string = string> extends Contribution {
  /** @internal */
  readonly __livethingScheduledTask: true;
  readonly taskId: TTaskId;
  /** @internal */
  readonly run: (ctx: ConnectionlessContext, data?: unknown) => void | Promise<void>;
}

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
type RateLimitField<TCaps extends readonly AnyCapability[]> =
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
  Contribution<{
    clientRequests: Record<TEvent, { payload: TPayload; response: ClientResponse<TResponse> }>;
  }>;

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
interface RequestMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Create a handler value for one client→server request. Like `base.on`, but the
   * client awaits a reply: whatever the handler returns becomes the response,
   * and its type is inferred from the return. Returning nothing rejects the
   * client's pending request. Pass the returned value to `assemble()` to activate it.
   */
  request<
    TEvent extends string,
    TSchema extends Validator | undefined = undefined,
    TResponse extends PayloadObject | null | void = void,
  >(
    event: TEvent,
    config: RequestConfig<TSlots, TMeta, TSchema, TResponse, TCaps>,
  ): RequestHandlerValue<TEvent, InferInput<TSchema>, Awaited<TResponse>>;
}

/** The scheduled-task map (task id → payload type), read off the merged contract slots. */
type ScheduledMap<TSlots> = SlotOr<TSlots, 'scheduled'>;

/** Configuration object for `base.scheduled(...)`. */
interface ScheduledConfig<TSlots, TMeta, TCaps extends readonly AnyCapability[], TData> {
  /** Runs when the task fires. Receives the typed payload for tasks that declare one. */
  run: TData extends undefined
    ? (ctx: ConnectionlessCtx<TSlots, TMeta, TCaps>) => void | Promise<void>
    : // The task gets the data back from its stored JSON, so a Date field arrives as a string.
      (ctx: ConnectionlessCtx<TSlots, TMeta, TCaps>, data: Jsonify<TData>) => void | Promise<void>;
}

/** Builder method granted by the `scheduled()` capability. */
interface ScheduledMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Create the handler for one declared scheduled task. Pass it to `assemble()` to
   * activate it. The task id and its payload type come from the `scheduled(...)`
   * capability; naming an undeclared task is a type error.
   */
  scheduled<TTaskId extends keyof ScheduledMap<TSlots> & string>(
    taskId: TTaskId,
    config: ScheduledConfig<TSlots, TMeta, TCaps, ScheduledMap<TSlots>[TTaskId]>,
  ): ScheduledHandlerValue<TTaskId>;
}

/** A stream's nudge map: event name → schema, or `null` for a no-payload nudge. */
type StreamNudgeMap = Record<string, Validator | null>;

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
 * nudges. Combined with `NudgesHandle` to form the full handle.
 */
type StreamHandleBase = {
  /**
   * Stop signal fired when the stream is cancelled, the owning client
   * disconnects (plain streams only — a recorded stream keeps running), or the
   * server shuts down. Pass it into slow awaited work (e.g.
   * `fetch(url, { signal: ctx.stream.signal })`) so it stops immediately.
   */
  readonly signal: AbortSignal;
  /**
   * Pause the generator until the outbound buffer is healthy, then continue.
   * Resolves immediately when the buffered amount is below 256 KB. For a broadcast stream it paces against
   * the healthiest client, never the slowest. On Cloudflare, which does not
   * expose buffer fullness, `drain()` is a no-op that resolves immediately.
   */
  drain(): Promise<void>;
};

/** The contract slot shape for a stream's declared nudges. */
type NudgesContract<TNudges> = { [K in keyof TNudges & string]: NudgePayloadOf<TNudges[K]> };

/** The value the stream builders return — a primitive that declares its stream slot. */
type StreamHandlerValue<TEvent extends string, TEntry, TSlot extends string> = Primitive &
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
interface StreamConfig<
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
  /** The async generator — each yielded value is sent to the client as a chunk. */
  run(
    ctx: StreamCtx<TSlots, TMeta, TNudges, TCaps>,
    input: InferInput<TInput>,
  ): AsyncGenerator<TChunk, void, unknown>;
}

/** Builder method granted by the `stream()` capability. */
interface StreamMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /** Create a plain server-pushed stream handler value. Pass it to `assemble()` to activate it. */
  stream<
    TEvent extends string,
    TChunk extends Payload = Record<string, unknown>,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: StreamConfig<TSlots, TMeta, TInput, TChunk, TNudges, TCaps>,
  ): StreamHandlerValue<
    TEvent,
    { payload: InferInput<TInput>; chunk: Jsonify<TChunk>; nudges: NudgesContract<TNudges> },
    'streams'
  >;
}

/** Retention options of a recorded stream. */
interface DurableStreamOptions {
  /** How long a stream whose generator stopped mid-stream (e.g. a server restart) is kept. */
  readonly maxAgeMs?: number;
  /** How long an ended stream is kept so a quick reconnect can still continue. */
  readonly retentionAfterEndMs?: number;
}

/** Configuration object for `base.recordedStream(...)`. */
interface RecordedStreamConfig<
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
  run(
    ctx: StreamCtx<TSlots, TMeta, TNudges, TCaps>,
    input: InferInput<TInput>,
  ): AsyncGenerator<TChunk, void, unknown>;
}

/** Builder method granted by the `recordedStream()` capability. */
interface RecordedStreamMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
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
    {
      payload: InferInput<TInput>;
      chunk: DurableWireChunk<TChunk>;
      nudges: NudgesContract<TNudges>;
    },
    'recordedStreams'
  >;
}

type ChannelCapability =
  | ChannelOnlyCapability<{}, never, string>
  | EmitsCapability<EmitDefs>
  | ServerRequestsCapability
  | BinaryCapability<EmitDefs>;

type ChannelCapabilitySlots<TCaps extends readonly ChannelCapability[]> = MergeSlots<
  SlotsOf<TCaps[number]>
>;
/**
 * The events a channel sends: its `emits(...)` events, with its `binary({ emits })`
 * events carried under a symbol key that only the `.binary` senders read.
 */
type ChannelOutgoing<TCaps extends readonly ChannelCapability[]> =
  SlotOr<ChannelCapabilitySlots<TCaps>, 'outgoing'> extends infer TOutgoing extends Record<
    string,
    unknown
  >
    ? 'binary' extends BrandsOf<TCaps>
      ? WithBinaryEvents<TOutgoing, SlotOr<ChannelCapabilitySlots<TCaps>, 'binaryOutgoing'>>
      : TOutgoing
    : {};
/**
 * The server requests a channel sends: its `serverRequests(...)`, with its
 * `binary({ serverRequests })` carried under a symbol key that only `.binary.request` reads.
 */
type ChannelServerRequests<TCaps extends readonly ChannelCapability[]> =
  'binary' extends BrandsOf<TCaps>
    ? WithBinaryEvents<
        SlotOr<ChannelCapabilitySlots<TCaps>, 'serverRequests'>,
        SlotOr<ChannelCapabilitySlots<TCaps>, 'binaryServerRequests'>
      >
    : SlotOr<ChannelCapabilitySlots<TCaps>, 'serverRequests'>;

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
   * channel for good. The durable membership row is dropped, so the user does
   * not auto-rejoin on reconnect. Every targeted connection is
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
   * Inject a synthetic replay frame for one of this channel's outgoing events,
   * for example to seed history. `wire` carries the seq/messageId the client
   * uses to dedup. It is absent when replay is not active for this
   * channel.
   */
  sendReplay?<E extends keyof TOutgoing & string>(
    event: E,
    payload: TOutgoing[E],
    wire: ReplayWire,
  ): void;
}

/**
 * The `request` arm added to `ctx.channel` when that channel lists
 * `serverRequests(...)`. It resolves the channel's own declarations.
 */
type ChannelRequestArm<
  TServerRequests,
  TChannelBrand extends string,
> = 'serverRequests' extends TChannelBrand
  ? // `& string`: the map carries the channel's binary server requests under a symbol key.
    [keyof TServerRequests & string] extends [never]
    ? {}
    : {
        /**
         * Ask a server→client request this channel declared and resolve its
         * typed answer. Targets the calling connection by default; pass
         * `{ to: connectionRef }` to ask one other member of this channel instead.
         */
        request<E extends keyof TServerRequests & string>(
          event: E,
          payload: TServerRequests[E] extends { payload: infer P } ? P : never,
          options?: { timeout?: number; to?: ConnectionRef },
        ): Promise<TServerRequests[E] extends { response: infer R } ? R : never>;
      }
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
    ChannelCapabilityArm<TChannelBrand, TOutgoing> &
    ChannelBinaryArm<TOutgoing, TServerRequests>;
};

/**
 * The `ctx` that a channel's gate hooks (`check`, `commit`, `revalidate`) and lifecycle
 * hooks (`onSubscribe`, `onUnsubscribe`, `onSessionEnd`, `intercept`) receive. Replay is
 * exposed, when active, on `ctx.channel.sendReplay`; channel contexts do not expose the
 * root `ctx.sendReplay` method.
 */
type ChannelGateCtx<
  TSlots,
  TMeta,
  TCaps extends readonly AnyCapability[] = readonly [],
  TChannelBrand extends string = never,
  TOutgoing extends Record<string, unknown> = Record<string, unknown>,
  /** `true` for check/commit/revalidate, whose ctx omits channel-only handles. */
  TIsSubscribeGate extends boolean = false,
  TServerRequests = {},
> = Omit<AppCtx<TSlots, TMeta, TCaps, TIsSubscribeGate>, 'sendReplay'> & {
  readonly channel: ChannelHandle<Record<string, string>, TOutgoing, TMeta> &
    ChannelRequestArm<TServerRequests, TChannelBrand> &
    ChannelCapabilityArm<TChannelBrand, TOutgoing> &
    ChannelBinaryArm<TOutgoing, TServerRequests>;
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
   * `ctx.channel.request` are not available here — read
   * channel-only surfaces in `onSubscribe`, `onUnsubscribe`, or `onSessionEnd`
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
   * `ctx.channel.request` are not available here — read
   * channel-only surfaces in `onSubscribe`, `onUnsubscribe`, or `onSessionEnd`
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
   * `ctx.channel.request` are not available here — read
   * channel-only surfaces in `onSubscribe`, `onUnsubscribe`, or `onSessionEnd`
   * instead.
   */
  revalidate?: (
    ctx: ChannelGateCtx<TSlots, TMeta, TCaps, never, TOutgoing, true>,
  ) => void | Promise<void>;
  /** Runs after a client subscribes to this channel. */
  readonly onSubscribe?: (
    ctx: ChannelGateCtx<
      TSlots,
      TMeta,
      TCaps,
      BrandsOf<TCapabilities>,
      TOutgoing,
      false,
      ChannelServerRequests<TCapabilities>
    >,
  ) => void | Promise<void>;
  /** Runs on a true leave (explicit unsubscribe / kick), not a plain disconnect. */
  readonly onUnsubscribe?: (
    ctx: ChannelGateCtx<
      TSlots,
      TMeta,
      TCaps,
      BrandsOf<TCapabilities>,
      TOutgoing,
      false,
      ChannelServerRequests<TCapabilities>
    >,
  ) => void | Promise<void>;
  /** Runs on every session end, including a plain disconnect. */
  readonly onSessionEnd?: (
    ctx: ChannelGateCtx<
      TSlots,
      TMeta,
      TCaps,
      BrandsOf<TCapabilities>,
      TOutgoing,
      false,
      ChannelServerRequests<TCapabilities>
    >,
  ) => void | Promise<void>;
  /** Inspect every incoming frame in this channel before routing. */
  readonly intercept?: (
    ctx: ChannelGateCtx<
      TSlots,
      TMeta,
      TCaps,
      BrandsOf<TCapabilities>,
      TOutgoing,
      false,
      ChannelServerRequests<TCapabilities>
    >,
    frame: InterceptFrame,
  ) => unknown | void;
  /** Whether membership survives a reconnect (default `'ephemeral'`). */
  readonly membership?: 'persistent' | 'ephemeral';
  /**
   * Per-channel replay opt-in/out, cascading from `server`. `true` is
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
type ChannelHandlerContribution<TKey extends string, TOwn, TSlice> = ChannelHandlerValue &
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
> = ('binary' extends TChannelBrand ? ChannelOutgoingSlice<TOutgoing> : { outgoing: TOutgoing }) & {
  // Binary server requests stay on this map under a symbol key: `InferClient` reads them back.
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
  run(
    ctx: ChannelCtx<TSlots, TMeta, TParams, TOutgoing, TCaps, TServerRequests, TChannelBrand> & {
      stream: StreamHandleBase & NudgesHandle<TNudges>;
    },
    input: InferInput<TInput extends Validator | undefined ? TInput : undefined>,
  ): AsyncGenerator<TChunk, void, unknown>;
} & RateLimitField<TCaps>;

/**
 * A channel's `stream` method. It returns a handler value carrying both the
 * client-contract type and a reference back to the channel, and doesn't change
 * the channel. Pass handler values to `assemble()` to select them; passing the
 * channel itself only includes its configuration and hooks.
 */
export interface ChannelStreamMethod<
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
    TChunk extends Payload = Record<string, unknown>,
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
        { payload: InferInput<TInput>; chunk: Jsonify<TChunk>; nudges: NudgesContract<TNudges> }
      >;
    }
  >;
}

export interface ChannelRecordedStreamMethod<
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
        {
          payload: InferInput<TInput>;
          chunk: DurableWireChunk<TChunk>;
          nudges: NudgesContract<TNudges>;
        }
      >;
    }
  >;
}

/**
 * The stream methods a channel exposes, each present only when its matching
 * stream capability is listed — mirroring the top-level brand gating.
 */
type ChannelStreamMethods<
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

type ChannelObject<
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
  ChannelRefForm<TParams, TOutgoing, TAddressing>;

/**
 * How a channel declaration is referenced in `ctx.channels.get(...)`. A static channel
 * IS a ref (pass it directly). A dynamic family is not — it exposes `.at(params)`
 * to bind an instance, and only that ref carries the channel's contract. So
 * `.at(...)` exists only on family declarations.
 */
type ChannelRefForm<TParams, TOutgoing, TAddressing extends string> = TAddressing extends 'dynamic'
  ? { at(params: TParams): ChannelRef<TOutgoing> }
  : ChannelRef<TOutgoing>;

/**
 * The channel methods present whatever stream capabilities are listed. It drops
 * the runtime builder's loosely-typed handler and lifecycle methods so the
 * precisely-typed versions here (and the brand-gated stream methods in
 * `ChannelStreamMethods`) are the only source — that is what makes the typing
 * and gating real.
 */
type ChannelObjectCore<
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
> = Omit<ChannelBuilder, 'on' | 'request' | 'stream' | 'recordedStream' | 'at' | 'binary'> &
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
  ('binary' extends BrandsOf<TCaps>
    ? ChannelBinaryMethods<
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

/** Configuration object for a `binary.on(...)` handler, at the top level or in a channel. */
type BinaryOnConfig<TCtx, TInput, TCaps extends readonly AnyCapability[]> = {
  /** Optional schema for the info. Omit it to accept any info (typed `unknown`). */
  readonly input?: TInput;
  /**
   * The most bytes the frame may carry. Optional: without it, the limit is the largest
   * that fits in the adapter's message limit. A value that cannot fit fails at startup.
   */
  readonly maxBytes?: number;
  /** Run this handler alongside earlier work on the same connection. Defaults to ordered execution. */
  readonly allowInterleaving?: boolean;
  /**
   * Runs each time the client sends this binary event, with the checked info and a plain
   * `Uint8Array` view of the bytes. The view shares the frame's memory: `bytes.slice()`
   * copies it, for code that keeps the bytes after `run` returns.
   */
  run(ctx: TCtx, input: InferInput<TInput>, bytes: Uint8Array): void | Promise<void>;
} & RateLimitField<TCaps>;

/** What a `binary.request(...)` handler's `run` returns: the reply's info, then its bytes. */
interface BinaryReply<TInfo> {
  /** The reply's info: a plain object, or `null` when there is nothing to say. */
  readonly info: TInfo;
  /** The reply's bytes. Leave them out to reply with none. */
  readonly bytes?: BinaryInput;
}

/** One chunk a `binary.stream(...)` generator yields: its info, then its bytes. */
interface BinaryChunk<TInfo> {
  /** The chunk's info: a plain object, or `null` when there is nothing to say. */
  readonly info: TInfo;
  /** The chunk's bytes. */
  readonly bytes: BinaryInput;
}

/**
 * A reply with no keys but `info` and `bytes`. A typo such as `byte` must not compile into a
 * reply with no bytes, and an inferred return type gets no excess-property check.
 */
type ExactReply<TReply> = BinaryReply<Payload> & {
  readonly [K in Exclude<keyof TReply, 'info' | 'bytes'>]: never;
};

/** Configuration object for a `binary.request(...)` handler, at the top level or in a channel. */
type BinaryRequestConfig<TCtx, TInput, TReply, TCaps extends readonly AnyCapability[]> = {
  /** Optional schema for the request's info. Omit it to accept any info (typed `unknown`). */
  readonly input?: TInput;
  /** The most bytes the request frame may carry. As on `binary.on(...)`. */
  readonly maxBytes?: number;
  /** Run this request alongside earlier work on the same connection. Defaults to interleaved execution. */
  readonly allowInterleaving?: boolean;
  /**
   * Runs the request, with the checked info and the request's bytes, and returns the reply:
   * `{ info, bytes }`, sent as one binary frame. The reply type comes from what it returns.
   */
  run(ctx: TCtx, input: InferInput<TInput>, bytes: Uint8Array): TReply | Promise<TReply>;
} & RateLimitField<TCaps>;

/** The info type of a binary request's reply. */
type ReplyInfo<TReply> = TReply extends { readonly info: infer TInfo } ? TInfo : never;

/** Configuration object for a `binary.stream(...)` handler, at the top level or in a channel. */
type BinaryStreamConfig<TCtx, TInput, TChunk, TNudges> = {
  /** Optional schema for the info of the frame that starts the stream. */
  readonly input?: TInput;
  /** The most bytes the frame that starts the stream may carry. As on `binary.on(...)`. */
  readonly maxBytes?: number;
  /** Optional explicit type of each chunk's info. Otherwise inferred from what `run` yields. */
  readonly chunk?: TypeMarker<TChunk>;
  /** Client→server steering signals delivered into the running generator. They are text frames. */
  readonly nudges?: TNudges;
  /** Fan the stream out to every connection (or channel member) instead of one. */
  readonly broadcast?: boolean;
  /** Permit overlapping streams of the same event on one connection (default false). */
  readonly allowConcurrent?: boolean;
  /** The async generator: each `{ info, bytes }` it yields is sent as one binary frame. */
  run(
    ctx: TCtx,
    input: InferInput<TInput>,
    bytes: Uint8Array,
  ): AsyncGenerator<BinaryChunk<TChunk>, void, unknown>;
};

/** The contract entry of one binary stream. */
type BinaryStreamEntry<TInput, TChunk, TNudges> = {
  payload: InferInput<TInput>;
  chunk: Jsonify<TChunk>;
  nudges: NudgesContract<TNudges>;
};

/** A channel's `binary.request(...)`, granted by `binary()` with `clientRequests()`. */
interface ChannelBinaryRequestMethods<
  TCtx,
  TKey extends string,
  TOwn,
  TCaps extends readonly AnyCapability[],
> {
  /** Create a binary request handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  request<
    TEvent extends string,
    TInput extends Validator | undefined = undefined,
    TReply extends ExactReply<TReply> = BinaryReply<null>,
  >(
    event: TEvent,
    config: BinaryRequestConfig<TCtx, TInput, TReply, TCaps>,
  ): ChannelHandlerContribution<
    TKey,
    TOwn,
    {
      binaryClientRequests: Record<
        TEvent,
        { payload: InferInput<TInput>; response: ReplyInfo<TReply> }
      >;
    }
  >;
}

/** A channel's `binary.stream(...)`, granted by `binary()` with `stream()`. */
interface ChannelBinaryStreamMethods<
  TCtx,
  TKey extends string,
  TOwn,
  TCaps extends readonly AnyCapability[],
> {
  /** Create a binary stream handler value scoped to this channel. Pass it to `assemble()` to activate it. */
  stream<
    TEvent extends string,
    TChunk extends Payload = Record<string, unknown>,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: BinaryStreamConfig<
      TCtx & { stream: StreamHandleBase & NudgesHandle<TNudges> },
      TInput,
      TChunk,
      TNudges
    > &
      RateLimitField<TCaps>,
  ): ChannelHandlerContribution<
    TKey,
    TOwn,
    { binaryStreams: Record<TEvent, BinaryStreamEntry<TInput, TChunk, TNudges>> }
  >;
}

/**
 * A channel's `binary.on(...)`, granted by the `binary()` capability, with `binary.request`
 * and `binary.stream` when `clientRequests()` and `stream()` are listed too.
 */
export interface ChannelBinaryMethods<
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
  readonly binary: {
    /** Create a binary event handler value scoped to this channel. Pass it to `assemble()` to activate it. */
    on<TEvent extends string, TInput extends Validator | undefined = undefined>(
      event: TEvent,
      config: BinaryOnConfig<
        ChannelCtx<TSlots, TMeta, TParams, TOutgoing, TCaps, TServerRequests, TChannelBrand>,
        TInput,
        TCaps
      >,
    ): ChannelHandlerContribution<
      TKey,
      ChannelOwnSlice<TParams, TOutgoing, TAddressing, TSubscribe, TServerRequests, TChannelBrand>,
      { binaryIncoming: Record<TEvent, InferInput<TInput>> }
    >;
  } & ('clientRequests' extends BrandsOf<TCaps>
    ? ChannelBinaryRequestMethods<
        ChannelCtx<TSlots, TMeta, TParams, TOutgoing, TCaps, TServerRequests, TChannelBrand>,
        TKey,
        ChannelOwnSlice<
          TParams,
          TOutgoing,
          TAddressing,
          TSubscribe,
          TServerRequests,
          TChannelBrand
        >,
        TCaps
      >
    : {}) &
    ('stream' extends BrandsOf<TCaps>
      ? ChannelBinaryStreamMethods<
          ChannelCtx<TSlots, TMeta, TParams, TOutgoing, TCaps, TServerRequests, TChannelBrand>,
          TKey,
          ChannelOwnSlice<
            TParams,
            TOutgoing,
            TAddressing,
            TSubscribe,
            TServerRequests,
            TChannelBrand
          >,
          TCaps
        >
      : {});
}

/** The `on` method and the type-only `ctx` carriers every channel object has. */
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
  /**
   * Type only, never set at runtime. It carries the `ctx` type that this channel's `check`,
   * `commit` and `revalidate` hooks receive, so `context.channelGate(channel)` can return it.
   *
   * @internal
   */
  readonly __gateCtx?: ChannelGateCtx<TSlots, TMeta, TCaps, never, TOutgoing, true>;
  /**
   * Type only, never set at runtime. It carries the `ctx` type that this channel's
   * `onSubscribe`, `onUnsubscribe` and `onSessionEnd` hooks receive, so
   * `context.channelLifecycle(channel)` can return it.
   *
   * @internal
   */
  readonly __lifecycleCtx?: ChannelGateCtx<
    TSlots,
    TMeta,
    TCaps,
    TChannelBrand,
    TOutgoing,
    false,
    TServerRequests
  >;

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
    TResponse extends PayloadObject | null | void = void,
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
      clientRequests: Record<
        TEvent,
        { payload: InferInput<TInput>; response: ClientResponse<Awaited<TResponse>> }
      >;
    }
  >;
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
      ? ValidChannelBinary<T, THostCaps>
      : readonly Exclude<T[number], ServerRequestsCapability>[]
    : ValidChannelBinary<T, THostCaps>;

/**
 * A channel's own `binary()` needs `binary()` at the root too, and its `serverRequests` need
 * `serverRequests()` at the root, as a channel's `serverRequests(...)` do.
 */
type ValidChannelBinary<
  T extends readonly ChannelCapability[],
  THostCaps extends readonly AnyCapability[],
> =
  'binary' extends BrandsOf<T>
    ? 'binary' extends BrandsOf<THostCaps>
      ? [keyof SlotOr<ChannelCapabilitySlots<T>, 'binaryServerRequests'>] extends [never]
        ? T
        : 'serverRequests' extends BrandsOf<THostCaps>
          ? T
          : readonly Exclude<T[number], BinaryCapability<EmitDefs>>[]
      : readonly Exclude<T[number], BinaryCapability<EmitDefs>>[]
    : T;

/** Builder method granted by the `channels()` capability. */
interface ChannelMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
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
    pattern: readonly [TFamily, TPattern & ValidChannelTemplate<TPattern>],
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

/**
 * The builder methods the listed capabilities grant `base`, selected by each
 * capability's brand. A capability with no brand grants nothing.
 */
type CapabilityMethods<
  TSlots,
  TMeta,
  TBrand extends string,
  TCaps extends readonly AnyCapability[],
> = ('clientRequests' extends TBrand ? RequestMethods<TSlots, TMeta, TCaps> : {}) &
  ('scheduled' extends TBrand ? ScheduledMethods<TSlots, TMeta, TCaps> : {}) &
  ('stream' extends TBrand ? StreamMethods<TSlots, TMeta, TCaps> : {}) &
  ('recordedStream' extends TBrand ? RecordedStreamMethods<TSlots, TMeta, TCaps> : {}) &
  ('channels' extends TBrand ? ChannelMethods<TSlots, TMeta, TCaps> : {}) &
  ('binary' extends TBrand ? BinaryMethods<TSlots, TMeta, TCaps, TBrand> : {});

/** The value `base.binary.on(...)` returns — a handler primitive that declares its binary slot. */
export type BinaryIncomingHandlerValue<TEvent extends string, TPayload> = IncomingPrimitive<
  TEvent,
  TPayload
> &
  Contribution<{ binaryIncoming: Record<TEvent, TPayload> }>;

/**
 * Builder methods granted by the `binary()` capability, under `base.binary`. A binary
 * handler takes the same options as its JSON version, plus `maxBytes`.
 */
interface BinaryMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[], TBrand> {
  readonly binary: {
    /**
     * Create a handler value for one client→server binary event: JSON info, which
     * `input` checks, and raw bytes, which `maxBytes` limits. Pass the returned value to
     * `assemble()` to activate it.
     */
    on<TEvent extends string, TSchema extends Validator | undefined = undefined>(
      event: TEvent,
      config: BinaryOnConfig<AppCtx<TSlots, TMeta, TCaps>, TSchema, TCaps>,
    ): BinaryIncomingHandlerValue<TEvent, InferInput<TSchema>>;
  } & ('clientRequests' extends TBrand ? BinaryRequestMethods<TSlots, TMeta, TCaps> : {}) &
    ('stream' extends TBrand ? BinaryStreamMethods<TSlots, TMeta, TCaps> : {});
}

/** The value `base.binary.request(...)` returns — a handler primitive that declares its slot. */
export type BinaryRequestHandlerValue<TEvent extends string, TPayload, TInfo> = RequestPrimitive<
  TEvent,
  TPayload,
  TInfo
> &
  Contribution<{ binaryClientRequests: Record<TEvent, { payload: TPayload; response: TInfo }> }>;

/** `base.binary.request(...)`, granted by `binary()` with `clientRequests()`. */
interface BinaryRequestMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Create a handler value for one client→server binary request. Like `base.request`, but
   * the request and the reply are binary frames: `run` gets the checked info and the bytes,
   * and returns `{ info, bytes }`. The reply type comes from what it returns. A registered
   * error that `run` throws goes back as the normal text `__error__`.
   */
  request<
    TEvent extends string,
    TSchema extends Validator | undefined = undefined,
    TReply extends ExactReply<TReply> = BinaryReply<null>,
  >(
    event: TEvent,
    config: BinaryRequestConfig<AppCtx<TSlots, TMeta, TCaps>, TSchema, TReply, TCaps>,
  ): BinaryRequestHandlerValue<TEvent, InferInput<TSchema>, ReplyInfo<TReply>>;
}

/** `base.binary.stream(...)`, granted by `binary()` with `stream()`. */
interface BinaryStreamMethods<TSlots, TMeta, TCaps extends readonly AnyCapability[]> {
  /**
   * Create a server-pushed binary stream handler value. Like `base.stream`, but each chunk is
   * one binary frame: the generator yields `{ info, bytes }`. `__streamOk__`, `__streamEnd__`,
   * errors, cancels and nudges stay text frames.
   */
  stream<
    TEvent extends string,
    TChunk extends Payload = Record<string, unknown>,
    TInput extends Validator | undefined = undefined,
    const TNudges extends StreamNudgeMap = {},
  >(
    event: TEvent,
    config: BinaryStreamConfig<StreamCtx<TSlots, TMeta, TNudges, TCaps>, TInput, TChunk, TNudges>,
  ): StreamHandlerValue<TEvent, BinaryStreamEntry<TInput, TChunk, TNudges>, 'binaryStreams'>;
}

/**
 * The builder returned by `server(...)`. Carries the methods every server has
 * (`on`, `assemble`) plus any
 * methods the listed capabilities grant through their brands — for example,
 * `request` exists only when `clientRequests()` is listed.
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
type PluginIdsOf<TSlots> = keyof SlotOr<TSlots, 'plugins'> extends never
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

  /**
   * Collect every routed handler into the final server definition the platform adapter runs.
   * Pass them as `{ handlers: [...] }` — each `base.on(...)` (and, with their
   * capabilities, `request` / `stream` / `channel`) value. A channel handler
   * enables only itself; passing the channel includes its configuration but no
   * handlers. Pass each `base.scheduled(...)` value too. The hooks and upgrade from
   * `server({ ... })`, and listed capabilities, are folded in automatically.
   *
   * A scoped plugin server definition (`server({ scope: 'plugin' })`) may also pass `api` —
   * the per-connection surface the host reaches via `ctx.plugin(id)`. Its `ctx`
   * is the plugin's own scoped ctx, the same one its handlers receive.
   *
   * Capabilities belong in `server({ capabilities: [...] })`, not here — passing
   * one is a type error.
   */
  assemble<const THandlers extends readonly AssembleInput[], TApi = unknown>(config: {
    readonly handlers: CheckedHandlers<THandlers, keyof ScheduledMap<TSlots> & string>;
    readonly api?: (
      ctx: TScoped extends true
        ? AppCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TMeta, TCaps>
        : ConnectionlessCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TMeta, TCaps>,
    ) => TApi;
  }): ServerDefinition<
    readonly Primitive[],
    BuildContract<MergeSlots<TSlots | SlotsOf<THandlers[number]>>>,
    AppCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TMeta, TCaps>,
    TApi,
    ConnectionlessCtx<MergeSlots<TSlots | SlotsOf<THandlers[number]>>, TMeta, TCaps>
  >;
}

/** A value `assemble(...)` accepts — a routed handler or channel, never a capability. */
type AssembleInput = Contribution & { readonly __livethingCapability?: never };

type EventNamesOf<TSlice> =
  | (TSlice extends { incoming: infer R } ? keyof R & string : never)
  | (TSlice extends { binaryIncoming: infer R } ? keyof R & string : never)
  | (TSlice extends { binaryClientRequests: infer R } ? keyof R & string : never)
  | (TSlice extends { binaryStreams: infer R } ? keyof R & string : never)
  | (TSlice extends { clientRequests: infer R } ? keyof R & string : never)
  | (TSlice extends { streams: infer R } ? keyof R & string : never)
  | (TSlice extends { recordedStreams: infer R } ? keyof R & string : never);

/** Keep a name only when it's one exact string. `string` or a union could be any name, so only `assemble()` can check it. */
type ExactName<TName extends string, TAll extends string = TName> = TName extends unknown
  ? [TAll] extends [TName]
    ? {} extends Record<TName, 1>
      ? never
      : TName
    : never
  : never;

/** The scoped names one handler binds: `server:<event>`, `<channel>:<event>` or `task:<id>`. */
type HandlerScopedNames<THandler> =
  | (THandler extends ScheduledHandlerValue<infer TTaskId> ? `task:${TTaskId}` : never)
  | (THandler extends { __contributes?: infer TContribution }
      ? NonNullable<TContribution> extends infer TSlice
        ?
            | `server:${EventNamesOf<TSlice>}`
            | (TSlice extends { channels: infer TChannels }
                ? {
                    [K in keyof TChannels & string]: `channel:${K}:${EventNamesOf<TChannels[K]>}`;
                  }[keyof TChannels & string]
                : never)
        : never
      : never);

type FirstDuplicateName<
  THandlers extends readonly unknown[],
  TSeen extends string = never,
> = THandlers extends readonly [infer TFirst, ...infer TRest]
  ? [ExactName<HandlerScopedNames<TFirst>> & TSeen] extends [never]
    ? FirstDuplicateName<TRest, TSeen | ExactName<HandlerScopedNames<TFirst>>>
    : ExactName<HandlerScopedNames<TFirst>> & TSeen
  : never;

type DuplicateNameMessage<TName extends string> = TName extends `server:${infer TEvent}`
  ? `Duplicate event '${TEvent}': two handlers at the top level use this name. Remove one or rename it.`
  : TName extends `channel:${infer TChannel}:${infer TEvent}`
    ? `Duplicate event '${TEvent}' on channel '${TChannel}': two handlers use this name. Remove one or rename it.`
    : TName extends `task:${infer TTaskId}`
      ? `Duplicate scheduled task '${TTaskId}': two handlers run this task. Remove one.`
      : never;

/** The declared tasks with no handler in this list, or `never` when the list's length is unknown. */
type MissingTask<
  THandlers extends readonly unknown[],
  TDeclaredTasks extends string,
> = number extends THandlers['length']
  ? never
  : Exclude<TDeclaredTasks, THandlers[number] extends infer H ? TaskIdOf<H> : never>;

type TaskIdOf<THandler> = THandler extends ScheduledHandlerValue<infer TTaskId> ? TTaskId : never;

/** One member of a union: inferring from an intersection of functions reads the last overload. */
type OneMemberOf<TUnion> =
  UnionToIntersection<TUnion extends unknown ? () => TUnion : never> extends () => infer TMember
    ? TMember
    : never;

type MissingTaskMessage<TTask> = TTask extends string
  ? `Scheduled task '${TTask}' has no handler. Pass base.scheduled('${TTask}', ...) to assemble().`
  : never;

/**
 * `assemble()`'s `handlers` type. It stays the list itself when the list is valid, and
 * becomes a readable message when it isn't, so the compile error says what to fix. A list
 * whose length isn't known (no `as const`) can't be checked here; `assemble()` checks it
 * when it runs.
 */
type CheckedHandlers<THandlers extends readonly unknown[], TDeclaredTasks extends string> = [
  FirstDuplicateName<THandlers>,
] extends [never]
  ? [MissingTask<THandlers, TDeclaredTasks>] extends [never]
    ? THandlers
    : MissingTaskMessage<OneMemberOf<MissingTask<THandlers, TDeclaredTasks>>>
  : DuplicateNameMessage<FirstDuplicateName<THandlers>>;

/** The rate-limit slots `assemble(...)` reads off a collected channel object. @internal */
interface ChannelRateLimitSource {
  readonly __key: string;
  readonly __rateLimit?: RateLimitConfig;
}

/**
 * The primitive kinds that route by event name. An event name can belong to at
 * most one of these across a scope, so two of them sharing a name collide.
 */
const ROUTING_KINDS = new Set([
  'incoming',
  'request',
  'stream-generate',
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
      throw new LiveThingConfigError(
        `Duplicate ${handler.__livething} handler` +
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
          throw new LiveThingConfigError(
            `Event name '${event}' is bound by both a ${owner} handler and a ` +
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
        throw new LiveThingConfigError(
          `duplicate serverRequests() declaration for '${key}'. ` +
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

/** The hooks written in `server({ ... })` and their primitives, in the order they register. */
const SERVER_HOOK_PRIMITIVES = {
  onInit,
  onConnect,
  onDisconnect,
  onPing,
  onPong,
  onError,
  onShutdown,
  intercept: interceptFactory,
  onOutgoing: outgoingHookFactory,
} as const satisfies Record<string, (hook: any) => Primitive>;

const SERVER_CONFIG = {
  hooks: ['upgrade', ...Object.keys(SERVER_HOOK_PRIMITIVES)],
  options: ['capabilities', 'hibernation', 'users', 'scope'],
};

/** Build the primitives for the hooks written in `server({ ... })`. */
function buildHookPrimitives(config: Record<string, unknown>): Primitive[] {
  const primitives: Primitive[] = [];
  for (const [hook, build] of Object.entries(SERVER_HOOK_PRIMITIVES)) {
    if (config[hook]) primitives.push((build as (hook: unknown) => Primitive)(config[hook]));
  }

  return primitives;
}

/** Put the `serverRequests(...)` of the channels in this definition into its request table. */
function addChannelServerRequests(primitives: Primitive[], channels: readonly object[]): void {
  const requests = new Map<string, ResolvedServerRequest>();
  for (const channel of channels as readonly ChannelBuilder[]) {
    for (const [key, request] of channel.__serverRequests) requests.set(key, request);
  }

  const carrier = primitives.find((primitive) => primitive.__livething === 'server-requests');
  if (requests.size > 0 && carrier) {
    primitives.push((carrier as ServerRequestsPrimitive).__withServerRequests(requests));
  }
}

/** Put the root `binary({ serverRequests })` declarations into this definition's request table. */
function addBinaryServerRequests(
  primitives: Primitive[],
  capabilities: readonly AnyCapability[],
): void {
  const requests = capabilities
    .map((cap) => (cap as Partial<BinaryCapability>).__binaryServerRequests)
    .find((declared) => declared && Object.keys(declared).length > 0);
  if (!requests) return;

  const resolve = capabilities
    .map((cap) => (cap as Partial<ServerRequestsCapability>).__resolveChannelServerRequests)
    .find(Boolean);
  const carrier = primitives.find((primitive) => primitive.__livething === 'server-requests');
  if (!resolve || !carrier) {
    throw new LiveThingConfigError(
      'binary({ serverRequests }) needs serverRequests(). Add serverRequests() to capabilities.',
    );
  }

  primitives.push(
    (carrier as ServerRequestsPrimitive).__withServerRequests(resolve(null, requests, true)),
  );
}

/** Refuse a handler or channel made by another `server()`. It would run with the wrong capabilities. */
function assertFromBase(item: object, baseId: symbol): void {
  const { __baseId: owner } =
    (item as { __channel?: { __baseId?: symbol } }).__channel ?? (item as { __baseId?: symbol });
  if (owner !== undefined && owner !== baseId) {
    throw new LiveThingConfigError(
      'A value passed to assemble() comes from a different server() base. ' +
        'Create handlers and channels on the base you call assemble() on.',
    );
  }
}

/**
 * Pair every declared scheduled task with its body and build the task
 * primitives. A declared task with no body, or a body with no declaration, is a
 * build error.
 */
function mergeScheduled(
  declarations: ReadonlyMap<string, ScheduledDeclaration>,
  bodies: ReadonlyMap<string, (ctx: ConnectionlessContext, data?: unknown) => void | Promise<void>>,
  build: ScheduledCapability['__buildScheduled'] | undefined,
): Primitive[] {
  const primitives: Primitive[] = [];
  for (const [taskId, declaration] of declarations) {
    const body = bodies.get(taskId);
    if (!body) {
      throw new LiveThingConfigError(
        `Scheduled task '${taskId}' has no handler. ` +
          `Pass base.scheduled('${taskId}', ...) to assemble().`,
      );
    }

    primitives.push(build!(taskId, declaration, body));
  }

  for (const taskId of bodies.keys()) {
    if (!declarations.has(taskId)) {
      throw new LiveThingConfigError(
        `base.scheduled('${taskId}') has no matching declaration. ` +
          `Declare it in the scheduled({ ... }) capability.`,
      );
    }
  }

  return primitives;
}

/** Turn the `upgrade` ephemeral-tag sugar `{ group: key | keys }` into the engine's tag refs. */
function toEphemeralTagRefs(
  ephemeral: Record<string, string | readonly string[] | undefined> | undefined,
): TagRef[] {
  if (!ephemeral) return [];

  const refs: TagRef[] = [];
  for (const [group, keys] of Object.entries(ephemeral)) {
    if (keys === undefined) continue;

    for (const key of typeof keys === 'string' ? [keys] : keys) {
      refs.push({ __livething: 'tag-ref', kind: 'ephemeral', group, key });
    }
  }

  return refs;
}

/** Wrap a bootstrap `upgrade(...)` function as the engine's builder upgrade hook. */
function adaptUpgrade(fn: UpgradeFn<any>): UpgradeHandler {
  return async (request, helpers): Promise<UpgradeResult> => {
    const result = await fn(request, helpers.ctx);
    const tags = toEphemeralTagRefs(result.tags?.ephemeral);
    return {
      // An upgrade that omits userId stays anonymous and does not claim the single userId that
      // the server allows. The adapters key an anonymous connection by its connection id.
      ...(result.userId === undefined ? {} : { userId: result.userId }),
      meta: result.meta,
      ...(tags.length > 0 ? { tags } : {}),
    } as UpgradeResult;
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
function scopedUpgradePrimitive(handler: UpgradeHandler, baseId: symbol): Primitive {
  return {
    __livething: 'onUpgrade',
    __identity: [SCOPED_UPGRADE_KEY],
    __requires: {},
    __scopedUpgrade: true,
    __baseId: baseId,
    handler,
    __setup() {
      // Rewritten by namespacePluginPrimitives to bind the plugin id. Left inert
      // so a stray scoped upgrade that never went through plugin(...) is a no-op.
    },
  } as unknown as Primitive;
}

/**
 * Create a LiveThing server. `server(...)` holds the options (`upgrade`,
 * `hibernation`, `users`, `scope`) and the app-wide hooks; every other feature is a
 * capability you list. It returns a `base` builder whose methods are typed against
 * your metadata and capabilities.
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
  const TCaps extends readonly (PluginSafeCapability & TopLevelCapability)[] = readonly [],
>(
  config: ScopedServerConfig<TMeta, TCaps>,
): Base<MergeSlots<SlotsOf<TCaps[number]>>, TMeta, TCaps, true>;
export function server(config: any): any {
  if (typeof config !== 'object' || config === null) {
    throw new LiveThingConfigError(
      `server() needs a config object, got ${String(config)}. Pass {} for a server with no options.`,
    );
  }

  assertConfigShape(config, SERVER_CONFIG, 'server()');
  if (config.hibernation !== undefined && typeof config.hibernation !== 'boolean') {
    throw new LiveThingConfigError(
      `server(): 'hibernation' must be a boolean, got ${JSON.stringify(config.hibernation)}.`,
    );
  }

  assertUniqueCapabilityKinds(config.capabilities ?? [], 'server({ capabilities: [...] })');

  const scoped = config.scope === 'plugin';
  const hookPrimitives = buildHookPrimitives(config);
  const listsBinary = ((config.capabilities ?? []) as readonly AnyCapability[]).some(
    (cap) => cap.__capabilityKind === CAPABILITY_KIND.binary,
  );

  type StreamBuild = (event: string, streamConfig: unknown) => Primitive;

  function streamBuilder(
    kind: 'plain' | 'recorded',
    method: string,
    capabilityName: string,
  ): StreamBuild {
    for (const cap of config.capabilities ?? []) {
      const built = (cap as { __streamBuild?: { kind: string; build: StreamBuild } }).__streamBuild;
      if (built?.kind === kind) return built.build;
    }

    throw new LiveThingConfigError(
      `base.${method}() needs the ${capabilityName} capability. ` +
        `Add ${capabilityName} to capabilities.`,
    );
  }

  function buildRateLimitPrimitive(
    handlerPrimitives: readonly Primitive[],
    channelObjects: ReadonlyMap<
      { __build(selectedHandlers: readonly Primitive[]): Primitive },
      readonly Primitive[]
    >,
  ): Primitive | null {
    let buildRateLimit: RateLimitCapability['__buildRateLimit'] | undefined;
    for (const cap of config.capabilities ?? []) {
      const build = (cap as Partial<RateLimitCapability>).__buildRateLimit;
      if (!build) continue;

      if (buildRateLimit) {
        throw new LiveThingConfigError(
          'rateLimit() is listed more than once. Set one global rule, or none.',
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
      if (override !== undefined && event !== undefined) topOverrides.set(event, override);
    }

    if (topOverrides.size > 0) overrides.set('top', topOverrides);

    const channelKeys = new Set<string>();
    for (const [channel, handlers] of channelObjects) {
      const source = channel as unknown as ChannelRateLimitSource;
      channelKeys.add(source.__key);
      if (source.__rateLimit !== undefined) channelRules.set(source.__key, source.__rateLimit);
      const channelOverrides = new Map<string, RateLimitConfig>();
      for (const handler of handlers) {
        const override = (handler as { __rateLimit?: RateLimitConfig }).__rateLimit;
        const event = (handler as { event?: string }).event;
        if (override !== undefined && event !== undefined) channelOverrides.set(event, override);
      }

      if (channelOverrides.size > 0) overrides.set(`channel:${source.__key}`, channelOverrides);
    }

    const hasOverrides = overrides.size > 0 || channelRules.size > 0;
    if (!buildRateLimit && hasOverrides) {
      throw new LiveThingConfigError(
        'a per-handler rateLimit override needs the rateLimit() capability. ' +
          'Add rateLimit() to capabilities.',
      );
    }

    return buildRateLimit ? buildRateLimit({ overrides, channelRules, channelKeys }) : null;
  }

  const baseId = Symbol('livething.base');

  function fromThisBase<T extends object>(value: T): T {
    return Object.assign(value, { __baseId: baseId });
  }

  function assertListsBinary(method: string): void {
    if (!listsBinary) {
      throw new LiveThingConfigError(
        `base.binary.${method}() needs binary(). Add binary() to capabilities.`,
      );
    }
  }

  function buildRequest(
    method: 'request' | 'binary.request',
    event: string,
    requestConfig: ServerRequestConfigParameter,
  ): Primitive {
    const isBinary = method === 'binary.request';
    let build: ((e: string, c: RequestBuildConfig) => Primitive) | undefined;
    for (const cap of config.capabilities ?? []) {
      const candidate = (cap as Partial<ClientRequestsCapability>).__buildClientRequest;
      if (candidate) build = candidate;
    }

    if (!build) {
      throw new LiveThingConfigError(
        `base.${method}() needs clientRequests(). Add clientRequests() to capabilities.`,
      );
    }

    const primitive = build(event, {
      input: requestConfig.input,
      allowInterleaving: requestConfig.allowInterleaving,
      run: requestConfig.run,
      ...(isBinary ? { binary: true, maxBytes: requestConfig.maxBytes } : {}),
    });

    if (requestConfig.rateLimit !== undefined) {
      (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = requestConfig.rateLimit;
    }

    return fromThisBase(primitive);
  }

  const base = {
    __baseId: baseId,
    on(event: string, onConfig: OnConfig<any, any, any, any> & { rateLimit?: RateLimitConfig }) {
      const primitive = incomingFactory(event, onConfig.run as any, {
        validator: onConfig.input,
        allowInterleaving: onConfig.allowInterleaving,
      });
      if (onConfig.rateLimit !== undefined) {
        (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = onConfig.rateLimit;
      }

      return fromThisBase(primitive);
    },
    binary: {
      on(event: string, onConfig: BinaryOnConfigParameter) {
        assertListsBinary('on');
        const primitive = incomingFactory(event, onConfig.run, {
          validator: onConfig.input,
          allowInterleaving: onConfig.allowInterleaving,
          binary: true,
          maxBytes: onConfig.maxBytes,
        });
        if (onConfig.rateLimit !== undefined) {
          (primitive as { __rateLimit?: RateLimitConfig }).__rateLimit = onConfig.rateLimit;
        }

        return fromThisBase(primitive);
      },
      request(event: string, requestConfig: ServerRequestConfigParameter) {
        assertListsBinary('request');
        return buildRequest('binary.request', event, requestConfig);
      },
      stream(event: string, streamConfig: object) {
        assertListsBinary('stream');
        return fromThisBase(
          streamBuilder(
            'plain',
            'binary.stream',
            'stream()',
          )(event, {
            ...streamConfig,
            binary: true,
          }),
        );
      },
      recordedStream: refuseRecordedBinaryStream,
    },
    request(event: string, requestConfig: ServerRequestConfigParameter) {
      return buildRequest('request', event, requestConfig);
    },
    scheduled(taskId: string, taskConfig: ServerConfigParameter) {
      return fromThisBase({ __livethingScheduledTask: true, taskId, run: taskConfig.run });
    },
    stream(event: string, streamConfig: unknown) {
      return fromThisBase(streamBuilder('plain', 'stream', 'stream()')(event, streamConfig));
    },
    recordedStream(event: string, streamConfig: unknown) {
      return fromThisBase(
        streamBuilder('recorded', 'recordedStream', 'recordedStream()')(event, streamConfig),
      );
    },
    channel(pattern: unknown, channelConfig?: unknown) {
      let factory: ((p: unknown, c: unknown, deps: unknown) => unknown) | undefined;
      const streamBuilders: Record<string, unknown> = {};
      let buildReplay: unknown;
      let buildClientRequest: unknown;

      let resolveServerRequests: unknown;
      for (const cap of config.capabilities ?? []) {
        const candidate = (
          cap as { __channelFactory?: (p: unknown, c: unknown, deps: unknown) => unknown }
        ).__channelFactory;
        if (candidate) factory = candidate;
        const streamBuild = (cap as { __streamBuild?: { kind: string; build: unknown } })
          .__streamBuild;
        if (streamBuild) streamBuilders[streamBuild.kind] = streamBuild.build;
        const replayBuilder = (cap as { __buildReplay?: unknown }).__buildReplay;

        if (replayBuilder) buildReplay = replayBuilder;
        const request = (cap as { __buildClientRequest?: unknown }).__buildClientRequest;
        if (request) buildClientRequest = request;

        const resolveSR = (cap as { __resolveChannelServerRequests?: unknown })
          .__resolveChannelServerRequests;
        if (resolveSR) resolveServerRequests = resolveSR;
      }

      if (!factory) {
        throw new LiveThingConfigError(
          'base.channel() needs the channels() capability. Add channels() to capabilities.',
        );
      }

      return factory(pattern, channelConfig, {
        baseId,
        streamBuilders,
        buildReplay,
        buildClientRequest,
        resolveServerRequests,
        binary: listsBinary,
      });
    },
    assemble(assembleConfig: ServerAssembleConfigParameter) {
      if (!Array.isArray(assembleConfig?.handlers)) {
        throw new LiveThingConfigError("assemble() requires a 'handlers' array.");
      }

      const items = assembleConfig.handlers;
      const api = assembleConfig.api;
      assertUniquePluginIds(config.capabilities ?? []);
      assertPluginDependencies(config.capabilities ?? []);
      assertNoChannelOnlyCapabilities(config.capabilities ?? []);

      const handlerPrimitives: Primitive[] = [];
      const channelObjects = new Map<
        { __build(selectedHandlers: readonly Primitive[]): Primitive },
        Primitive[]
      >();
      const scheduledBodies = new Map<string, ScheduledHandlerValue['run']>();
      for (const [index, item] of items.entries()) {
        if (typeof item !== 'object' || item === null) {
          throw new LiveThingConfigError(
            `assemble() got ${String(item)} at handlers[${index}]. ` +
              'Pass handler values and channel objects.',
          );
        }

        assertFromBase(item, baseId);

        if ((item as { __livethingCapability?: unknown }).__livethingCapability) {
          throw new LiveThingConfigError(
            'A capability was passed to assemble(). List capabilities in ' +
              'server({ capabilities: [...] }) and pass routed handler values or channel objects to assemble().',
          );
        }

        const task = item as Partial<ScheduledHandlerValue>;
        if (task.__livethingScheduledTask) {
          if (scheduledBodies.has(task.taskId!)) {
            throw new LiveThingConfigError(
              `Duplicate scheduled task '${task.taskId}' passed to assemble(). ` +
                'Two handlers run this task. Remove one.',
            );
          }

          scheduledBodies.set(task.taskId!, task.run!);
          continue;
        }

        const channel = (
          item as {
            __channel?: { __build(selectedHandlers: readonly Primitive[]): Primitive };
          }
        ).__channel;
        if (channel) {
          if ((item as { __livethingChannel?: boolean }).__livethingChannel) {
            if (!channelObjects.has(channel)) channelObjects.set(channel, []);
          } else {
            const handler = (item as { __handler?: Primitive }).__handler;
            if (handler) {
              if (!channelObjects.has(channel)) channelObjects.set(channel, []);
              channelObjects.get(channel)?.push(handler);
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
            ? scopedUpgradePrimitive(adaptUpgrade(config.upgrade), baseId)
            : onUpgrade(adaptUpgrade(config.upgrade)),
        );
      }

      if (config.hibernation) primitives.push(hibernationFactory());
      for (const cap of config.capabilities ?? []) primitives.push(...cap.__primitives);
      if (rateLimitPrimitive) primitives.push(rateLimitPrimitive);

      primitives.push(...hookPrimitives);
      primitives.push(...handlerPrimitives);
      primitives.push(...scheduledPrimitives);
      primitives.push(...channelPrimitives);
      addChannelServerRequests(primitives, [...channelObjects.keys()]);

      addBinaryServerRequests(primitives, config.capabilities ?? []);

      mergeServerRequestPrimitives(primitives);

      const declaredErrors = primitives
        .filter((p): p is ErrorsPrimitive => p.__livething === 'errors')
        .flatMap((p) => p.defs);
      collectUnique(declaredErrors, (def) => def.code, {
        kind: 'error code',
        context: 'server({ capabilities: [...] })',
      });

      const replayCount = primitives.filter(
        (p) => p.__livething === 'replay' && !(p as { disabled?: boolean }).disabled,
      ).length;
      if (replayCount > 1) {
        throw new LiveThingConfigError(
          'replay (replay.history() / replay.snapshot()) is listed more than ' +
            'once. Use one replay strategy per scope.',
        );
      }

      function isDurableGenerate(p: Primitive): boolean {
        return p.__livething === 'recorded-stream-generate';
      }

      // A recorded stream can be declared at the top level or nested inside a
      // channel, so scan both — otherwise a channel-only recorded stream would
      // miss the retention sweep below.
      const hasDurableStream = primitives.some(
        (p) =>
          isDurableGenerate(p) ||
          (p.__livething === 'channel' &&
            ((p as { primitives?: readonly Primitive[] }).primitives ?? []).some(
              isDurableGenerate,
            )),
      );

      // Install the durable-stream retention sweep only when a recorded stream
      // handler actually exists — not merely because the capability is listed.
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
        assertOneOf(config.users.onExceed, ['replace', 'reject'], {
          field: 'onExceed',
          context: 'server({ users })',
        });
      }

      return Object.freeze({
        __livething: 'server' as const,
        __baseId: baseId,
        primitives: Object.freeze(primitives) as readonly Primitive[],
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
