/* oxlint-disable @typescript-eslint/no-explicit-any */

/**
 * Type-level wiring for the fluent server builder.
 *
 * This file describes what each builder can do after a feature is enabled.
 * In practice, each primitive updates the builder state, and these helpers
 * describe how that update changes the available fluent methods and `ctx`.
 */
import type { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
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
import type {
  ScheduledHandler,
  ScheduledOptions,
  ScheduledPrimitive,
} from '~/scheduled/scheduled.ts';
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
  readonly scheduledTaskIds: TState['scheduledTaskIds'];
  readonly env: TState['env'];
};

type BuilderResult<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
> = FullBuilder<TState, TFeatures, Kind>;

type InterceptMethod<TBuilder, TState extends ScopeStateShape> = ((
  handler: (
    ctx: HandlerCtxFromState<TState>,
    message: InterceptMessage,
  ) => InterceptMessage | void | Promise<InterceptMessage | void>,
) => TBuilder) &
  (<TEvent extends string & keyof TState['contract']['outgoing']>(
    event: TEvent,
    handler: (
      ctx: HandlerCtxFromState<TState>,
      payload: TState['contract']['outgoing'][TEvent],
    ) =>
      | TState['contract']['outgoing'][TEvent]
      | void
      | Promise<TState['contract']['outgoing'][TEvent] | void>,
  ) => TBuilder) &
  (<TEvent extends string, TPayload>(
    event: EventContract<TEvent, TPayload>,
    handler: (
      ctx: HandlerCtxFromState<TState>,
      payload: TPayload,
    ) => TPayload | void | Promise<TPayload | void>,
  ) => TBuilder);

type ReplayMethod<TBuilder, TState extends ScopeStateShape> = (() => ReplayBuilder<
  TBuilder,
  TState,
  'history'
>) &
  (<M extends ReplayType>(type: M) => ReplayBuilder<TBuilder, TState, M>) &
  ((
    callback: (builder: ReplayBuilder<TBuilder, TState, 'history'>) => ReplayBuilder<any, any, any>,
  ) => TBuilder) &
  (<M extends ReplayType>(
    type: M,
    callback: (builder: ReplayBuilder<TBuilder, TState, M>) => ReplayBuilder<any, any, any>,
  ) => TBuilder);

type ReplayCustomMethod<
  TBuilder,
  TState extends ScopeStateShape,
  TScope extends 'top' | 'channel',
> = (() => ReplayCustomBuilder<TBuilder, TState>) &
  ((
    callback: (builder: ReplayCustomBuilder<TBuilder, TState>) => ReplayCustomBuilder<any, any>,
  ) => TBuilder) &
  (TScope extends 'top' | 'channel' ? {} : never);

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
  TParentState['scheduledTaskIds'],
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
  TParentState['scheduledTaskIds'],
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
  readonly scheduledTaskIds: TState['scheduledTaskIds'];
  readonly env: TState['env'];
};

/** The builder state shape after registering a stream endpoint. */
export type { StateWithStream };

// ════════════════════════════════════════════════════════════
// Feature method system — mapped type approach
//
// Uses a mapped type instead of a 15-member conditional
// intersection to avoid exponential type expansion in tsc.
// ════════════════════════════════════════════════════════════

// ─── Method → feature requirement mapping ──────────────────

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

// ─── Active method keys (only methods whose feature is in TFeatures) ───

type ActiveMethodKeys<TFeatures> = {
  [M in keyof MethodFeatureMap]: MethodFeatureMap[M] extends keyof TFeatures ? M : never;
}[keyof MethodFeatureMap];

// ─── Per-method type signatures ────────────────────────────
// Each method gets its full signature. Overloaded methods use
// intersections of function types.

type MethodType<
  TState extends ScopeStateShape,
  TFeatures,
  Kind extends BuilderKind,
  M extends string,
