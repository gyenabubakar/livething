/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Type-level wiring for the fluent server builder.
 *
 * This file describes what each builder can do after a feature is enabled.
 * In practice, each primitive updates the builder state, and these helpers
 * describe how that update changes the available fluent methods and `ctx`.
 */
import type { GroupBuilder, GroupPrimitive, ServerBuilder } from '~/_builder/server-builder.ts';
import type {
  HandlerCtxFromState,
  MergeRecords,
  NextState,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state';
import type { AckPrimitive } from '~/ack/ack.ts';
import type { ChannelBuilder } from '~/channel/builder.ts';
import type {
  ChannelChild,
  ChannelPattern,
  ChannelPrimitive,
  ScopeDeclaration,
} from '~/channel/channel.ts';
import type { InitContext, ShutdownContext, TaskContext } from '~/context.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';
import type { ErrorDef } from '~/errors/errors.ts';
import type { ErrorsPrimitive } from '~/errors/primitive.ts';
import type { EventContract } from '~/event.ts';
import type { HeartbeatOptions, HeartbeatPrimitive } from '~/heartbeat/heartbeat.ts';
import type { HibernationPrimitive } from '~/hibernation/hibernation.ts';
import type { InterceptMessage } from '~/intercept/intercept.ts';
import type { NamespaceBuilder } from '~/namespace/builder.ts';
import type { NamespaceChild, NamespacePrimitive } from '~/namespace/namespace.ts';
// ─── Feature applicator ────────────────────────────────────

import type { Primitive } from '~/primitive.ts';
import type { ReplayBuilder } from '~/replay/builder.ts';
import type { ReplayCustomBuilder } from '~/replay/custom/builder.ts';
import type { CustomReplayPrimitive } from '~/replay/custom/custom.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { ReplayType } from '~/replay/types.ts';
import type { RequestPrimitive, RespondMethod } from '~/request/request.ts';
import type { ScheduledBuilder, ScheduledPrimitive } from '~/scheduled/scheduled.ts';
import type { SequenceOptions, SequencePrimitive } from '~/sequence/sequence.ts';
import type { StreamBuilder } from '~/stream/builder.ts';
import type { NudgeDeclaration } from '~/stream/stream.ts';
import type { Validator } from '~/types.ts';

export type { ChannelBuilder, NamespaceBuilder, ReplayBuilder, ReplayCustomBuilder, StreamBuilder };

/**
 * The small runtime state every builder instance carries internally.
 *
 * `_primitives` is the ordered list of registered primitives.
 * `_featureApplicators` is the list of functions that attach fluent methods
 * like `.request(...)` or `.stream(...)`.
 */
export interface BuilderInternals {
  readonly _primitives: Primitive[];
  readonly _featureApplicators: FeatureApplicator[];
}

/**
 * A runtime function that attaches one feature's methods to a builder object.
 *
 * Example: `withRequests(...)` installs an applicator that adds `.request(...)`
 * to the builder.
 */
export type FeatureApplicator = (
  target: BuilderInternals,
  kind: 'server' | 'group' | 'namespace' | 'channel',
) => void;

// ─── Builder kind ──────────────────────────────────────────

/** The two top-level builder kinds. This controls which fluent methods are installed. */
export type BuilderKind = 'server' | 'group';

// ─── Full builder type aliases ─────────────────────────────

/** A `ServerBuilder` intersected with all feature methods unlocked by the current `TFeatures` flags. */
export type ServerBuilderFull<TState extends ScopeStateShape, TFeatures> = ServerBuilder<
  TState,
  TFeatures
> &
  FeatureMethods<TState, TFeatures, 'server'>;

/** A `GroupBuilder` intersected with all feature methods unlocked by the current `TFeatures` flags. */
export type GroupBuilderFull<TState extends ScopeStateShape, TFeatures> = GroupBuilder<
  TState,
  TFeatures
> &
  FeatureMethods<TState, TFeatures, 'group'>;

/** A `NamespaceBuilder` intersected with all namespace-level feature methods. */
export type NamespaceBuilderFull<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TName extends string,
  TFeatures,
> = NamespaceBuilder<TParentState, TState, TName, TFeatures> &
  NamespaceFeatureMethods<TParentState, TState, TName, TFeatures>;

/** A `ChannelBuilder` intersected with all channel-level feature methods. */
export type ChannelBuilderFull<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TPattern extends ChannelPattern,
  TFeatures,
> = ChannelBuilder<TParentState, TState, TPattern, TFeatures> &
  ChannelFeatureMethods<TParentState, TState, TPattern, TFeatures>;

// ─── Kind → full builder resolver ──────────────────────────

type FullBuilder<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> = Kind extends 'server'
  ? ServerBuilderFull<TState, TFeatures>
  : Kind extends 'group'
    ? GroupBuilderFull<TState, TFeatures>
    : never;

// ─── Helper types ──────────────────────────────────────────

type AnyErrorDef = ErrorDef<string, any>;

type StateWithMeta<TState extends ScopeStateShape, TMeta extends Record<string, unknown>> = {
  readonly kind: TState['kind'];
  readonly outgoing: TState['outgoing'];
  readonly hasAck: TState['hasAck'];
  readonly hasReplay: TState['hasReplay'];
  readonly contract: TState['contract'];
  readonly errors: TState['errors'];
  readonly meta: TMeta;
  readonly channelNames: TState['channelNames'];
  readonly scheduledTasks: TState['scheduledTasks'];
  readonly env: TState['env'];
};

type BuilderResult<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> = FullBuilder<TState, TFeatures, Kind>;

type BuilderAfterScheduled<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
  TTaskId extends string,
  TData,
  THasData extends boolean,
> = FullBuilder<
  NextState<TState, ScheduledPrimitive<TTaskId, TData, THasData, TaskContext>>,
  TFeatures,
  Kind
>;

export interface ScheduledBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /**
   * Register a scheduled task on a server or group builder.
   *
   * The callback receives a scheduled-task builder. Use `.data(schema)` when
   * the task should accept enqueue-time payload, use `.every(ms)` for recurring
   * work, use `.retry(...)` to control retry behavior, and finish with
   * `.run(...)`.
   *
   * Tasks without `.data(...)` run as `run((ctx) => ...)` and cannot be
   * enqueued with `data`. Tasks with `.data(schema)` run as
   * `run((ctx, data) => ...)`, and `ctx.schedule(...)` requires matching data.
   *
   * @example
   * ```ts
   * import { server } from '@wskit/server';
   * import { withScheduled } from '@wskit/server/scheduled';
   * import * as v from 'valibot';
   *
   * const app = withScheduled(server('app'))
   *   .scheduled('cleanup', (t) =>
   *     t.retry(false).run((ctx) => {
   *       ctx.broadcast('cleanup-done', { at: Date.now() });
   *     }),
   *   )
   *   .scheduled('send-to-conn', (t) =>
   *     t
   *       .data(v.object({ connectionId: v.string(), text: v.string() }))
   *       .run((ctx, data) => {
   *         ctx.sendToConnection(data.connectionId, 'message', { text: data.text });
   *       }),
   *   );
   * ```
   */
  scheduled<TTaskId extends string, TData = never, THasData extends boolean = false>(
    taskId: TTaskId,
    callback: (
      builder: ScheduledBuilder<TTaskId, TaskContext>,
    ) => ScheduledBuilder<TTaskId, TaskContext, TData, THasData, true>,
  ): BuilderAfterScheduled<TState, TFeatures, Kind, TTaskId, TData, THasData>;
}

