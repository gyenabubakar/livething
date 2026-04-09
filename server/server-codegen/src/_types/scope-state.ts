/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { AckPrimitive } from '~/ack/ack.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';
import type { ErrorDef } from '~/errors.ts';
import type { ErrorsPrimitive } from '~/errors/errors.ts';
import type { HeartbeatPrimitive } from '~/heartbeat/heartbeat.ts';
import type { HibernationPrimitive } from '~/hibernation/hibernation.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { InterceptPrimitive } from '~/intercept/intercept.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { PassivePrimitive } from '~/passive/passive.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { ScheduledPrimitive } from '~/scheduled/scheduled.ts';
import type { SequencePrimitive } from '~/sequence/sequence.ts';
import type {
  GeneratePrimitive,
  NudgeDeclaration,
  StreamNudgesApi,
  StreamPrimitive,
} from '~/stream/stream.ts';

type AnyErrorDef = ErrorDef<string, any>;
type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyRequest = RequestPrimitive<string, any, any, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
type AnyErrors = ErrorsPrimitive<readonly AnyErrorDef[]>;
type AnyReplay = ReplayPrimitive;
type AnyIntercept = InterceptPrimitive<string, any, any>;
type AnyPassive = PassivePrimitive<readonly any[]>;

/**
 * Every primitive shape that the fold engine knows how to process.
 *
 * `namespace()` and `channel()` are not included here because they create
 * their own nested folds.
 */
export type FoldablePrimitive =
  | AckPrimitive
  | AnyPassive
  | HeartbeatPrimitive
  | HibernationPrimitive
  | SequencePrimitive
  | DedupPrimitive
  | AnyReplay
  | ScheduledPrimitive<string, any, any>
  | AnyIntercept
  | AnyErrors
  | AnyOutgoing
  | AnyIncoming
  | AnyRequest
  | AnyGenerate;

/**
 * The scope currently being typed.
 *
 * This decides which extra ctx fields exist, like `namespaceName` or
 * `channelName`.
 */
export type ScopeKind = 'top' | 'namespace' | 'channel';

/**
 * The client-facing contract accumulated while folding primitives.
 *
 * This is the raw shape that later powers `InferClient`.
 */
export interface ClientContractState {
  readonly incoming: Record<string, any>;
  readonly outgoing: Record<string, any>;
  readonly requests: Record<string, any>;
  readonly streams: Record<string, any>;
}

/**
 * The minimal shape every scope state must have while folding.
 *
 * Most helper types only care about these fields, not the exact generic
 * parameters of `ScopeState`.
 */
export interface ScopeStateShape {
  readonly kind: ScopeKind;
  readonly outgoing: Record<string, any>;
  readonly hasAck: boolean;
  readonly hasReplay: boolean;
  readonly contract: ClientContractState;
  readonly errors: readonly AnyErrorDef[];
}

/**
 * A helper for "no outgoing events registered yet".
 *
 * Using `Record<never, never>` keeps the object empty without widening it
 * to a generic `Record<string, unknown>`.
 */
export type NoOutgoing = Record<never, never>;

/**
 * The full accumulated state for one scope.
 *
 * As primitives are registered, this type records:
 * - which scope we are in
 * - which outgoing events are available to handlers
 * - whether `ack()` is enabled
 * - whether `replay()` is enabled
 * - the client contract gathered so far
 * - the defined server errors
 */
export type ScopeState<
  TKind extends ScopeKind = 'top',
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
  THasReplay extends boolean = false,
  TContract extends ClientContractState = {
    incoming: {};
    outgoing: {};
    requests: {};
    streams: {};
  },
  TErrors extends readonly AnyErrorDef[] = readonly [],
> = {
  readonly kind: TKind;
  readonly outgoing: TOutgoing;
  readonly hasAck: THasAck;
  readonly hasReplay: THasReplay;
  readonly contract: TContract;
  readonly errors: TErrors;
};

/**
 * Merge two object maps, with keys from `B` overriding keys from `A`.
 *
 * This is the core "append to contract" helper used by the fold.
 */
