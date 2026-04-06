/* oxlint-disable @typescript-eslint/no-explicit-any */
import type {
  AppendFoldable,
  GenerateForPrefix,
  IncomingForPrefix,
  PostInterceptForIncoming,
  PreInterceptForPrefix,
  RequestForPrefix,
} from '~/_types/callback-bridge.ts';
import type {
  HandlerCtxFromState,
  NoOutgoing,
  ScopeState,
  StreamBaseCtxFromState,
} from '~/_types/scope-state.ts';
import type { AckPrimitive } from '~/ack/ack.ts';
import type { ChannelPrimitive } from '~/channel/channel.ts';
import type { DedupPrimitive } from '~/dedup/dedup.ts';
import type { ErrorsPrimitive } from '~/errors/errors.ts';
import type { HeartbeatPrimitive } from '~/heartbeat/heartbeat.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/intercept/intercept.ts';
import type { NamespacePrimitive } from '~/namespace/namespace.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { PassivePrimitive } from '~/passive/passive.ts';
import type { Primitive } from '~/primitive.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { SequencePrimitive } from '~/sequence/sequence.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/stream/stream.ts';

type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyRequest = RequestPrimitive<string, any, any, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyPreIntercept = PreInterceptPrimitive<any>;
type AnyPostIntercept = PostInterceptPrimitive<string, any, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
type TopLevelStatePrimitive =
  | AckPrimitive
  | HeartbeatPrimitive
  | SequencePrimitive
  | DedupPrimitive
  | ReplayPrimitive<any>
  | ErrorsPrimitive
  | AnyOutgoing
  | AnyPreIntercept
  | AnyPostIntercept
  | AnyIncoming
  | AnyRequest
  | AnyGenerate;

type TopLevelPrimitive =
  | TopLevelStatePrimitive
  | PassivePrimitive<any>
  | NamespacePrimitive
  | ChannelPrimitive;

type TopLevelIncoming<
  TPrefix extends readonly TopLevelStatePrimitive[],
  TEvent extends string,
  TPayload,
> = IncomingForPrefix<'top', TPrefix, TEvent, TPayload>;

type TopLevelRequest<
  TPrefix extends readonly TopLevelStatePrimitive[],
  TEvent extends string,
  TPayload,
  TResponse,
> = RequestForPrefix<'top', TPrefix, TEvent, TPayload, TResponse>;

type TopLevelGenerate<
  TPrefix extends readonly TopLevelStatePrimitive[],
  TStream extends StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
> = GenerateForPrefix<'top', TPrefix, TStream>;

type TopLevelPreIntercept<TPrefix extends readonly TopLevelStatePrimitive[]> =
  PreInterceptForPrefix<'top', TPrefix>;

type TopLevelPostIntercept<
  TPrefix extends readonly TopLevelStatePrimitive[],
  TIncoming extends IncomingPrimitive<string, any, any>,
> = PostInterceptForIncoming<'top', TPrefix, TIncoming>;

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

function hasNestedPrimitives(
  primitive: Primitive,
): primitive is NamespacePrimitive | ChannelPrimitive | PassivePrimitive<any> {
  return (
    primitive.__wskit === 'namespace' ||
    primitive.__wskit === 'channel' ||
    primitive.__wskit === 'passive'
  );
}

function collectRegisteredRefs(
  primitives: readonly Primitive[],
  refs = new Set<symbol>(),
): Set<symbol> {
  for (const primitive of primitives) {
    refs.add(primitive.__identity[0]);

    if (hasNestedPrimitives(primitive)) {
      collectRegisteredRefs(primitive.primitives, refs);
    }
  }

  return refs;
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

    if (hasNestedPrimitives(primitive)) {
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
  incomingPrimitive: TopLevelIncoming<[P1], TIncomingEvent, TIncomingPayload>,
): ServerDefinition<readonly [P1, typeof incomingPrimitive]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
  TNamespace extends NamespacePrimitive,
>(
  p1: P1,
  incomingPrimitive: TopLevelIncoming<[P1], TIncomingEvent, TIncomingPayload>,
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
  incomingPrimitive: TopLevelIncoming<[P1, P2], TIncomingEvent, TIncomingPayload>,
  namespacePrimitive: TNamespace,
): ServerDefinition<readonly [P1, P2, typeof incomingPrimitive, TNamespace]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
  TChannel extends ChannelPrimitive,
>(
  p1: P1,
  incomingPrimitive: TopLevelIncoming<[P1], TIncomingEvent, TIncomingPayload>,
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
  incomingPrimitive: TopLevelIncoming<[P1, P2], TIncomingEvent, TIncomingPayload>,
  channelPrimitive: TChannel,
): ServerDefinition<readonly [P1, P2, typeof incomingPrimitive, TChannel]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  p1: P1,
  interceptPrimitive: TopLevelPreIntercept<[P1]>,
  incomingPrimitive: TopLevelIncoming<
    AppendFoldable<[P1], typeof interceptPrimitive>,
    TIncomingEvent,
    TIncomingPayload
  >,
): ServerDefinition<readonly [P1, typeof interceptPrimitive, typeof incomingPrimitive]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  P2 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  p1: P1,
  p2: P2,
  interceptPrimitive: TopLevelPreIntercept<[P1, P2]>,
  incomingPrimitive: TopLevelIncoming<[P1, P2], TIncomingEvent, TIncomingPayload>,
): ServerDefinition<readonly [P1, P2, typeof interceptPrimitive, typeof incomingPrimitive]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  P2 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  p1: P1,
  p2: P2,
  incomingPrimitive: TopLevelIncoming<[P1, P2], TIncomingEvent, TIncomingPayload>,
): ServerDefinition<readonly [P1, P2, typeof incomingPrimitive]>;
export function defineServer<
  P1 extends TopLevelStatePrimitive,
  P2 extends TopLevelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  p1: P1,
  p2: P2,
  incomingPrimitive: TopLevelIncoming<[P1, P2], TIncomingEvent, TIncomingPayload>,
  interceptPrimitive: TopLevelPostIntercept<[P1, P2], typeof incomingPrimitive>,
): ServerDefinition<readonly [P1, P2, typeof incomingPrimitive, typeof interceptPrimitive]>;
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
  incomingPrimitive: TopLevelIncoming<[P1, P2, P3], TIncomingEvent, TIncomingPayload>,
  requestPrimitive: TopLevelRequest<[P1, P2, P3], TRequestEvent, TRequestPayload, TRequestResponse>,
  generatePrimitive: TopLevelGenerate<[P1, P2, P3], TStream>,
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
  incomingPrimitive: TopLevelIncoming<[P1, P2, P3, P4], TIncomingEvent, TIncomingPayload>,
  requestPrimitive: TopLevelRequest<
    [P1, P2, P3, P4],
    TRequestEvent,
    TRequestPayload,
    TRequestResponse
  >,
  generatePrimitive: TopLevelGenerate<[P1, P2, P3, P4], TStream>,
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
