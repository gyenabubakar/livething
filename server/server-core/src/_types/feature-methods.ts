/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { GroupBuilder, ServerBuilder } from '~/_builder/server-builder.ts';
import type {
  HandlerCtxFromState,
  MergeRecords,
  NextState,
  ScopeState,
  ScopeStateShape,
} from '~/_types/scope-state.ts';
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

export interface BuilderInternals {
  readonly _primitives: Primitive[];
  readonly _featureApplicators: FeatureApplicator[];
}

export type FeatureApplicator = (
  target: BuilderInternals,
  kind: 'server' | 'group' | 'namespace',
) => void;

/* oxlint-disable-next-line @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

export function applyFeature(
  builder: BuilderInternals,
  kinds: readonly string[],
  install: (target: Obj) => void,
): void {
  install(builder as Obj);
  builder._featureApplicators.push((target, kind) => {
    if (kinds.includes(kind)) install(target as Obj);
  });
}

// ─── Builder kind ──────────────────────────────────────────

export type BuilderKind = 'server' | 'group';

// ─── Full builder type aliases ─────────────────────────────

export type ServerBuilderFull<TState extends ScopeStateShape, TFeatures> = ServerBuilder<
  TState,
  TFeatures
> &
  FeatureMethods<TState, TFeatures, 'server'>;

export type GroupBuilderFull<TState extends ScopeStateShape, TFeatures> = GroupBuilder<
  TState,
  TFeatures
> &
  FeatureMethods<TState, TFeatures, 'group'>;

export type NamespaceBuilderFull<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TName extends string,
  TFeatures,
> = NamespaceBuilder<TParentState, TState, TName, TFeatures> &
  NamespaceFeatureMethods<TParentState, TState, TName, TFeatures>;

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
  // ── Infrastructure ───────────────────────────────────
  M extends 'ack'
    ? () => FullBuilder<NextState<TState, AckPrimitive>, TFeatures, Kind>
    : M extends 'dedup'
      ? () => FullBuilder<NextState<TState, DedupPrimitive>, TFeatures, Kind>
      : M extends 'heartbeat'
        ? (
            options: HeartbeatOptions,
          ) => FullBuilder<NextState<TState, HeartbeatPrimitive>, TFeatures, Kind>
        : M extends 'sequence'
          ? (
              options?: SequenceOptions,
            ) => FullBuilder<NextState<TState, SequencePrimitive>, TFeatures, Kind>
          : M extends 'hibernation'
            ? (
                enabled?: boolean,
              ) => FullBuilder<NextState<TState, HibernationPrimitive>, TFeatures, Kind>
            : // ── Contract ─────────────────────────────────────────
              M extends 'errors'
              ? <const TDefs extends readonly [AnyErrorDef, ...AnyErrorDef[]]>(
                  ...defs: TDefs
                ) => FullBuilder<NextState<TState, ErrorsPrimitive<TDefs>>, TFeatures, Kind>
              : // ── Lifecycle ────────────────────────────────────────
                M extends 'onInit'
                ? (
                    handler: (ctx: InitContext) => void | Promise<void>,
                  ) => FullBuilder<TState, TFeatures, Kind>
                : M extends 'onConnect'
                  ? (
                      handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
                    ) => FullBuilder<TState, TFeatures, Kind>
                  : M extends 'onDisconnect'
                    ? (
                        handler: (ctx: HandlerCtxFromState<TState>) => void | Promise<void>,
                      ) => FullBuilder<TState, TFeatures, Kind>
                    : M extends 'onShutdown'
                      ? (
                          handler: (ctx: ShutdownContext) => void | Promise<void>,
                        ) => FullBuilder<TState, TFeatures, Kind>
                      : M extends 'onError'
                        ? (
                            handler: (
                              ctx: HandlerCtxFromState<TState>,
                              error: unknown,
                              event?: string,
                            ) => void | Promise<void>,
                          ) => FullBuilder<TState, TFeatures, Kind>
                        : M extends 'onUpgrade'
                          ? <TMeta extends Record<string, unknown> = Record<string, unknown>>(
                              handler: (
                                request: Request,
                              ) =>
                                | { meta?: TMeta; tags?: readonly string[] }
                                | Promise<{ meta?: TMeta; tags?: readonly string[] }>,
                            ) => FullBuilder<StateWithMeta<TState, TMeta>, TFeatures, Kind>
                          : M extends 'onBinary'
                            ? (
                                handler: (
                                  ctx: HandlerCtxFromState<TState>,
                                  data: ArrayBuffer,
                                ) => void | Promise<void>,
                              ) => FullBuilder<TState, TFeatures, Kind>
                            : M extends 'onValidationError'
                              ? (
                                  handler: (
                                    ctx: HandlerCtxFromState<TState>,
                                    event: string,
                                    validationError: unknown,
                                  ) => void | Promise<void>,
                                ) => FullBuilder<TState, TFeatures, Kind>
                              : // ── Intercept (2 overloads) ──────────────────────────
                                M extends 'intercept'
                                ? ((
                                    handler: (
                                      ctx: HandlerCtxFromState<TState>,
                                      message: InterceptMessage,
                                    ) => InterceptMessage | void | Promise<InterceptMessage | void>,
                                  ) => FullBuilder<TState, TFeatures, Kind>) &
                                    (<TEvent extends string>(
                                      event: TEvent,
                                      handler: (
                                        ctx: HandlerCtxFromState<TState>,
                                        payload: any,
                                      ) => any,
                                    ) => FullBuilder<TState, TFeatures, Kind>)
                                : // ── Scheduled (2 overloads) ──────────────────────────
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
                                  : // ── Channels ─────────────────────────────────────────
                                    M extends 'channel'
                                    ? <
                                        TPattern extends ChannelPattern,
                                        TChannelState extends ScopeStateShape,
                                      >(
                                        pattern: TPattern,
                                        callback: (
                                          builder: ChannelBuilder<
                                            TState,
                                            ChannelState<TState>,
                                            TPattern
                                          >,
                                        ) => ChannelBuilder<TState, TChannelState, TPattern>,
                                      ) => ChannelPrimitive<
                                        TPattern,
                                        readonly ChannelChild[],
                                        ChannelNameFromPattern<TPattern>,
                                        ChannelContract<TChannelState>
                                      >
                                    : // ── Namespaces ───────────────────────────────────────
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
                                      : // ── Requests ─────────────────────────────────────────
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
                                        : // ── Streams (3 overloads) ────────────────────────────
                                          M extends 'stream'
                                          ? (<TEvent extends string, TPayload, TChunks>(
                                              eventContract: EventContract<TEvent, TPayload>,
                                              chunkSchema: Validator<TChunks>,
                                              options?: { broadcast?: boolean },
                                            ) => StreamBuilder<
                                              FullBuilder<TState, TFeatures, Kind>,
                                              TState,
                                              TEvent,
                                              TPayload,
                                              TChunks
                                            >) &
                                              (<
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
                                              >) &
                                              (<
                                                TEvent extends string,
                                                TPayload,
                                                TChunks,
                                                TNudges extends readonly NudgeDeclaration[] =
                                                  readonly [],
                                              >(
                                                eventContract: EventContract<TEvent, TPayload>,
                                                chunkSchema: Validator<TChunks>,
                                                options: { broadcast?: boolean },
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
                                              >)
                                          : // ── Replay (3 overloads) ─────────────────────────────
                                            M extends 'replay'
                                            ? ((
                                                type?: ReplayType,
                                              ) => ReplayBuilder<
                                                FullBuilder<
                                                  NextState<TState, ReplayPrimitive>,
                                                  TFeatures,
                                                  Kind
                                                >,
                                                TState
                                              >) &
                                                ((
                                                  callback: (
                                                    builder: ReplayBuilder<
                                                      FullBuilder<
                                                        NextState<TState, ReplayPrimitive>,
                                                        TFeatures,
                                                        Kind
                                                      >,
                                                      TState
                                                    >,
                                                  ) => ReplayBuilder<any, any>,
                                                ) => FullBuilder<
                                                  NextState<TState, ReplayPrimitive>,
                                                  TFeatures,
                                                  Kind
                                                >) &
                                                ((
                                                  type: ReplayType,
                                                  callback: (
                                                    builder: ReplayBuilder<
                                                      FullBuilder<
                                                        NextState<TState, ReplayPrimitive>,
                                                        TFeatures,
                                                        Kind
                                                      >,
                                                      TState
                                                    >,
                                                  ) => ReplayBuilder<any, any>,
                                                ) => FullBuilder<
                                                  NextState<TState, ReplayPrimitive>,
                                                  TFeatures,
                                                  Kind
                                                >)
                                            : // ── Replay Custom (2 overloads) ──────────────────────
                                              M extends 'replayCustom'
                                              ? (() => ReplayCustomBuilder<
                                                  FullBuilder<
                                                    NextState<TState, CustomReplayPrimitive<'top'>>,
                                                    TFeatures,
                                                    Kind
                                                  >,
                                                  TState
                                                >) &
                                                  ((
                                                    callback: (
                                                      builder: ReplayCustomBuilder<
                                                        FullBuilder<
                                                          NextState<
                                                            TState,
                                                            CustomReplayPrimitive<'top'>
                                                          >,
                                                          TFeatures,
                                                          Kind
                                                        >,
                                                        TState
                                                      >,
                                                    ) => ReplayCustomBuilder<any, any>,
                                                  ) => FullBuilder<
                                                    NextState<TState, CustomReplayPrimitive<'top'>>,
                                                    TFeatures,
                                                    Kind
                                                  >)
                                              : never;

// ─── Master feature methods type (mapped, not intersected) ─

export type FeatureMethods<TState extends ScopeStateShape, TFeatures, Kind extends BuilderKind> = {
  [M in ActiveMethodKeys<TFeatures>]: MethodType<TState, TFeatures, Kind, M>;
};

// ─── Namespace feature methods ─────────────────────────────

type NsMethodFeatureMap = {
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
> = M extends 'request'
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
    ? (<TEvent extends string, TPayload, TChunks>(
        eventContract: EventContract<TEvent, TPayload>,
        chunkSchema: Validator<TChunks>,
        options?: { broadcast?: boolean },
      ) => StreamBuilder<
        NamespaceBuilderFull<TParentState, TState, TName, TFeatures>,
        TState,
        TEvent,
        TPayload,
        TChunks
      >) &
        (<
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
        >)
    : never;

export type NamespaceFeatureMethods<
  TParentState extends ScopeStateShape,
  TState extends ScopeStateShape,
  TName extends string,
  TFeatures,
> = {
  [M in ActiveNsMethodKeys<TFeatures>]: NsMethodType<TParentState, TState, TName, TFeatures, M>;
};