export type MergeRecords<A, B> = {
  [TKey in keyof A | keyof B]: TKey extends keyof B
    ? B[TKey]
    : TKey extends keyof A
      ? A[TKey]
      : never;
};

/**
 * Turn an `outgoing()` primitive into `{ eventName: payloadType }`.
 */
type OutgoingEntry<TPrimitive extends AnyOutgoing> =
  TPrimitive extends OutgoingPrimitive<infer TEvent, infer TPayload>
    ? Record<TEvent, TPayload>
    : never;

/**
 * Turn a `request()` primitive into
 * `{ eventName: { payload, response } }`.
 */
type RequestEntry<TPrimitive extends AnyRequest> =
  TPrimitive extends RequestPrimitive<infer TEvent, infer TPayload, infer TResponse, any>
    ? Record<TEvent, { payload: TPayload; response: TResponse }>
    : never;

/**
 * Convert a stream's nudges into a simple event -> payload map.
 *
 * Example:
 * `readonly [nudge('cancel'), nudge('add-context', ...)]`
 * becomes
 * `{ cancel: unknown; 'add-context': AddContextPayload }`
 */
type NudgeMap<TNudges extends readonly NudgeDeclaration[]> = {
  [TNudge in TNudges[number] as TNudge['event']]: TNudge extends NudgeDeclaration<
    string,
    infer TPayload
  >
    ? TPayload
    : never;
};

/**
 * Convert a stream contract into the client-facing stream entry.
 */
type StreamEntry<TStream extends StreamPrimitive> =
  TStream extends StreamPrimitive<string, infer TPayload, infer TChunks, infer TNudges>
    ? Record<
        TStream['event'],
        {
          payload: TPayload;
          chunks: TChunks;
        } & (keyof NudgeMap<TNudges> extends never ? {} : { nudges: NudgeMap<TNudges> })
      >
    : never;

/**
 * Apply one primitive to the current scope state.
 *
 * This is the heart of the fold. Each branch says what a primitive changes:
 * - `ack()` flips `hasAck`
 * - passive infrastructure like `heartbeat()` leaves handler ctx unchanged
 * - `replay()` flips `hasReplay`
 * - `outgoing()` adds sendable events
 * - `incoming()` and `request()` extend the client contract
 * - `generate()` adds a stream to the client contract
 */
export type NextState<
  TState extends ScopeStateShape,
  TPrimitive extends FoldablePrimitive,