// ─── Channel helper types ──────────────────────────────────

type ChannelState<TParentState extends ScopeStateShape> = ScopeState<
  'channel',
  TParentState['outgoing'],
  TParentState['hasAck'],
  TParentState['hasReplay'],
  { incoming: {}; outgoing: {}; requests: {}; streams: {}; channels: {}; namespaces: {} },
  readonly [],
  TParentState['meta'],
  TParentState['channelNames'],
  TParentState['scheduledTasks'],
  TParentState['env']
>;

type ChannelNameFromPattern<TPattern> = TPattern extends ScopeDeclaration
  ? string & {}
  : TPattern extends string
    ? TPattern
    : never;

type ChannelContract<TChannelState extends ScopeStateShape> = {
  incoming: TChannelState['contract']['incoming'];
  outgoing: TChannelState['contract']['outgoing'];
  requests: TChannelState['contract']['requests'];
  streams: TChannelState['contract']['streams'];
};

/** Type-level helpers for channels — used by the builder to track channel scope state, name resolution, and contract shape. */
export type { ChannelState, ChannelNameFromPattern, ChannelContract };

// ─── Namespace helper types ────────────────────────────────

type NamespaceState<TParentState extends ScopeStateShape> = ScopeState<
  'namespace',
  TParentState['outgoing'],
  TParentState['hasAck'],
  TParentState['hasReplay'],
  { incoming: {}; outgoing: {}; requests: {}; streams: {}; channels: {}; namespaces: {} },
  readonly [],
  TParentState['meta'],
  TParentState['channelNames'],
  TParentState['scheduledTasks'],
  TParentState['env']
