/* oxlint-disable @typescript-eslint/no-explicit-any */
import type {
  HandlerCtxFromState,
  NoOutgoing,
  ScopeState,
  StreamBaseCtxFromState,
} from '~/_types/scope-state.ts';
import type {
  BeforeSubscribePrimitive,
  SubscribePrimitive,
  UnsubscribePrimitive,
} from '~/channel/lifecycle.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/intercept/intercept.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type { CustomReplayPrimitive } from '~/replay/custom.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/stream/stream.ts';

type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyPreIntercept = PreInterceptPrimitive<any>;
type AnyPostIntercept = PostInterceptPrimitive<string, any, any>;
type AnyRequest = RequestPrimitive<string, any, any, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
type ChannelStatePrimitive =
  | AnyOutgoing
  | ReplayPrimitive
  | CustomReplayPrimitive
  | AnyPreIntercept
  | AnyPostIntercept
  | AnyIncoming
  | AnyRequest
  | AnyGenerate;

export interface ScopeDeclaration<TKey extends string = string> {
  readonly key: TKey;
  readonly pattern: RegExp;
}

export type ChannelPattern = string | ScopeDeclaration<string>;

export type ChannelLifecycleChild =
  | BeforeSubscribePrimitive<any, any>
  | SubscribePrimitive<any>
  | UnsubscribePrimitive<any>;

export type ChannelChild = ChannelStatePrimitive | ChannelLifecycleChild;

export type ChannelHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
  THasReplay extends boolean = false,
> = HandlerCtxFromState<ScopeState<'channel', TOutgoing, THasAck, THasReplay>>;

export type ChannelStreamHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasReplay extends boolean = false,
> = StreamBaseCtxFromState<ScopeState<'channel', TOutgoing, false, THasReplay>>;

export interface ChannelPrimitive<
  TPattern extends ChannelPattern = ChannelPattern,
  TPrimitives extends readonly ChannelChild[] = readonly ChannelChild[],
> extends Primitive<'channel'> {
  readonly pattern: TPattern;
  readonly primitives: TPrimitives;
}

const CHANNEL_KEY = Symbol('channel');

export function scope<TKey extends string>(key: TKey, pattern: RegExp): ScopeDeclaration<TKey> {
  return { key, pattern };
}

export function channel<
  const TPattern extends ChannelPattern,
  const TPrimitives extends readonly ChannelChild[],
>(pattern: TPattern, ...primitives: TPrimitives): ChannelPrimitive<TPattern, TPrimitives> {
  return {
    __wskit: 'channel',
    __kind: 'scope',
    __identity: [CHANNEL_KEY, typeof pattern === 'string' ? pattern : pattern.key],
    __dependencies: [],
    __requires: {},
    pattern,
    primitives: Object.freeze([...primitives]) as unknown as TPrimitives,
  };
}

channel.__key = CHANNEL_KEY;