> = TPrimitive extends AnyPassive
  ? FoldState<TPrimitive['primitives'], TState>
  : TPrimitive extends AckPrimitive
    ? {
        readonly kind: TState['kind'];
        readonly outgoing: TState['outgoing'];
        readonly hasAck: true;
        readonly hasReplay: TState['hasReplay'];
        readonly contract: TState['contract'];
        readonly errors: TState['errors'];
      }
    : TPrimitive extends
          | HeartbeatPrimitive
          | HibernationPrimitive
          | SequencePrimitive
          | DedupPrimitive
          | ScheduledPrimitive<string, any, any>
      ? {
          readonly kind: TState['kind'];
          readonly outgoing: TState['outgoing'];
          readonly hasAck: TState['hasAck'];
          readonly hasReplay: TState['hasReplay'];
          readonly contract: TState['contract'];
          readonly errors: TState['errors'];
        }
      : TPrimitive extends AnyReplay
        ? {
            readonly kind: TState['kind'];
            readonly outgoing: TState['outgoing'];
            readonly hasAck: TState['hasAck'];
            readonly hasReplay: true;
            readonly contract: TState['contract'];
            readonly errors: TState['errors'];
          }
        : TPrimitive extends AnyErrors
          ? TPrimitive extends ErrorsPrimitive<infer TDefs extends readonly AnyErrorDef[]>
            ? {
                readonly kind: TState['kind'];
                readonly outgoing: TState['outgoing'];
                readonly hasAck: TState['hasAck'];
                readonly hasReplay: TState['hasReplay'];
                readonly contract: TState['contract'];
                readonly errors: TDefs;
              }
            : TState
          : TPrimitive extends AnyOutgoing
            ? {
                readonly kind: TState['kind'];
                readonly outgoing: MergeRecords<TState['outgoing'], OutgoingEntry<TPrimitive>>;
                readonly hasAck: TState['hasAck'];
                readonly hasReplay: TState['hasReplay'];
                readonly contract: {
                  incoming: MergeRecords<TState['contract']['incoming'], OutgoingEntry<TPrimitive>>;
                  outgoing: TState['contract']['outgoing'];
                  requests: TState['contract']['requests'];
                  streams: TState['contract']['streams'];
                };
                readonly errors: TState['errors'];
              }
            : TPrimitive extends AnyIncoming
              ? TPrimitive extends IncomingPrimitive<infer TEvent, infer TPayload, any>
                ? {
                    readonly kind: TState['kind'];
                    readonly outgoing: TState['outgoing'];
                    readonly hasAck: TState['hasAck'];
                    readonly hasReplay: TState['hasReplay'];
                    readonly contract: {
                      incoming: TState['contract']['incoming'];
                      outgoing: MergeRecords<
                        TState['contract']['outgoing'],
                        Record<TEvent, TPayload>
                      >;
                      requests: TState['contract']['requests'];
                      streams: TState['contract']['streams'];
                    };
                    readonly errors: TState['errors'];
                  }
                : TState
              : TPrimitive extends AnyRequest
                ? {
                    readonly kind: TState['kind'];
                    readonly outgoing: TState['outgoing'];
                    readonly hasAck: TState['hasAck'];
                    readonly hasReplay: TState['hasReplay'];
                    readonly contract: {
                      incoming: TState['contract']['incoming'];
                      outgoing: TState['contract']['outgoing'];
                      requests: MergeRecords<
                        TState['contract']['requests'],
                        RequestEntry<TPrimitive>
                      >;
                      streams: TState['contract']['streams'];
                    };
                    readonly errors: TState['errors'];
                  }
                : TPrimitive extends AnyGenerate
                  ? TPrimitive extends GeneratePrimitive<infer TStream, any, any>
                    ? {
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
                            StreamEntry<TStream>
                          >;
                        };
                        readonly errors: TState['errors'];
                      }
                    : TState
                  : TState;

/**
 * Fold a tuple of primitives from left to right into one final scope state.
 *
 * This is why primitive order matters for typed ctx.
 */
export type FoldState<
  TItems extends readonly FoldablePrimitive[],
  TState extends ScopeStateShape = ScopeState,
> = TItems extends readonly [
  infer THead extends FoldablePrimitive,
  ...infer TTail extends readonly FoldablePrimitive[],
]
  ? FoldState<TTail, NextState<TState, THead>>
  : TState;

export interface SendMethods<TOutgoing extends Record<string, any>> {
  /**
   * Send an event to the current connection.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   */
  send<TEvent extends keyof TOutgoing & string>(event: TEvent, payload: TOutgoing[TEvent]): void;

  /**
   * Broadcast an event to other connections in the current scope.
   *
   * Only events declared with `outgoing()` in the same scope are allowed.
   */
  broadcast<TEvent extends keyof TOutgoing & string>(
    event: TEvent,
    payload: TOutgoing[TEvent],
  ): void;
}

export interface AckMethods {
  /**
   * Confirm receipt of the current incoming message.
   *
   * This only exists when `ack()` is registered in the top-level scope.
   */
  ack(): void;
}

export interface ReplayWire {
  readonly seq: number;
  readonly messageId: string;
  readonly channel?: string;
}

export interface ReplayMethods<TOutgoing extends Record<string, any>> {
  /**
   * Send a replay message directly with explicit wire metadata.
   */
  sendReplay<TEvent extends keyof TOutgoing & string>(
    event: TEvent,
    payload: TOutgoing[TEvent],
    wire: ReplayWire,
  ): void;
}

export interface NamespaceScopeMethods {
  /**
   * The matched namespace name for the current handler call.
   */
  readonly namespaceName: string;
}

