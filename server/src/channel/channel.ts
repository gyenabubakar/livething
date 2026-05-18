/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WskitConfigError } from '@wskit/core';
import type {
  BeforeSubscribePrimitive,
  SubscribePrimitive,
  UnsubscribePrimitive,
} from '~/channel/lifecycle.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/intercept/intercept.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type { CustomReplayPrimitive } from '~/replay/custom/custom.ts';
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
 * A named dynamic channel pattern used in `scope()`.
 * Groups many matching subscription paths under one channel family.
 *
 * @example
 * ```ts
 * import { server, scope } from '@wskit/server';
 * import { withChannels } from '@wskit/server/channels';
 *
 * // Declare a channel family that matches `room:<anything>` subscriptions.
 * // The `key` ('rooms') is the family name you use in handlers.
 * withChannels(server('app')).channel(scope('rooms', /^room:.+$/), (ch) =>
 *   ch.onSubscribe((ctx) => {
 *     // Inside a handler, the family key is on ctx.channel.scope and the
 *     // matched channel name is on ctx.channel.name.
 *     console.log(ctx.channel.scope); // → 'rooms'
 *     console.log(ctx.channel.name);  // → e.g. 'room:alpha-42' (the actual match)
 *
 *     // List every connection subscribed to any channel in this family:
 *     const members = ctx.channels.members('rooms');
 *   }),
 * );
 * ```
 */
export interface ScopeDeclaration<TKey extends string = string> {
  /** Identifier for this channel family. Used with `ctx.channels.members(key)`. */
  readonly key: TKey;
  /** Regular expression matched against the subscription path. */
  readonly pattern: RegExp;
}

/**
 * The argument accepted by `channel()`. Either a plain string for exact channel
 * names (e.g. `'notifications'`) or a `ScopeDeclaration` for dynamic names
 * that match many paths under one family (e.g. `scope('rooms', /^room:.+$/)`).
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
 * The TypeScript type returned by `channel()`. Holds the channel pattern and
 * the child primitives that define the channel's behaviour.
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
 * matches many subscription paths against one regex and groups them under a
 * single scope identifier.
 *
 * The builder's `.channel(scope('rooms', /^room:.+$/))` call creates a channel
 * family that matches subscriptions like `room:general`, `room:alpha-42`, etc.
 * The full matched string is available at `ctx.channel.name` — slice or
 * re-match it yourself if you need a parameter out of the path.
 *
 * @param key     Identifier for this channel family. Pass it to
 *   `ctx.channels.members(key)` to list everyone subscribed to channels that
 *   match the pattern.
 * @param pattern Regex matched against the subscription path. Anchor it with
 *   `^` and `$` so it matches the full name. The pattern must run in linear
 *   time on attacker-controlled input. `scope()` rejects nested unbounded
 *   quantifiers like `(a+)+`, `(\w+)+`, `(a*)*` because such shapes let one
 *   crafted subscription frame stall the runtime via regex backtracking.
 *
 * @example
 * ```ts
 * // Match any room:* subscription. Inside the handler:
 * // ctx.channel.name === 'room:alpha-42'
 * // const roomId = ctx.channel.name.slice('room:'.length);
 * base.channel(scope('rooms', /^room:.+$/), (ch) => ...)
 * ```
 */
/**
 * Validate a `ScopeDeclaration` (key + pattern). Used by `scope()` for the
 * friendly call-site error and by `channel()` so a hand-rolled scope-shaped
 * object cannot bypass the same check.
 */
function assertValidScopeDeclaration(declaration: ScopeDeclaration<string>, source: string): void {
  if (typeof declaration.key !== 'string' || declaration.key.trim() === '') {
    throw new WskitConfigError(
      `[wskit] ${source} requires a non-empty key — got ${JSON.stringify(declaration.key)}.`,
    );
  }
  if (!(declaration.pattern instanceof RegExp)) {
    throw new WskitConfigError(
      `[wskit] ${source} requires a RegExp pattern — got ${JSON.stringify(declaration.pattern)}.`,
    );
  }
  if (declaration.pattern.global || declaration.pattern.sticky) {
    throw new WskitConfigError(
      `${source} ("${declaration.key}", ...): regex flags "g" and "y" are not allowed because ` +
        `they make RegExp.prototype.test stateful, which causes scope-pattern ` +
        `checks to alternate between match and no-match for the same input. ` +
        `Use the same pattern without the "g" or "y" flag.`,
    );
  }
  if (CATASTROPHIC_BACKTRACK_SHAPE.test(declaration.pattern.source)) {
    throw new WskitConfigError(
      `${source} ("${declaration.key}", ...): regex source /${declaration.pattern.source}/ ` +
        `contains a nested unbounded quantifier (shapes like (...+)+, (...*)*, (...+)*, (...*)+). ` +
        `Inputs that nearly match such a pattern force the regex engine into ` +
        `exponential backtracking, which freezes the runtime per attempt. ` +
        `Flatten the inner group, anchor it with a bounded quantifier, or split into ` +
        `multiple linear-time patterns. See the scope() docs for guidance.`,
    );
  }
}

// Matches a group whose body contains an unbounded quantifier and which is
// itself followed by an unbounded quantifier — (a+)+, (\w+)+, (a*)*, (a+|b)+
// and similar shapes that send regex backtracking exponential on near-match
// input.
const CATASTROPHIC_BACKTRACK_SHAPE = /\([^)]*[+*][^)]*\)[+*]/;

export function scope<TKey extends string>(key: TKey, pattern: RegExp): ScopeDeclaration<TKey> {
  const declaration = { key, pattern };
  assertValidScopeDeclaration(declaration, 'scope()');
  return declaration;
}

/**
 * Creates a channel primitive. Packages a pattern and a set of child
 * primitives into a single scope primitive that the engine registers as a
 * named pub/sub channel inside a handler.
 *
 * In practice you rarely call `channel()` directly. Use it through the builder:
 * `server('name').channel('notifications', (ch) => ...)` — that method calls
 * this factory internally and gives you a sub-builder scoped to the channel.
 *
 * @param pattern    A string (static channel name) or a `ScopeDeclaration`
 *   produced by {@link scope} for dynamic channels matching many paths.
 * @param primitives The outgoing events, handlers, lifecycle hooks, etc. that
 *   define the channel's behaviour.
 *
 * @example
 * ```ts
 * // Builder form (typical):
 * base.channel('notifications', (ch) =>
 *   ch.outgoing(Notify).incoming(Ping, (ctx) => ctx.channel.broadcast('notify', {})),
 * );
 *
 * // Direct factory form (rare — for sharing channel definitions):
 * const notifications = channel('notifications', outgoing('notify'));
 * base.use(notifications);
 * ```
 */
export function channel<
  const TPattern extends ChannelPattern,
  const TPrimitives extends readonly ChannelChild[],
>(pattern: TPattern, ...primitives: TPrimitives): ChannelPrimitive<TPattern, TPrimitives> {
  if (typeof pattern === 'string') {
    if (pattern.trim() === '') {
      throw new WskitConfigError(
        `[wskit] channel() requires a non-empty name — got ${JSON.stringify(pattern)}.`,
      );
    }
  } else {
    assertValidScopeDeclaration(pattern, 'channel()');
  }
  return {
    __wskit: 'channel',
    __kind: 'scope',
    __identity: [CHANNEL_KEY, typeof pattern === 'string' ? pattern : pattern.key],
    __requires: {},
    pattern,
    primitives: Object.freeze([...primitives]) as unknown as TPrimitives,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
channel.__key = CHANNEL_KEY;