> =
  // ─────── Section: ack ───────
  M extends 'ack'
    ? () => FullBuilder<NextState<TState, AckPrimitive>, TFeatures, Kind>
    : // ─────── Section: dedup ───────
      M extends 'dedup'
      ? () => FullBuilder<NextState<TState, DedupPrimitive>, TFeatures, Kind>
      : // ─────── Section: heartbeat ───────
        M extends 'heartbeat'
        ? (
            options: HeartbeatOptions,
          ) => FullBuilder<NextState<TState, HeartbeatPrimitive>, TFeatures, Kind>
        : // ─────── Section: sequence ───────
          M extends 'sequence'
          ? (
              options?: SequenceOptions,
            ) => FullBuilder<NextState<TState, SequencePrimitive>, TFeatures, Kind>
          : // ─────── Section: hibernation ───────
            M extends 'hibernation'
            ? (
                enabled?: boolean,
              ) => FullBuilder<NextState<TState, HibernationPrimitive>, TFeatures, Kind>
            : // ─────── Section: errors ───────
              M extends 'errors'
              ? <const TDefs extends readonly [AnyErrorDef, ...AnyErrorDef[]]>(
                  ...defs: TDefs
                ) => FullBuilder<NextState<TState, ErrorsPrimitive<TDefs>>, TFeatures, Kind>
              : // ─────── Section: onInit ───────
                M extends 'onInit'
                ? (
                    handler: (ctx: InitContext) => void | Promise<void>,
                  ) => FullBuilder<TState, TFeatures, Kind>
                : // ─────── Section: onConnect ───────
                  M extends 'onConnect'
                  ? (
                      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
                    ) => FullBuilder<TState, TFeatures, Kind>
                  : // ─────── Section: onDisconnect ───────
                    M extends 'onDisconnect'
                    ? (
                        handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
                      ) => FullBuilder<TState, TFeatures, Kind>
                    : // ─────── Section: onShutdown ───────
                      M extends 'onShutdown'
                      ? (
                          handler: (ctx: ShutdownContext) => void | Promise<void>,
                        ) => FullBuilder<TState, TFeatures, Kind>
                      : // ─────── Section: onError ───────
                        M extends 'onError'
                        ? (
                            handler: (
                              ctx: HandlerCtxFromState<TState>,
                              error: unknown,
                              event?: string,
                            ) => void | Promise<void>,
                          ) => FullBuilder<TState, TFeatures, Kind>
                        : // ─────── Section: onUpgrade ───────
                          M extends 'onUpgrade'
                          ? <TMeta extends Record<string, unknown> = Record<string, unknown>>(
                              handler: (
                                request: Request,
                              ) =>
                                | { meta?: TMeta; tags?: readonly string[] }
                                | Promise<{ meta?: TMeta; tags?: readonly string[] }>,
                            ) => FullBuilder<StateWithMeta<TState, TMeta>, TFeatures, Kind>
                          : // ─────── Section: onBinary ───────
                            M extends 'onBinary'
                            ? (
                                handler: (
                                  ctx: HandlerCtxFromState<TState>,
                                  data: ArrayBuffer,
                                ) => void | Promise<void>,
                              ) => FullBuilder<TState, TFeatures, Kind>
                            : // ─────── Section: onValidationError ───────
                              M extends 'onValidationError'
                              ? (
                                  handler: (
                                    ctx: HandlerCtxFromState<TState>,
                                    event: string,
                                    validationError: unknown,
                                  ) => void | Promise<void>,
                                ) => FullBuilder<TState, TFeatures, Kind>
                              : // ─────── Section: intercept ───────
                                M extends 'intercept'
                                ? InterceptMethod<BuilderResult<TState, TFeatures, Kind>, TState>
                                : // ─────── Section: scheduled ───────
                                  M extends 'scheduled'
                                  ? (<TTaskId extends string, TData = unknown>(
                                      taskId: TTaskId,
                                      handler: ScheduledHandler<TaskContext, TData>,
                                      options?: ScheduledOptions<TData>,
                                    ) => FullBuilder<
                                      NextState<
                                        TState,
                                        ScheduledPrimitive<TTaskId, TData, TaskContext>
                                      >,
                                      TFeatures,
                                      Kind
                                    >) &
                                      (<TTaskId extends string, TData>(
                                        taskId: TTaskId,
                                        dataSchema: Validator<TData>,
                                        options?: ScheduledOptions<TData>,
                                      ) => FullBuilder<
                                        NextState<TState, ScheduledPrimitive<TTaskId, TData>>,
                                        TFeatures,
                                        Kind
                                      >)
                                  : // ─────── Section: channel ───────
                                    M extends 'channel'
                                    ? <
                                        TPattern extends ChannelPattern,
                                        TChannelState extends ScopeStateShape,
                                      >(
                                        pattern: TPattern,
                                        callback: (
                                          builder: ChannelBuilderFull<
                                            TState,
                                            ChannelState<TState>,
                                            TPattern,
                                            TFeatures
                                          >,
                                        ) => ChannelBuilderFull<
                                          TState,
                                          TChannelState,
                                          TPattern,
                                          TFeatures
                                        >,
                                      ) => ChannelPrimitive<
                                        TPattern,
                                        readonly ChannelChild[],
                                        ChannelNameFromPattern<TPattern>,
                                        ChannelContract<TChannelState>
                                      >
                                    : // ─────── Section: namespace ───────
                                      M extends 'namespace'
                                      ? <TName extends string, TNsState extends ScopeStateShape>(
                                          name: TName,
                                          callback: (
                                            builder: NamespaceBuilderFull<
                                              TState,
                                              NamespaceState<TState>,
                                              TName,
                                              TFeatures
                                            >,
                                          ) => NamespaceBuilderFull<
                                            TState,
                                            TNsState,
                                            TName,
                                            TFeatures
                                          >,
                                        ) => NamespacePrimitive<
                                          TName,
                                          readonly NamespaceChild[],
                                          TName,
                                          NamespaceContract<TNsState>
                                        >
                                      : // ─────── Section: request ───────
                                        M extends 'request'
                                        ? <TEvent extends string, TPayload, TResponse>(
                                            eventContract: EventContract<TEvent, TPayload>,
                                            responseSchema: Validator<TResponse>,
                                            handler: (
                                              ctx: HandlerCtxFromState<TState> &
                                                RespondMethod<TResponse>,
                                              payload: TPayload,
                                            ) => void | Promise<void>,
                                          ) => FullBuilder<
                                            NextState<
                                              TState,
                                              RequestPrimitive<TEvent, TPayload, TResponse>
                                            >,
                                            TFeatures,
                                            Kind
                                          >
                                        : // ─────── Section: stream ───────
                                          M extends 'stream'
                                          ? <
                                              TEvent extends string,
                                              TPayload,
                                              TChunks,
                                              TNudges extends readonly NudgeDeclaration[] =
                                                readonly [],
                                            >(
                                              eventContract: EventContract<TEvent, TPayload>,
                                              chunkSchema: Validator<TChunks>,
                                              callback: (
                                                builder: StreamBuilder<
                                                  FullBuilder<TState, TFeatures, Kind>,
                                                  TState,
                                                  TEvent,
                                                  TPayload,
                                                  TChunks
                                                >,
                                              ) => StreamBuilder<
                                                FullBuilder<TState, TFeatures, Kind>,
                                                TState,
                                                TEvent,
                                                TPayload,
                                                TChunks,
                                                TNudges
                                              >,
                                            ) => FullBuilder<
                                              StateWithStream<
                                                TState,
                                                TEvent,
                                                TPayload,
                                                TChunks,
                                                TNudges
                                              >,
                                              TFeatures,
                                              Kind
                                            >
                                          : // ─────── Section: replay ───────
                                            M extends 'replay'
                                            ? ReplayMethod<
                                                BuilderResult<
                                                  NextState<TState, ReplayPrimitive>,
                                                  TFeatures,
                                                  Kind
                                                >,
                                                TState
                                              >
                                            : // ─────── Section: replayCustom ───────
                                              M extends 'replayCustom'
                                              ? ReplayCustomMethod<
                                                  BuilderResult<
                                                    NextState<TState, CustomReplayPrimitive<'top'>>,
                                                    TFeatures,
                                                    Kind
                                                  >,
                                                  TState,
                                                  'top'
                                                >
                                              : never;

