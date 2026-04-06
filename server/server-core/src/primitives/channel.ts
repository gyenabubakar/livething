/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitives/define.ts';
import type { Primitive } from '~/primitives/define.ts';
import type { IncomingPrimitive } from '~/primitives/incoming.ts';
import type { OutgoingPrimitive } from '~/primitives/outgoing.ts';
import type { RequestPrimitive } from '~/primitives/request.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/primitives/stream.ts';
import type {
  FoldState,
  HandlerCtxFromState,
  NoOutgoing,
  ScopeState,
  StreamBaseCtxFromState,
} from '~/types/scope-state.ts';

type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyRequest = RequestPrimitive<string, any, any, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
type ChannelStatePrimitive = AnyOutgoing | AnyIncoming | AnyRequest | AnyGenerate;

type ChannelHandlerCtx<TPrefix extends readonly ChannelStatePrimitive[]> = HandlerCtxFromState<
  FoldState<TPrefix, ScopeState<'channel'>>
>;

type ChannelStreamBaseCtx<TPrefix extends readonly ChannelStatePrimitive[]> =
  StreamBaseCtxFromState<FoldState<TPrefix, ScopeState<'channel'>>>;

export interface ScopeDeclaration<TKey extends string = string> {
  readonly key: TKey;
  readonly pattern: RegExp;
}

export type ChannelPattern = string | ScopeDeclaration<string>;

export type ChannelChild = ChannelStatePrimitive;

export type ChannelHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
> = HandlerCtxFromState<ScopeState<'channel', TOutgoing, THasAck>>;

export type ChannelStreamHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  StreamBaseCtxFromState<ScopeState<'channel', TOutgoing, false>>;

export interface ChannelPrimitive<
  TPattern extends ChannelPattern = ChannelPattern,
  TPrimitives extends readonly ChannelChild[] = readonly ChannelChild[],
> extends Primitive<'channel'> {
  readonly pattern: TPattern;
  readonly primitives: TPrimitives;
}

const CHANNEL_KEY = Symbol('channel');

const _channel = definePrimitive<
  'channel',
  [pattern: ChannelPattern, ...primitives: ChannelChild[]],
  { pattern: ChannelPattern; primitives: readonly ChannelChild[] }
>({
  tag: 'channel' as const,
  key: CHANNEL_KEY,
  kind: 'scope' as const,
  registrationId(pattern: ChannelPattern) {
    return typeof pattern === 'string' ? pattern : pattern.key;
  },
  create(pattern: ChannelPattern, ...primitives: ChannelChild[]) {
    return {
      pattern,
      primitives: Object.freeze([...primitives]) as readonly ChannelChild[],
    };
  },
});

/**
 * Define a dynamic channel family with a stable type key and a runtime matcher.
 */
export function scope<TKey extends string>(key: TKey, pattern: RegExp): ScopeDeclaration<TKey> {
  return { key, pattern };
}

/**
 * Group events under a channel scope.
 *
 * Typing rule: channel-local primitives that affect handler ctx must come
 * before the handlers they type.
 */
export function channel<
  TPattern extends ChannelPattern,
  P1 extends ChannelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  pattern: TPattern,
  p1: P1,
  incomingPrimitive: IncomingPrimitive<TIncomingEvent, TIncomingPayload, ChannelHandlerCtx<[P1]>>,
): ChannelPrimitive<TPattern, readonly [P1, typeof incomingPrimitive]>;
export function channel<
  TPattern extends ChannelPattern,
  P1 extends ChannelStatePrimitive,
  P2 extends ChannelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
  TRequestEvent extends string,
  TRequestPayload,
  TRequestResponse,
  TStream extends StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
>(
  pattern: TPattern,
  p1: P1,
  p2: P2,
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    ChannelHandlerCtx<[P1, P2]>
  >,
  requestPrimitive: RequestPrimitive<
    TRequestEvent,
    TRequestPayload,
    TRequestResponse,
    ChannelHandlerCtx<[P1, P2]>
  >,
  generatePrimitive: GeneratePrimitive<TStream, ChannelStreamBaseCtx<[P1, P2]>, any>,
): ChannelPrimitive<
  TPattern,
  readonly [P1, P2, typeof incomingPrimitive, typeof requestPrimitive, typeof generatePrimitive]
>;
export function channel<
  const TPattern extends ChannelPattern,
  const TPrimitives extends readonly ChannelChild[],
>(pattern: TPattern, ...primitives: TPrimitives): ChannelPrimitive<TPattern, TPrimitives>;
export function channel(pattern: ChannelPattern, ...primitives: ChannelChild[]): ChannelPrimitive {
  return _channel(pattern, ...primitives) as unknown as ChannelPrimitive;
}

/** Dependency ref — use in `dependencies: [channel]` to assert it's registered. */
channel.__key = CHANNEL_KEY;
