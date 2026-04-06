/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { AckPrimitive } from '~/primitives/ack.ts';
import type { ChannelPrimitive } from '~/primitives/channel.ts';
import type { DedupPrimitive } from '~/primitives/dedup.ts';
import type { Primitive } from '~/primitives/define.ts';
import type { ErrorsPrimitive } from '~/primitives/errors.ts';
import type { IncomingPrimitive } from '~/primitives/incoming.ts';
import type { NamespacePrimitive } from '~/primitives/namespace.ts';
import type { OutgoingPrimitive } from '~/primitives/outgoing.ts';
import type { ReplayPrimitive } from '~/primitives/replay.ts';
import type { RequestPrimitive } from '~/primitives/request.ts';
import type { SequencePrimitive } from '~/primitives/sequence.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/primitives/stream.ts';
import type {
  FoldState,
  HandlerCtxFromState,
  NoOutgoing,
  ScopeState,
  StreamBaseCtxFromState,
} from '~/types/scope-state.ts';

type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyRequest = RequestPrimitive<string, any, any, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
type TopLevelStatePrimitive =
  | AckPrimitive
  | SequencePrimitive
  | DedupPrimitive
  | ReplayPrimitive<any>
  | ErrorsPrimitive
  | AnyOutgoing
  | AnyIncoming
  | AnyRequest
  | AnyGenerate;
type TopLevelPrimitive = TopLevelStatePrimitive | NamespacePrimitive | ChannelPrimitive;

type TopLevelHandlerCtx<TPrefix extends readonly TopLevelStatePrimitive[]> = HandlerCtxFromState<
  FoldState<TPrefix, ScopeState<'top'>>
>;

type TopLevelStreamBaseCtx<TPrefix extends readonly TopLevelStatePrimitive[]> =
  StreamBaseCtxFromState<FoldState<TPrefix, ScopeState<'top'>>>;

export type ServerHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
  THasReplay extends boolean = false,
> = HandlerCtxFromState<ScopeState<'top', TOutgoing, THasAck, THasReplay>>;

export type StreamServerHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasReplay extends boolean = false,
> = StreamBaseCtxFromState<ScopeState<'top', TOutgoing, false, THasReplay>>;

export interface ServerDefinition<TPrimitives extends readonly Primitive[] = readonly Primitive[]> {
  readonly __wskit: 'server';
  readonly primitives: TPrimitives;
}

function isScopePrimitive(
  primitive: Primitive,
): primitive is NamespacePrimitive | ChannelPrimitive {
  return primitive.__wskit === 'namespace' || primitive.__wskit === 'channel';
}

function collectRegisteredRefs(primitives: readonly Primitive[]): Set<symbol> {
  return new Set(primitives.map((primitive) => primitive.__identity[0]));
}

function validateDependencies(
  primitives: readonly Primitive[],
  registeredRefs: ReadonlySet<symbol>,
): void {
  for (const primitive of primitives) {
    for (const dependency of primitive.__dependencies) {
      if (!registeredRefs.has(dependency.__key)) {
        throw new Error(
          `[wskit] ${primitive.__wskit} requires a missing dependency. Register the required primitive in defineServer.`,
        );
      }
    }

    if (isScopePrimitive(primitive)) {
      validateDependencies(primitive.primitives, registeredRefs);
    }
  }
}

/**
 * Define a WebSocket server using a flat list of primitives.
 *
 * Typing rule: primitives that affect handler ctx must come before the
 * handlers they type in the same scope.
 */
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  p1: P1,
  incomingPrimitive: IncomingPrimitive<TIncomingEvent, TIncomingPayload, TopLevelHandlerCtx<[P1]>>,
): ServerDefinition<readonly [P1, typeof incomingPrimitive]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
  TNamespace extends NamespacePrimitive,
>(
  p1: P1,
  incomingPrimitive: IncomingPrimitive<TIncomingEvent, TIncomingPayload, TopLevelHandlerCtx<[P1]>>,
  namespacePrimitive: TNamespace,
): ServerDefinition<readonly [P1, typeof incomingPrimitive, TNamespace]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  P2 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
  TNamespace extends NamespacePrimitive,
>(
  p1: P1,
  p2: P2,
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    TopLevelHandlerCtx<[P1, P2]>
  >,
  namespacePrimitive: TNamespace,
): ServerDefinition<readonly [P1, P2, typeof incomingPrimitive, TNamespace]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
  TChannel extends ChannelPrimitive,
>(
  p1: P1,
  incomingPrimitive: IncomingPrimitive<TIncomingEvent, TIncomingPayload, TopLevelHandlerCtx<[P1]>>,
  channelPrimitive: TChannel,
): ServerDefinition<readonly [P1, typeof incomingPrimitive, TChannel]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  P2 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
  TChannel extends ChannelPrimitive,
>(
  p1: P1,
  p2: P2,
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    TopLevelHandlerCtx<[P1, P2]>
  >,
  channelPrimitive: TChannel,
): ServerDefinition<readonly [P1, P2, typeof incomingPrimitive, TChannel]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  P2 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  p1: P1,
  p2: P2,
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    TopLevelHandlerCtx<[P1, P2]>
  >,
): ServerDefinition<readonly [P1, P2, typeof incomingPrimitive]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  P2 extends TopLevelStatePrimitive,
  P3 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
  TRequestEvent extends string,
  TRequestPayload,
  TRequestResponse,
  TStream extends StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
>(
  p1: P1,
  p2: P2,
  p3: P3,
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    TopLevelHandlerCtx<[P1, P2, P3]>
  >,
  requestPrimitive: RequestPrimitive<
    TRequestEvent,
    TRequestPayload,
    TRequestResponse,
    TopLevelHandlerCtx<[P1, P2, P3]>
  >,
  generatePrimitive: GeneratePrimitive<TStream, TopLevelStreamBaseCtx<[P1, P2, P3]>, any>,
): ServerDefinition<
  readonly [P1, P2, P3, typeof incomingPrimitive, typeof requestPrimitive, typeof generatePrimitive]
>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  P2 extends TopLevelStatePrimitive,
  P3 extends TopLevelStatePrimitive,
  P4 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
  TRequestEvent extends string,
  TRequestPayload,
  TRequestResponse,
  TStream extends StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
>(
  p1: P1,
  p2: P2,
  p3: P3,
  p4: P4,
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    TopLevelHandlerCtx<[P1, P2, P3, P4]>
  >,
  requestPrimitive: RequestPrimitive<
    TRequestEvent,
    TRequestPayload,
    TRequestResponse,
    TopLevelHandlerCtx<[P1, P2, P3, P4]>
  >,
  generatePrimitive: GeneratePrimitive<TStream, TopLevelStreamBaseCtx<[P1, P2, P3, P4]>, any>,
): ServerDefinition<
  readonly [
    P1,
    P2,
    P3,
    P4,
    typeof incomingPrimitive,
    typeof requestPrimitive,
    typeof generatePrimitive,
  ]
>;
export function defineServer<const TPrimitives extends readonly TopLevelPrimitive[]>(
  ...primitives: TPrimitives
): ServerDefinition<TPrimitives>;
export function defineServer(
  ...primitives: readonly Primitive[]
): ServerDefinition<readonly Primitive[]> {
  validateDependencies(primitives, collectRegisteredRefs(primitives));
  return Object.freeze({
    __wskit: 'server' as const,
    primitives: Object.freeze([...primitives]) as readonly Primitive[],
  });
}