// ─── Master feature methods type (mapped, not intersected) ─

/**
 * Mapped type that resolves which feature methods are available on a builder,
 * based on which `with*` wrappers have been applied (`TFeatures` flags).
 */
export type FeatureMethods<TState extends ScopeStateShape, TFeatures, Kind extends BuilderKind> = {
  [M in ActiveMethodKeys<TFeatures>]: MethodType<TState, TFeatures, Kind, M>;
};

// ─── Namespace feature methods ─────────────────────────────

type NsMethodFeatureMap = {
  intercept: 'intercept';
  request: 'requests';
  stream: 'streams';
};

type ActiveNsMethodKeys<TFeatures> = {
  [M in keyof NsMethodFeatureMap]: NsMethodFeatureMap[M] extends keyof TFeatures ? M : never;
}[keyof NsMethodFeatureMap];

type NsMethodType<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TName extends string,
  TFeatures,
  M extends string,
> = M extends 'intercept'
  ? InterceptMethod<NamespaceBuilderFull<TParentState, TState, TName, TFeatures>, TState>
  : M extends 'request'
    ? <TEvent extends string, TPayload, TResponse>(
        eventContract: EventContract<TEvent, TPayload>,
        responseSchema: Validator<TResponse>,
        handler: (
          ctx: HandlerCtxFromState<TState> & RespondMethod<TResponse>,
          payload: TPayload,
        ) => void | Promise<void>,
      ) => NamespaceBuilderFull<
        TParentState,
        NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>,
        TName,
        TFeatures
      >
    : M extends 'stream'
      ? <
          TEvent extends string,
          TPayload,
          TChunks,
          TNudges extends readonly NudgeDeclaration[] = readonly [],
        >(
          eventContract: EventContract<TEvent, TPayload>,
          chunkSchema: Validator<TChunks>,
          callback: (
            builder: StreamBuilder<
              NamespaceBuilderFull<TParentState, TState, TName, TFeatures>,
              TState,
              TEvent,
              TPayload,
              TChunks
            >,
          ) => StreamBuilder<
            NamespaceBuilderFull<TParentState, TState, TName, TFeatures>,
            TState,
            TEvent,
            TPayload,
            TChunks,
            TNudges
          >,
        ) => NamespaceBuilderFull<
          TParentState,
          StateWithStream<TState, TEvent, TPayload, TChunks, TNudges>,
          TName,
          TFeatures
        >
      : never;