>;

type NamespaceContract<TNsState extends ScopeStateShape> = {
  incoming: TNsState['contract']['incoming'];
  outgoing: TNsState['contract']['outgoing'];
  requests: TNsState['contract']['requests'];
  streams: TNsState['contract']['streams'];
};

/** Type-level helpers for namespaces — used by the builder to track namespace scope state and contract shape. */
export type { NamespaceState, NamespaceContract };

// ─── Stream helper types ───────────────────────────────────

type NudgeMap<TNudges extends readonly NudgeDeclaration[]> = {
  [TNudge in TNudges[number] as TNudge['event']]: TNudge extends NudgeDeclaration<
    string,
    infer TPayload
  >
    ? TPayload
    : never;
};

type StreamContractEntry<
  TEvent extends string,
  TPayload,
  TChunks,
  TNudges extends readonly NudgeDeclaration[],
> = Record<
  TEvent,
  { payload: TPayload; chunk: TChunks } & (keyof NudgeMap<TNudges> extends never
    ? {}
    : { nudges: NudgeMap<TNudges> })
>;

type StateWithStream<
  TState extends ScopeStateShape,
  TEvent extends string,
  TPayload,
  TChunks,
  TNudges extends readonly NudgeDeclaration[],
> = {
  readonly kind: TState['kind'];
  readonly outgoing: TState['outgoing'];
  readonly hasAck: TState['hasAck'];
  readonly hasReplay: TState['hasReplay'];
  readonly contract: {
    incoming: TState['contract']['incoming'];
    outgoing: TState['contract']['outgoing'];
    requests: TState['contract']['requests'];
    streams: MergeRecords<
      TState['contract']['streams'],
      StreamContractEntry<TEvent, TPayload, TChunks, TNudges>
    >;
    channels: TState['contract']['channels'];
    namespaces: TState['contract']['namespaces'];
  };
  readonly errors: TState['errors'];
  readonly meta: TState['meta'];
  readonly channelNames: TState['channelNames'];
  readonly scheduledTasks: TState['scheduledTasks'];
  readonly env: TState['env'];
};

/** The builder state shape after registering a stream endpoint. */
export type { StateWithStream };

type MethodFeatureMap = {
  ack: 'ack';
  dedup: 'dedup';
  heartbeat: 'heartbeat';
  sequence: 'sequence';
  hibernation: 'hibernation';
  errors: 'errors';
  onInit: 'lifecycle';
  onConnect: 'lifecycle';
  onDisconnect: 'lifecycle';
  onShutdown: 'lifecycle';
  onError: 'lifecycle';
  onUpgrade: 'lifecycle';
  onBinary: 'lifecycle';
  onValidationError: 'lifecycle';
  intercept: 'intercept';
  scheduled: 'scheduled';
  channel: 'channels';
  namespace: 'namespaces';
  request: 'requests';
  stream: 'streams';
  replay: 'replay';
  replayCustom: 'replayCustom';
};

type ActiveMethodKeys<TFeatures> = {
  [M in keyof MethodFeatureMap]: MethodFeatureMap[M] extends keyof TFeatures ? M : never;
}[keyof MethodFeatureMap];

/** Adds `ctx.ack()` support to top-level incoming handlers. */
export interface AckBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /**
   * Enable acknowledgements for incoming messages.
   *
   * Once registered, top-level incoming handlers receive `ctx.ack()`. Call it
   * after you have accepted or persisted a message so the client can resolve
   * its acknowledgement-aware send call.
   */
  ack(): FullBuilder<NextState<TState, AckPrimitive>, TFeatures, Kind>;
}

/** Adds incoming and outgoing deduplication. */
export interface DedupBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /**
   * Enable message deduplication.
   *
   * Incoming messages with a repeated `_messageId` are dropped before handlers
   * run, and outgoing application messages are stamped with a generated
   * `_messageId` for client-side replay/dedup workflows.
   */
  dedup(): FullBuilder<NextState<TState, DedupPrimitive>, TFeatures, Kind>;
}

/** Adds idle connection timeout handling. */
export interface HeartbeatBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /**
   * Close connections that stay silent for longer than `options.timeout`.
   *
   * Any incoming message refreshes the connection's idle timer. Use this when
   * you want the server to clean up abandoned sockets without writing your own
   * ping or timeout bookkeeping.
   */
  heartbeat(
    options: HeartbeatOptions,
  ): FullBuilder<NextState<TState, HeartbeatPrimitive>, TFeatures, Kind>;
}