export interface ChannelScopeMethods {
  /**
   * The current channel name for this handler call.
   */
  readonly channelName: string;
}

/**
 * Only expose `send` / `broadcast` when the scope actually has outgoing
 * events. Without this, empty scopes would still show useless methods.
 */
type SendApi<TOutgoing extends Record<string, any>> = keyof TOutgoing extends never
  ? {}
  : SendMethods<TOutgoing>;

/**
 * Only expose `ack()` in top-level scopes that registered `ack()`.
 */
type AckApi<TState extends ScopeStateShape> = TState['kind'] extends 'top'
  ? TState['hasAck'] extends true
    ? AckMethods
    : {}
  : {};

/**
 * Only expose `sendReplay(...)` when replay is enabled in this scope.
 *
 * If there are no known outgoing events yet, the method falls back to a
 * broad `(event: string, payload: unknown)` signature.
 */
type ReplayApi<TState extends ScopeStateShape> = TState['hasReplay'] extends true
  ? keyof TState['outgoing'] extends never
    ? {
        sendReplay(event: string, payload: unknown, wire: ReplayWire): void;
      }
    : ReplayMethods<TState['outgoing']>
  : {};

/**
 * Add scope-specific ctx fields like `namespaceName` or `channelName`.
 */
type ScopeExtras<TKind extends ScopeKind> = TKind extends 'namespace'
  ? NamespaceScopeMethods
  : TKind extends 'channel'
    ? ChannelScopeMethods
    : {};

/**
 * Build the normal handler ctx from folded state.
 *
 * This is what `incoming()`, `request()`, and most intercept callbacks see.
 */
export type HandlerCtxFromState<TState extends ScopeStateShape> = SendApi<TState['outgoing']> &
  AckApi<TState> &
  ReplayApi<TState> &
  ScopeExtras<TState['kind']>;

/**
 * Build the base ctx for stream generators.
 *
 * Streams intentionally do not get `ack()`, but they do get send/broadcast,
 * replay helpers, and scope extras.
 */
export type StreamBaseCtxFromState<TState extends ScopeStateShape> = SendApi<TState['outgoing']> &
  ReplayApi<TState> &
  ScopeExtras<TState['kind']>;

/**
 * Build the full stream ctx by adding `ctx.nudges(...)` on top of the
 * regular stream base ctx.
 */
export type StreamCtxFromState<
  TState extends ScopeStateShape,
  TNudges extends readonly NudgeDeclaration[],
> = StreamBaseCtxFromState<TState> & StreamNudgesApi<TNudges>;

/**
 * Read the client contract out of a folded scope state.
 */
export type ContractFromState<TState extends ScopeStateShape> = TState['contract'];

/**
 * Read the declared error list out of a folded scope state.
 */
export type ErrorsFromState<TState extends ScopeStateShape> = TState['errors'];

/**
 * Filter a mixed tuple down to just the primitives that participate in the
 * fold engine.
 *
 * This is how `InferClient` can accept tuples that also contain scopes.
 */
export type FoldableItemsOf<TItems extends readonly unknown[]> = TItems extends readonly [
  infer THead,
  ...infer TTail,
]
  ? THead extends FoldablePrimitive
    ? readonly [THead, ...FoldableItemsOf<TTail>]
    : FoldableItemsOf<TTail>
  : readonly [];

/**
 * Compute the client contract directly from a tuple of items.
 *
 * Items that are not foldable primitives are skipped automatically.
 */
export type ContractFromItems<
  TItems extends readonly unknown[],
  TKind extends ScopeKind = 'top',
> = ContractFromState<FoldState<FoldableItemsOf<TItems>, ScopeState<TKind>>>;

/**
 * Compute the declared error list directly from a tuple of items.
 */
export type ErrorsFromItems<
  TItems extends readonly unknown[],
  TKind extends ScopeKind = 'top',
> = ErrorsFromState<FoldState<FoldableItemsOf<TItems>, ScopeState<TKind>>>;