/** Feature methods available inside a namespace builder scope. */
export type NamespaceFeatureMethods<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TName extends string,
  TFeatures,
> = {
  [M in ActiveNsMethodKeys<TFeatures>]: NsMethodType<TParentState, TState, TName, TFeatures, M>;
};

// ─── Channel feature methods ──────────────────────────────

type ChMethodFeatureMap = {
  intercept: 'intercept';
  request: 'requests';
  stream: 'streams';
  replay: 'replay';
  replayCustom: 'replayCustom';
};

type ActiveChMethodKeys<TFeatures> = {
  [M in keyof ChMethodFeatureMap]: ChMethodFeatureMap[M] extends keyof TFeatures ? M : never;
}[keyof ChMethodFeatureMap];

type ChMethodType<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TPattern extends ChannelPattern,
  TFeatures,
  M extends string,
> = M extends 'intercept'
  ? InterceptMethod<ChannelBuilderFull<TParentState, TState, TPattern, TFeatures>, TState>
  : M extends 'request'
    ? <TEvent extends string, TPayload, TResponse>(
        eventContract: EventContract<TEvent, TPayload>,
        responseSchema: Validator<TResponse>,
        handler: (
          ctx: HandlerCtxFromState<TState> & RespondMethod<TResponse>,
          payload: TPayload,
        ) => void | Promise<void>,
      ) => ChannelBuilderFull<
        TParentState,
        NextState<TState, RequestPrimitive<TEvent, TPayload, TResponse>>,
        TPattern,
        TFeatures
      >
    : M extends 'stream'
      ? <
          TEvent extends string,
          TPayload,
          TChunks,
          TNudges extends readonly NudgeDeclaration[] = readonly [],
        >(
          eventContract: EventContract<TEvent, TPayload>,
          chunkSchema: Validator<TChunks>,
          callback: (
            builder: StreamBuilder<
              ChannelBuilderFull<TParentState, TState, TPattern, TFeatures>,
              TState,
              TEvent,
              TPayload,
              TChunks
            >,
          ) => StreamBuilder<
            ChannelBuilderFull<TParentState, TState, TPattern, TFeatures>,
            TState,
            TEvent,
            TPayload,
            TChunks,
            TNudges
          >,
        ) => ChannelBuilderFull<
          TParentState,
          StateWithStream<TState, TEvent, TPayload, TChunks, TNudges>,
          TPattern,
          TFeatures
        >
      : M extends 'replay'
        ? ReplayMethod<
            ChannelBuilderFull<
              TParentState,
              NextState<TState, ReplayPrimitive>,
              TPattern,
              TFeatures
            >,
            TState
          >
        : M extends 'replayCustom'
          ? ReplayCustomMethod<
              ChannelBuilderFull<
                TParentState,
                NextState<TState, CustomReplayPrimitive<'channel'>>,
                TPattern,
                TFeatures
              >,
              TState,
              'channel'
            >
          : never;

/** Feature methods available inside a channel builder scope. */
export type ChannelFeatureMethods<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TPattern extends ChannelPattern,
  TFeatures,
> = {
  [M in ActiveChMethodKeys<TFeatures>]: ChMethodType<TParentState, TState, TPattern, TFeatures, M>;
};