/** Adds monotonically increasing sequence numbers to outgoing messages. */
export interface SequenceBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /**
   * Stamp outgoing application messages with a monotonically increasing `_seq`.
   *
   * Sequence numbers help clients order messages after reconnects or replay.
   * Pass options to persist the counter when the adapter provides storage.
   */
  sequence(
    options?: SequenceOptions,
  ): FullBuilder<NextState<TState, SequencePrimitive>, TFeatures, Kind>;
}

/** Enables platform websocket hibernation support. */
export interface HibernationBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /**
   * Opt this handler into platform websocket hibernation support.
   *
   * On adapters that support it, idle websocket connections can be parked and
   * later woken by incoming activity. Passing `false` explicitly disables the
   * feature while keeping the primitive in the build graph.
   */
  hibernation(
    enabled?: boolean,
  ): FullBuilder<NextState<TState, HibernationPrimitive>, TFeatures, Kind>;
}

/** Registers typed runtime error factories. */
export interface ErrorBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /**
   * Register one or more typed error definitions that handlers may throw.
   *
   * Registered errors keep their code and detail shape when they cross the
   * websocket boundary, so clients can handle expected failures without
   * parsing generic exception messages.
   */
  errors<const TDefs extends readonly [AnyErrorDef, ...AnyErrorDef[]]>(
    ...defs: TDefs
  ): FullBuilder<NextState<TState, ErrorsPrimitive<TDefs>>, TFeatures, Kind>;
}

/** Adds lifecycle hooks for server and connection events. */
export interface LifecycleBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /** Run once when the engine is initialized, before it starts handling messages. */
  onInit(handler: (ctx: InitContext) => void | Promise<void>): FullBuilder<TState, TFeatures, Kind>;

  /** Run after a websocket connection is accepted and its context is available. */
  onConnect(
    handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
  ): FullBuilder<TState, TFeatures, Kind>;

  /** Run after a websocket connection is closed or dropped. */
  onDisconnect(
    handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
  ): FullBuilder<TState, TFeatures, Kind>;

  /** Run when the engine is shutting down, even if no clients are connected. */
  onShutdown(
    handler: (ctx: ShutdownContext) => void | Promise<void>,
  ): FullBuilder<TState, TFeatures, Kind>;

  /**
   * Run when a handler throws an application error.
   *
   * Use this for logging, metrics, or mapping unexpected failures into a
   * product-specific response. Control-flow errors such as `Block` are not
   * treated as normal handler errors.
   */
  onError(
    handler: (
      ctx: HandlerCtxFromState<TState>,
      error: unknown,
      event?: string,
    ) => void | Promise<void>,
  ): FullBuilder<TState, TFeatures, Kind>;

  /**
   * Inspect an upgrade request before the websocket is accepted.
   *
   * Return connection `meta` to type `ctx.meta` in later handlers, and return
   * `tags` to attach searchable labels to the connection at upgrade time.
   */
  onUpgrade<TMeta extends Record<string, unknown> = Record<string, unknown>>(
    handler: (request: Request) =>
      | { meta?: TMeta; tags?: readonly string[] }
      | Promise<{
          meta?: TMeta;
          tags?: readonly string[];
        }>,
  ): FullBuilder<StateWithMeta<TState, TMeta>, TFeatures, Kind>;

  /** Handle raw binary frames from a connection without going through JSON event dispatch. */
  onBinary(
    handler: (ctx: HandlerCtxFromState<TState>, data: ArrayBuffer) => void | Promise<void>,
  ): FullBuilder<TState, TFeatures, Kind>;

  /**
   * Handle validation failures for incoming protocol messages.
   *
   * This runs when an event contract or channel subscription validator rejects
   * client-supplied data before the normal handler is called.
   */
  onValidationError(
    handler: (
      ctx: HandlerCtxFromState<TState>,
      event: string,
      validationError: unknown,
    ) => void | Promise<void>,
  ): FullBuilder<TState, TFeatures, Kind>;
}

/** Adds message interception hooks. */
export interface InterceptBuilderMethods<TBuilder, TState extends ScopeStateShape> {
  /**
   * Intercept every incoming message before its handler runs.
   *
   * Return a new payload to replace the current one. Return nothing to let
   * the original payload continue unchanged. The event name is locked —
   * routing was already resolved at dispatch entry, so any returned object
   * (even one shaped like `{ event, payload }`) is treated as the new
   * payload as a whole, not as a routing instruction.
   */
  intercept(
    handler: (
      ctx: HandlerCtxFromState<TState>,
      message: InterceptMessage,
    ) => unknown | void | Promise<unknown | void>,
  ): TBuilder;

