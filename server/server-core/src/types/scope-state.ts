/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ErrorDef } from '~/errors.ts';
import type { AckPrimitive } from '~/primitives/ack.ts';
import type { ErrorsPrimitive } from '~/primitives/errors.ts';
import type { IncomingPrimitive } from '~/primitives/incoming.ts';
import type { OutgoingPrimitive } from '~/primitives/outgoing.ts';
import type { RequestPrimitive } from '~/primitives/request.ts';
import type {
  GeneratePrimitive,
  NudgeDeclaration,
  StreamNudgesApi,
  StreamPrimitive,
} from '~/primitives/stream.ts';

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

export type FoldablePrimitive =
  | AckPrimitive
  | AnyErrors
  | AnyOutgoing
  | AnyIncoming
  | AnyRequest
  | AnyGenerate;

export type ScopeKind = 'top' | 'namespace' | 'channel';

export interface ClientContractState {
  readonly incoming: Record<string, any>;
  readonly outgoing: Record<string, any>;
  readonly requests: Record<string, any>;
  readonly streams: Record<string, any>;
}

export interface ScopeStateShape {
  readonly kind: ScopeKind;
  readonly outgoing: Record<string, any>;
  readonly hasAck: boolean;
  readonly contract: ClientContractState;
  readonly errors: readonly AnyErrorDef[];
}

export type NoOutgoing = Record<never, never>;

export type ScopeState<
  TKind extends ScopeKind = 'top',
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
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
  readonly contract: TContract;
  readonly errors: TErrors;
};

export type MergeRecords<A, B> = {
  [TKey in keyof A | keyof B]: TKey extends keyof B
    ? B[TKey]
    : TKey extends keyof A
      ? A[TKey]
      : never;
};

type OutgoingEntry<TPrimitive extends AnyOutgoing> =
  TPrimitive extends OutgoingPrimitive<infer TEvent, infer TPayload>
    ? Record<TEvent, TPayload>
    : never;

type RequestEntry<TPrimitive extends AnyRequest> =
  TPrimitive extends RequestPrimitive<infer TEvent, infer TPayload, infer TResponse, any>
    ? Record<TEvent, { payload: TPayload; response: TResponse }>
    : never;

type NudgeMap<TNudges extends readonly NudgeDeclaration[]> = {
  [TNudge in TNudges[number] as TNudge['event']]: TNudge extends NudgeDeclaration<
    string,
    infer TPayload
  >
    ? TPayload
    : never;
};

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

export type NextState<
  TState extends ScopeStateShape,
  TPrimitive extends FoldablePrimitive,
> = TPrimitive extends AckPrimitive
  ? {
      readonly kind: TState['kind'];
      readonly outgoing: TState['outgoing'];
      readonly hasAck: true;
      readonly contract: TState['contract'];
      readonly errors: TState['errors'];
    }
  : TPrimitive extends AnyErrors
    ? TPrimitive extends ErrorsPrimitive<infer TDefs extends readonly AnyErrorDef[]>
      ? {
          readonly kind: TState['kind'];
          readonly outgoing: TState['outgoing'];
          readonly hasAck: TState['hasAck'];
          readonly contract: TState['contract'];
          readonly errors: TDefs;
        }
      : TState
    : TPrimitive extends AnyOutgoing
      ? {
          readonly kind: TState['kind'];
          readonly outgoing: MergeRecords<TState['outgoing'], OutgoingEntry<TPrimitive>>;
          readonly hasAck: TState['hasAck'];
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
              readonly contract: {
                incoming: TState['contract']['incoming'];
                outgoing: MergeRecords<TState['contract']['outgoing'], Record<TEvent, TPayload>>;
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
              readonly contract: {
                incoming: TState['contract']['incoming'];
                outgoing: TState['contract']['outgoing'];
                requests: MergeRecords<TState['contract']['requests'], RequestEntry<TPrimitive>>;
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
                  readonly contract: {
                    incoming: TState['contract']['incoming'];
                    outgoing: TState['contract']['outgoing'];
                    requests: TState['contract']['requests'];
                    streams: MergeRecords<TState['contract']['streams'], StreamEntry<TStream>>;
                  };
                  readonly errors: TState['errors'];
                }
              : TState
            : TState;

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

type SendApi<TOutgoing extends Record<string, any>> = keyof TOutgoing extends never
  ? {}
  : SendMethods<TOutgoing>;

type AckApi<TState extends ScopeStateShape> = TState['kind'] extends 'top'
  ? TState['hasAck'] extends true
    ? AckMethods
    : {}
  : {};

type ScopeExtras<TKind extends ScopeKind> = TKind extends 'namespace'
  ? NamespaceScopeMethods
  : TKind extends 'channel'
    ? ChannelScopeMethods
    : {};

export type HandlerCtxFromState<TState extends ScopeStateShape> = SendApi<TState['outgoing']> &
  AckApi<TState> &
  ScopeExtras<TState['kind']>;

export type StreamBaseCtxFromState<TState extends ScopeStateShape> = SendApi<TState['outgoing']> &
  ScopeExtras<TState['kind']>;

export type StreamCtxFromState<
  TState extends ScopeStateShape,
  TNudges extends readonly NudgeDeclaration[],
> = StreamBaseCtxFromState<TState> & StreamNudgesApi<TNudges>;

export type ContractFromState<TState extends ScopeStateShape> = TState['contract'];
export type ErrorsFromState<TState extends ScopeStateShape> = TState['errors'];

export type FoldableItemsOf<TItems extends readonly unknown[]> = TItems extends readonly [
  infer THead,
  ...infer TTail,
]
  ? THead extends FoldablePrimitive
    ? readonly [THead, ...FoldableItemsOf<TTail>]
    : FoldableItemsOf<TTail>
  : readonly [];

export type ContractFromItems<
  TItems extends readonly unknown[],
  TKind extends ScopeKind = 'top',
> = ContractFromState<FoldState<FoldableItemsOf<TItems>, ScopeState<TKind>>>;

export type ErrorsFromItems<
  TItems extends readonly unknown[],
  TKind extends ScopeKind = 'top',
> = ErrorsFromState<FoldState<FoldableItemsOf<TItems>, ScopeState<TKind>>>;
