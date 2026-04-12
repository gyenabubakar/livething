/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitive.ts';
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

type ChannelIncoming<
  TPrefix extends readonly ChannelStatePrimitive[],
  TEvent extends string,
  TPayload,
> = IncomingForPrefix<'channel', TPrefix, TEvent, TPayload>;
type ChannelRequest<
  TPrefix extends readonly ChannelStatePrimitive[],
  TEvent extends string,
  TPayload,
  TResponse,
> = RequestForPrefix<'channel', TPrefix, TEvent, TPayload, TResponse>;
type ChannelGenerate<
  TPrefix extends readonly ChannelStatePrimitive[],
  TStream extends StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
> = GenerateForPrefix<'channel', TPrefix, TStream>;
type ChannelPreIntercept<TPrefix extends readonly ChannelStatePrimitive[]> = PreInterceptForPrefix<
  'channel',
  TPrefix
>;
type ChannelPostIntercept<
  TPrefix extends readonly ChannelStatePrimitive[],
  TIncoming extends IncomingPrimitive<string, any, any>,
> = PostInterceptForIncoming<'channel', TPrefix, TIncoming>;

/**
 * A dynamic channel family declaration.
 *
 * Pairs a stable type key (used by the type system and client contract) with
 * a runtime `RegExp` that matches concrete channel names.
 *
 * Created by `scope('room', /^room-\d+$/)`.
 */
export interface ScopeDeclaration<TKey extends string = string> {
  readonly key: TKey;
  readonly pattern: RegExp;
}

/**
 * What `channel()` accepts as its first argument.
 *
 * - A plain string like `'lobby'` creates a static channel.
 * - A `ScopeDeclaration` from `scope(...)` creates a dynamic channel family.
 */
export type ChannelPattern = string | ScopeDeclaration<string>;

export type ChannelLifecycleChild =
  | BeforeSubscribePrimitive<any, any>
  | SubscribePrimitive<any>
  | UnsubscribePrimitive<any>;

export type ChannelChild = ChannelStatePrimitive | ChannelLifecycleChild;

/**
 * The handler context type inside a channel scope.
 *
 * This is the `ctx` type your `incoming`, `request`, and lifecycle handlers
 * receive when they live inside a `channel(...)` block. It includes the
 * channel-specific `ctx.channel` scope API.
 */
export type ChannelHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
  THasReplay extends boolean = false,
> = HandlerCtxFromState<ScopeState<'channel', TOutgoing, THasAck, THasReplay>>;

/**
 * The stream handler context type inside a channel scope.
 *
 * This is the base `ctx` type for `generate(...)` handlers inside a
 * `channel(...)` block. Stream-local helpers like `ctx.nudges(...)` are
 * added on top of this by the stream declaration.
 */
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
 * Define a dynamic channel family with a stable type key and a runtime
 * pattern matcher.
 *
 * The `key` is the stable name used in the type system and client contract.
 * The `pattern` is a RegExp that matches concrete channel names at runtime.
 *
 * ```ts
 * channel(scope('room', /^room-\d+$/),
 *   outgoing('room-message', t<{ text: string }>()),
 *   incoming(sendRoomMessage, async (ctx, payload) => {
 *     ctx.channel.broadcast('room-message', { text: payload.text });
 *   }),
 * )
 * ```
 */
export function scope<TKey extends string>(key: TKey, pattern: RegExp): ScopeDeclaration<TKey> {
  return { key, pattern };
}

/**
 * Group events under a channel scope with pub/sub membership.
 *
 * Clients subscribe to channels explicitly. Only subscribed connections
 * receive broadcasts within that channel.
 *
 * - Static: `channel('lobby', outgoing(...), incoming(...))`
 * - Dynamic: `channel(scope('room', /^room-\d+$/), outgoing(...), incoming(...))`
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
  interceptPrimitive: ChannelPreIntercept<[P1]>,
  incomingPrimitive: ChannelIncoming<
    AppendFoldable<[P1], typeof interceptPrimitive>,
    TIncomingEvent,
    TIncomingPayload
  >,
): ChannelPrimitive<TPattern, readonly [P1, typeof interceptPrimitive, typeof incomingPrimitive]>;
export function channel<
  TPattern extends ChannelPattern,
  P1 extends ChannelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  pattern: TPattern,
  p1: P1,
  incomingPrimitive: ChannelIncoming<[P1], TIncomingEvent, TIncomingPayload>,
): ChannelPrimitive<TPattern, readonly [P1, typeof incomingPrimitive]>;
export function channel<
  TPattern extends ChannelPattern,
  P1 extends ChannelStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  pattern: TPattern,
  p1: P1,
  incomingPrimitive: ChannelIncoming<[P1], TIncomingEvent, TIncomingPayload>,
  interceptPrimitive: ChannelPostIntercept<[P1], typeof incomingPrimitive>,
): ChannelPrimitive<TPattern, readonly [P1, typeof incomingPrimitive, typeof interceptPrimitive]>;
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
  incomingPrimitive: ChannelIncoming<[P1, P2], TIncomingEvent, TIncomingPayload>,
  requestPrimitive: ChannelRequest<[P1, P2], TRequestEvent, TRequestPayload, TRequestResponse>,
  generatePrimitive: ChannelGenerate<[P1, P2], TStream>,
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