  /**
   * Intercept a declared outgoing event by name.
   *
   * This overload is useful when the event has already been declared with
   * `.outgoing(...)`; the payload type comes from the current builder state.
   */
  intercept<TEvent extends string & keyof TState['contract']['outgoing']>(
    event: TEvent,
    handler: (
      ctx: HandlerCtxFromState<TState>,
      payload: TState['contract']['outgoing'][TEvent],
    ) =>
      | TState['contract']['outgoing'][TEvent]
      | void
      | Promise<TState['contract']['outgoing'][TEvent] | void>,
  ): TBuilder;

  /**
   * Intercept the event described by an event contract.
   *
   * Use this overload when you want the event name and payload type to come
   * directly from an `event(...)` declaration.
   */
  intercept<TEvent extends string, TPayload>(
    event: EventContract<TEvent, TPayload>,
    handler: (
      ctx: HandlerCtxFromState<TState>,
      payload: TPayload,
    ) => TPayload | void | Promise<TPayload | void>,
  ): TBuilder;
}

/** Adds channel scope declarations. */
export interface ChannelBuilderMethods<TState extends ScopeStateShape, TFeatures> {
  /**
   * Define a static or dynamic pub/sub channel.
   *
   * Static channels use a literal name such as `'lobby'`. Dynamic channels use
   * `scope(name, pattern)` so many concrete channel names can share one typed
   * handler while still broadcasting only within the matched channel name.
   */
  channel<TPattern extends ChannelPattern, TChannelState extends ScopeStateShape>(
    pattern: TPattern,
    callback: (
      builder: ChannelBuilderFull<TState, ChannelState<TState>, TPattern, TFeatures>,
    ) => ChannelBuilderFull<TState, TChannelState, TPattern, TFeatures>,
  ): ChannelPrimitive<
    TPattern,
    readonly ChannelChild[],
    ChannelNameFromPattern<TPattern>,
    ChannelContract<TChannelState>
  >;
}

/** Adds namespace scope declarations. */
export interface NamespaceBuilderMethods<TState extends ScopeStateShape, TFeatures> {
  /**
   * Define a named namespace with its own event contract.
   *
   * Namespaces isolate related events under one logical area of the app. Their
   * incoming, outgoing, request, and stream declarations are reflected in the
   * inferred client under that namespace instead of the top-level contract.
   */
  namespace<TName extends string, TNsState extends ScopeStateShape>(
    name: TName,
    callback: (
      builder: NamespaceBuilderFull<TState, NamespaceState<TState>, TName, TFeatures>,
    ) => NamespaceBuilderFull<TState, TNsState, TName, TFeatures>,
  ): NamespacePrimitive<TName, readonly NamespaceChild[], TName, NamespaceContract<TNsState>>;
}

/** Adds request/response handlers. */
export interface RequestBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /**
   * Register an incoming request handler that responds through `ctx.respond(...)`.
   *
   * Requests are client-initiated messages that expect a response payload. The
   * request payload comes from the event contract, and the response payload is
   * validated against `responseSchema` before it is sent back to the client.
   */
  request<TEvent extends string, TPayload, TResponse>(
    eventContract: EventContract<TEvent, TPayload>,
    responseSchema: Validator<TResponse>,
    handler: (
      ctx: HandlerCtxFromState<TState> & RespondMethod<TResponse>,
      payload: TPayload,
    ) => void | Promise<void>,
  ): FullBuilder<NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>, TFeatures, Kind>;
}

/** @internal */
type StreamOnlyState<
  TEvent extends string,
  TPayload,
  TChunks,
  TNudges extends readonly NudgeDeclaration[],
> = ScopeState<
  'top',
  Record<never, never>,
  false,
  false,
  {
    incoming: {};
    outgoing: {};
    requests: {};
    streams: StreamContractEntry<TEvent, TPayload, TChunks, TNudges>;
    channels: {};
    namespaces: {};
  },
  readonly [],
  Record<string, unknown>,
  never,
  {},
  Record<string, unknown>
>;

/**
 * The primitive returned by a server-level `.stream(...)` call. Pass it to
 * `.use(streamPrim)` to register the stream endpoint on a builder.
 */
export type StreamBundlePrimitive<
  TEvent extends string,
  TPayload,
  TChunks,
  TNudges extends readonly NudgeDeclaration[],
