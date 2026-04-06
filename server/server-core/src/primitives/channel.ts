/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitives/define.ts';
import type { ServerHandlerContext, StreamServerHandlerContext } from '~/define-server.ts';
import type { Primitive } from '~/primitives/define.ts';
import type { IncomingPrimitive } from '~/primitives/incoming.ts';
import type { OutgoingPrimitive } from '~/primitives/outgoing.ts';
import type { RequestPrimitive } from '~/primitives/request.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/primitives/stream.ts';

type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;

export interface ScopeDeclaration<TKey extends string = string> {
  readonly key: TKey;
  readonly pattern: RegExp;
}

export type ChannelPattern = string | ScopeDeclaration<string>;

export type ChannelChild =
  | AnyOutgoing
  | IncomingPrimitive<string, any, any>
  | RequestPrimitive<string, any, any, any>
  | AnyGenerate;

type NoOutgoing = Record<never, never>;

type OutgoingPayload<TOutgoing extends AnyOutgoing> =
  TOutgoing extends OutgoingPrimitive<string, infer TPayload> ? TPayload : never;

type OutgoingMap<TOutgoing extends readonly AnyOutgoing[]> = {
  [TItem in TOutgoing[number] as TItem['event']]: OutgoingPayload<TItem>;
};

interface ChannelScopeMethods {
  /**
   * The current channel name for this handler call.
   */
  readonly channelName: string;
}

export type ChannelHandlerContext<
  TOutgoing extends Record<string, any> = NoOutgoing,
  THasAck extends boolean = false,
> = ServerHandlerContext<TOutgoing, THasAck> & ChannelScopeMethods;

export type ChannelStreamHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  StreamServerHandlerContext<TOutgoing> & ChannelScopeMethods;

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
 * Typing rule: channel-local `outgoing()` declarations must come before
 * the channel handlers they type.
 */
export function channel<
  TPattern extends ChannelPattern,
  O1 extends AnyOutgoing,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  pattern: TPattern,
  o1: O1,
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    ChannelHandlerContext<OutgoingMap<[O1]>, false>
  >,
): ChannelPrimitive<
  TPattern,
  readonly [
    O1,
    IncomingPrimitive<
      TIncomingEvent,
      TIncomingPayload,
      ChannelHandlerContext<OutgoingMap<[O1]>, false>
    >,
  ]
>;
export function channel<
  TPattern extends ChannelPattern,
  O1 extends AnyOutgoing,
  O2 extends AnyOutgoing,
  TStream extends StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  TIncomingEvent extends string,
  TIncomingPayload,
  TRequestEvent extends string,
  TRequestPayload,
  TRequestResponse,
>(
  pattern: TPattern,
  o1: O1,
  o2: O2,
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    ChannelHandlerContext<OutgoingMap<[O1, O2]>, false>
  >,
  requestPrimitive: RequestPrimitive<
    TRequestEvent,
    TRequestPayload,
    TRequestResponse,
    ChannelHandlerContext<OutgoingMap<[O1, O2]>, false>
  >,
  generatePrimitive: GeneratePrimitive<
    TStream,
    ChannelStreamHandlerContext<OutgoingMap<[O1, O2]>>,
    any
  >,
): ChannelPrimitive<
  TPattern,
  readonly [
    O1,
    O2,
    IncomingPrimitive<
      TIncomingEvent,
      TIncomingPayload,
      ChannelHandlerContext<OutgoingMap<[O1, O2]>, false>
    >,
    RequestPrimitive<
      TRequestEvent,
      TRequestPayload,
      TRequestResponse,
      ChannelHandlerContext<OutgoingMap<[O1, O2]>, false>
    >,
    GeneratePrimitive<TStream, ChannelStreamHandlerContext<OutgoingMap<[O1, O2]>>, any>,
  ]
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
