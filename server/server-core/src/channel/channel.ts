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

// Internal aliases that keep the union type below readable.
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

/**
 * Every primitive type that is legal as a state-carrying child of a channel.
 * State-carrying means it contributes to the type of `ctx` inside handlers
 * (outgoing events, intercepts, incoming handlers, requests, streams, replay).
 */
type ChannelStatePrimitive =
  | AnyOutgoing
  | ReplayPrimitive
  | CustomReplayPrimitive
  | AnyPreIntercept
  | AnyPostIntercept
  | AnyIncoming
  | AnyRequest
  | AnyGenerate;

/**
 * A named, optionally parameterised channel pattern used in `scope()`.
 * The `key` is the parameter name captured from the subscription path.
 */
export interface ScopeDeclaration<TKey extends string = string> {
  /** The parameter name extracted from the dynamic channel name. */
  readonly key: TKey;
  /** Regular expression matched against the subscription path. */
  readonly pattern: RegExp;
}

/**
 * The argument accepted by `channel()`. Either a plain string for exact channel
 * names (e.g. `'notifications'`) or a `ScopeDeclaration` for dynamic names
 * that capture a parameter from the path (e.g. `scope('roomId', /^room:(.+)$/)`)
 */
export type ChannelPattern = string | ScopeDeclaration<string>;

/**
 * Every primitive type that can appear as a lifecycle child of a channel.
 * Lifecycle children handle subscribe and unsubscribe events.
 */
export type ChannelLifecycleChild =
  | BeforeSubscribePrimitive<any, any>
  | SubscribePrimitive<any>
  | UnsubscribePrimitive<any>;

/** All primitive types accepted as children of a channel. */
export type ChannelChild = ChannelStatePrimitive | ChannelLifecycleChild;

/**
 * The `ctx` type available inside a channel handler. Provides access to
 * `ctx.send` (the channel's declared outgoing events) and optionally
 * `ctx.ack()` and `ctx.sendReplay()` if those primitives are registered.
 */
export type ChannelHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
  THasReplay extends boolean = false,
> = HandlerCtxFromState<ScopeState<'channel', TOutgoing, THasAck, THasReplay, { incoming: {}; outgoing: {}; requests: {}; streams: {}; channels: {}; namespaces: {} }, readonly [], Record<string, unknown>, never>>;

/**
 * The `ctx` type available inside a channel stream generator. Same as
 * `ChannelHandlerContext` but without the ack flag (streams cannot ack).
 */
export type ChannelStreamHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasReplay extends boolean = false,
> = StreamBaseCtxFromState<ScopeState<'channel', TOutgoing, false, THasReplay, { incoming: {}; outgoing: {}; requests: {}; streams: {}; channels: {}; namespaces: {} }, readonly [], Record<string, unknown>, never>>;

/**
 * The primitive type produced by `channel()`. Carries the channel pattern and
 * a frozen array of child primitives so the engine can set up routing and
 * dispatch for this channel scope.
 */
export interface ChannelPrimitive<
  TPattern extends ChannelPattern = ChannelPattern,
  TPrimitives extends readonly ChannelChild[] = readonly ChannelChild[],
  _TChannelName extends string = string,
  _TContract = unknown,
> extends Primitive<'channel'> {
  /** The pattern this channel matches against subscription paths. */
  readonly pattern: TPattern;
  /** The primitives that define this channel's behaviour. */
  readonly primitives: TPrimitives;
}

/** Unique symbol. The registration ID is the pattern key, so each pattern is its own singleton. */
const CHANNEL_KEY = Symbol('channel');

/**
 * Create a `ScopeDeclaration` for a dynamic channel name. A dynamic channel
 * name captures a parameter from the subscription path using a regex.
 *
 * The builder's `.channel(scope('roomId', /^room:(.+)$/))` call creates a
 * channel that matches subscriptions like `room:123`, capturing `123` as
 * `ctx.channel.roomId`.
 *
 * @param key     The parameter name exposed on `ctx.channel`.
 * @param pattern Regex matched against the raw subscription path. The first
 *   capture group becomes the value of `ctx.channel[key]`.
 */
export function scope<TKey extends string>(key: TKey, pattern: RegExp): ScopeDeclaration<TKey> {
  return { key, pattern };
}

/**
 * Creates a channel primitive. Packages a pattern and a set of child
 * primitives into a single scope primitive that the engine registers as a
 * named pub/sub channel inside a handler.
 *
 * In practice you rarely call `channel()` directly. Use it through the builder:
 * `server('name').channel('notifications')` — that method calls this factory
 * internally.
 *
 * @param pattern    A string or `ScopeDeclaration` identifying this channel.
 * @param primitives The outgoing events, handlers, lifecycle hooks, etc. that
 *   define the channel's behaviour.
 */
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

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
channel.__key = CHANNEL_KEY;