> = GroupPrimitive<StreamOnlyState<TEvent, TPayload, TChunks, TNudges>>;

/** Adds streaming handlers. */
export interface StreamBuilderMethods<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> {
  /**
   * Define a streaming endpoint and return its primitive for `.use(...)`.
   *
   * The callback receives a stream builder. Call `.chunk(schema)` to define
   * the chunk payload shape, optionally add `.nudge(...)` controls or
   * `.broadcast()`, then finish with `.generate(...)`. Mount the returned
   * primitive on a builder with `.use(streamPrim)` to register it.
   */
  stream<
    TEvent extends string,
    TPayload,
    TChunks,
    TNudges extends readonly NudgeDeclaration[] = readonly [],
  >(
    eventContract: EventContract<TEvent, TPayload>,
    callback: (
      builder: StreamBuilder<FullBuilder<TState, TFeatures, Kind>, TState, TEvent, TPayload>,
    ) => StreamBuilder<
      FullBuilder<TState, TFeatures, Kind>,
      TState,
      TEvent,
      TPayload,
      TChunks,
      TNudges,
      true
    >,
  ): StreamBundlePrimitive<TEvent, TPayload, TChunks, TNudges>;
}

/**
 * Adds replay support for outgoing messages.
 *
 * Server-level `.replay(...)` cascades into channels by default — every
 * outgoing message is captured, including channel-scoped traffic. A channel
 * can override the cascade by calling `.replay({ ... })` inside its
 * sub-builder, or opt out entirely with `.replay(false)`.
 */
export interface ReplayBuilderMethods<TBuilder, TState extends ScopeStateShape> {
  /** Enable history replay with default options. */
  replay(): ReplayBuilder<TBuilder, TState, 'history'>;

  /** Enable a specific replay mode, such as history replay or live replay. */
  replay<M extends ReplayType>(type: M): ReplayBuilder<TBuilder, TState, M>;

  /** Configure history replay with the replay builder before returning to the parent builder. */
  replay(
    callback: (builder: ReplayBuilder<TBuilder, TState, 'history'>) => ReplayBuilder<any, any, any>,
  ): TBuilder;

  /** Configure a specific replay mode with the replay builder before returning to the parent builder. */
  replay<M extends ReplayType>(
    type: M,
    callback: (builder: ReplayBuilder<TBuilder, TState, M>) => ReplayBuilder<any, any, any>,
  ): TBuilder;

  /**
   * Opt this scope out of replay entirely. Use inside `.channel(...)` when a
   * specific channel should not have its outgoing messages stored or replayed
   * by either the channel-scoped or the cascading server-level replay.
   */
  replay(disabled: false): TBuilder;
}

/** Adds custom replay storage hooks. */
export interface ReplayCustomBuilderMethods<TBuilder, TState extends ScopeStateShape> {
  /** Configure custom replay handling with default options. */
  replayCustom(): ReplayCustomBuilder<TBuilder, TState>;

  /**
   * Configure custom replay handling with the custom replay builder.
   *
   * Use this when replay storage should live outside the built-in history
   * provider, for example in adapter-specific storage or an app-managed log.
   */
  replayCustom(
    callback: (builder: ReplayCustomBuilder<TBuilder, TState>) => ReplayCustomBuilder<any, any>,
  ): TBuilder;
}

type MethodType<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
  M extends string,
> = M extends 'ack'
  ? Kind extends 'server'
    ? AckBuilderMethods<TState, TFeatures, 'server'>['ack']
    : never
  : M extends 'dedup'
    ? Kind extends 'server'
      ? DedupBuilderMethods<TState, TFeatures, 'server'>['dedup']
      : never
    : M extends 'heartbeat'
      ? Kind extends 'server'
        ? HeartbeatBuilderMethods<TState, TFeatures, 'server'>['heartbeat']
        : never
      : M extends 'sequence'
        ? Kind extends 'server'
          ? SequenceBuilderMethods<TState, TFeatures, 'server'>['sequence']
          : never
        : M extends 'hibernation'
          ? Kind extends 'server'
            ? HibernationBuilderMethods<TState, TFeatures, 'server'>['hibernation']
            : never
          : M extends 'errors'
            ? ErrorBuilderMethods<TState, TFeatures, Kind>['errors']
            : M extends keyof LifecycleBuilderMethods<TState, TFeatures, Kind>
              ? LifecycleBuilderMethods<TState, TFeatures, Kind>[M]
              : M extends 'intercept'
                ? InterceptBuilderMethods<
                    BuilderResult<TState, TFeatures, Kind>,
                    TState
                  >['intercept']
                : M extends 'scheduled'
                  ? ScheduledBuilderMethods<TState, TFeatures, Kind>['scheduled']
                  : M extends 'channel'
                    ? ChannelBuilderMethods<TState, TFeatures>['channel']
                    : M extends 'namespace'
                      ? NamespaceBuilderMethods<TState, TFeatures>['namespace']
                      : M extends 'request'
                        ? RequestBuilderMethods<TState, TFeatures, Kind>['request']
                        : M extends 'stream'
                          ? Kind extends 'server'
                            ? StreamBuilderMethods<TState, TFeatures, 'server'>['stream']
                            : never
                          : M extends 'replay'
                            ? Kind extends 'server'
                              ? ReplayBuilderMethods<
                                  BuilderResult<
                                    NextState<TState, ReplayPrimitive>,
                                    TFeatures,
                                    'server'
                                  >,
                                  TState
                                >['replay']
                              : never
                            : M extends 'replayCustom'
                              ? Kind extends 'server'
                                ? ReplayCustomBuilderMethods<
                                    BuilderResult<
                                      NextState<TState, CustomReplayPrimitive<'top'>>,
                                      TFeatures,
                                      'server'
                                    >,
                                    TState
                                  >['replayCustom']
                                : never
                              : never;

/**
 * Feature methods available on server and group builders.
 *
 * Methods are declared on named interfaces, then selected by feature flag.
 * That gives IDEs stable symbols for hover docs without paying the cost of
 * intersecting every possible feature method into every builder instance.
 */
export type FeatureMethods<TState extends ScopeStateShape, TFeatures, Kind extends BuilderKind> = {
  [M in ActiveMethodKeys<TFeatures>]: MethodType<TState, TFeatures, Kind, M>;
};

/** Adds request/response handlers inside a namespace. */
export interface NamespaceRequestBuilderMethods<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TName extends string,
  TFeatures,
> {
  /**
   * Register an incoming request handler inside this namespace.
   *
   * The request belongs to the namespace contract, so clients call it through
   * that namespace. The payload is validated by the event contract, and
   * `ctx.respond(...)` validates the response against `responseSchema`.
   */
  request<TEvent extends string, TPayload, TResponse>(
    eventContract: EventContract<TEvent, TPayload>,
    responseSchema: Validator<TResponse>,
    handler: (
      ctx: HandlerCtxFromState<TState> & RespondMethod<TResponse>,
      payload: TPayload,
    ) => void | Promise<void>,
  ): NamespaceBuilderFull<
    TParentState,
    NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>,
    TName,
    TFeatures
  >;
}

/** Adds streaming handlers inside a namespace. */
export interface NamespaceStreamBuilderMethods<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TName extends string,
  TFeatures,
> {
  /**
   * Register a streaming handler inside this namespace.
   *
   * The stream belongs to the namespace contract. Call `.chunk(schema)` inside
   * the callback before `.generate(...)`, and add nudges or broadcast behavior
   * there when the stream needs runtime controls.
   */
  stream<
    TEvent extends string,
    TPayload,
    TChunks,
    TNudges extends readonly NudgeDeclaration[] = readonly [],
  >(
    eventContract: EventContract<TEvent, TPayload>,
    callback: (
      builder: StreamBuilder<
        NamespaceBuilderFull<TParentState, TState, TName, TFeatures>,
        TState,
        TEvent,
        TPayload
      >,
    ) => StreamBuilder<
      NamespaceBuilderFull<TParentState, TState, TName, TFeatures>,
      TState,
      TEvent,
      TPayload,
      TChunks,
      TNudges,
      true
    >,
  ): NamespaceBuilderFull<
    TParentState,
    StateWithStream<TState, TEvent, TPayload, TChunks, TNudges>,
    TName,
    TFeatures
  >;
}

/** Feature methods available inside a namespace builder scope. */
export type NamespaceFeatureMethods<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TName extends string,
  TFeatures,
> = {
  [M in ActiveNamespaceMethodKeys<TFeatures>]: NamespaceMethodType<
    TParentState,
    TState,
    TName,
    TFeatures,
    M
  >;
};

type NamespaceMethodFeatureMap = {
  intercept: 'intercept';
  request: 'requests';
  stream: 'streams';
};

type ActiveNamespaceMethodKeys<TFeatures> = {
  [M in keyof NamespaceMethodFeatureMap]: NamespaceMethodFeatureMap[M] extends keyof TFeatures
    ? M
    : never;
}[keyof NamespaceMethodFeatureMap];

type NamespaceMethodType<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TName extends string,
  TFeatures,
  M extends string,
> = M extends 'intercept'
  ? InterceptBuilderMethods<
      NamespaceBuilderFull<TParentState, TState, TName, TFeatures>,
      TState
    >['intercept']
  : M extends 'request'
    ? NamespaceRequestBuilderMethods<TParentState, TState, TName, TFeatures>['request']
    : M extends 'stream'
      ? NamespaceStreamBuilderMethods<TParentState, TState, TName, TFeatures>['stream']
      : never;

// ─── Channel feature methods ──────────────────────────────

/** Adds request/response handlers inside a channel. */
export interface ChannelRequestBuilderMethods<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TPattern extends ChannelPattern,
  TFeatures,
> {
  /**
   * Register an incoming request handler inside this channel.
   *
   * The request is available only to clients subscribed to the channel. The
   * payload is validated by the event contract, and `ctx.respond(...)`
   * validates the response payload before it is sent back.
   */
  request<TEvent extends string, TPayload, TResponse>(
    eventContract: EventContract<TEvent, TPayload>,
    responseSchema: Validator<TResponse>,
    handler: (
      ctx: HandlerCtxFromState<TState> & RespondMethod<TResponse>,
      payload: TPayload,
    ) => void | Promise<void>,
  ): ChannelBuilderFull<
    TParentState,
    NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>,
    TPattern,
    TFeatures
  >;
}

/** Adds streaming handlers inside a channel. */
export interface ChannelStreamBuilderMethods<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TPattern extends ChannelPattern,
  TFeatures,
> {
  /**
   * Register a streaming handler inside this channel.
   *
   * The stream is scoped to channel members. Call `.chunk(schema)` before
   * `.generate(...)`; optional nudges and broadcast behavior are configured on
   * the stream builder returned inside the callback.
   */
  stream<
    TEvent extends string,
    TPayload,
    TChunks,
    TNudges extends readonly NudgeDeclaration[] = readonly [],
  >(
    eventContract: EventContract<TEvent, TPayload>,
    callback: (
      builder: StreamBuilder<
        ChannelBuilderFull<TParentState, TState, TPattern, TFeatures>,
        TState,
        TEvent,
        TPayload
      >,
    ) => StreamBuilder<
      ChannelBuilderFull<TParentState, TState, TPattern, TFeatures>,
      TState,
      TEvent,
      TPayload,
      TChunks,
      TNudges,
      true
    >,
  ): ChannelBuilderFull<
    TParentState,
    StateWithStream<TState, TEvent, TPayload, TChunks, TNudges>,
    TPattern,
    TFeatures
  >;
}

/** Feature methods available inside a channel builder scope. */
export type ChannelFeatureMethods<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TPattern extends ChannelPattern,
  TFeatures,
> = {
  [M in ActiveChannelMethodKeys<TFeatures>]: ChannelMethodType<
    TParentState,
    TState,
    TPattern,
    TFeatures,
    M
  >;
};

type ChannelMethodFeatureMap = {
  intercept: 'intercept';
  request: 'requests';
  stream: 'streams';
  replay: 'replay';
  replayCustom: 'replayCustom';
};

type ActiveChannelMethodKeys<TFeatures> = {
  [M in keyof ChannelMethodFeatureMap]: ChannelMethodFeatureMap[M] extends keyof TFeatures
    ? M
    : never;
}[keyof ChannelMethodFeatureMap];

type ChannelMethodType<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TPattern extends ChannelPattern,
  TFeatures,
  M extends string,
> = M extends 'intercept'
  ? InterceptBuilderMethods<
      ChannelBuilderFull<TParentState, TState, TPattern, TFeatures>,
      TState
    >['intercept']
  : M extends 'request'
    ? ChannelRequestBuilderMethods<TParentState, TState, TPattern, TFeatures>['request']
    : M extends 'stream'
      ? ChannelStreamBuilderMethods<TParentState, TState, TPattern, TFeatures>['stream']
      : M extends 'replay'
        ? ReplayBuilderMethods<
            ChannelBuilderFull<
              TParentState,
              NextState<TState, ReplayPrimitive>,
              TPattern,
              TFeatures
            >,
            TState
          >['replay']
        : M extends 'replayCustom'
          ? ReplayCustomBuilderMethods<
              ChannelBuilderFull<
                TParentState,
                NextState<TState, CustomReplayPrimitive<'channel'>>,
                TPattern,
                TFeatures
              >,
              TState
            >['replayCustom']
          : never;
