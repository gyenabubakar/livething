/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WskitConfigError } from '@wskit/core';
import type {
  CheckPrimitive,
  CommitPrimitive,
  SubscribePrimitive,
  UnsubscribePrimitive,
} from '~/channel/lifecycle.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { InterceptPrimitive } from '~/intercept/intercept.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type { CustomReplayPrimitive } from '~/replay/custom/custom.ts';
import type { ReplayPrimitive } from '~/replay/replay.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { RecordedStreamGeneratePrimitive } from '~/stream-recorded/stream-recorded.ts';
import type { ResumableStreamGeneratePrimitive } from '~/stream-resumable/stream-resumable.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/stream/stream.ts';

// Internal aliases that keep the union type below readable.
type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyIntercept = InterceptPrimitive<any>;
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
  | AnyIntercept
  | AnyIncoming
  | AnyRequest
  | AnyGenerate
  | ResumableStreamGeneratePrimitive
  | RecordedStreamGeneratePrimitive;

/**
 * A named dynamic channel pattern used in `scope()`. Groups many matching
 * subscription paths under one channel family.
 *
 * @example
 * ```ts
 * import { contract, implement, channel, scope } from '@wskit/server';
 *
 * // Declare a channel family that matches `room:<anything>` subscriptions.
 * // The `key` ('rooms') is the family name used in handlers.
 * const app = contract<Env>('app')({
 *   definitions: [
 *     channel(scope('rooms', /^room:.+$/), {
 *       definitions: [],
 *     }),
 *   ],
 * });
 *
 * implement(app).channel('rooms', (ch) =>
 *   ch.onSubscribe((ctx) => {
 *     // ctx.channel.scope is the family key ('rooms')
 *     // ctx.channel.name is the matched path (e.g. 'room:alpha-42')
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
  | CheckPrimitive<any, any, any>
  | CommitPrimitive<any, any>
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

/**
 * Create a `ScopeDeclaration` for a dynamic channel family. A dynamic channel
 * matches many subscription paths against one regex and groups them under a
 * single family key.
 *
 * Pass the result as the first argument to `channel(...)` inside `definitions`.
 * `channel(scope('rooms', /^room:.+$/), { definitions: [...] })` creates a
 * family that matches subscriptions like `room:general`, `room:alpha-42`, etc.
 * The full matched string is available at `ctx.channel.name`; the family key
 * is at `ctx.channel.scope`. Slice the name yourself if you need a sub-path.
 *
 * @param key     Family identifier. Passed to `implement(c).channel(key, ch => ...)`
 *   and used in `ctx.channels.get(key, name)` lookups.
 * @param pattern Regex matched against the subscription path. Anchor with `^`
 *   and `$` so it matches the full name. `scope()` rejects nested unbounded
 *   quantifiers like `(a+)+` and `(\w+)+` that could freeze the runtime on
 *   near-miss input via regex backtracking.
 *
 * @example
 * ```ts
 * import { contract, channel, scope } from '@wskit/server';
 *
 * const app = contract<Env>('app')({
 *   definitions: [
 *     channel(scope('rooms', /^room:.+$/), { definitions: [] }),
 *   ],
 * });
 * // ctx.channel.name → 'room:alpha-42'
 * // ctx.channel.scope → 'rooms'
 * ```
 */
export function scope<TKey extends string>(key: TKey, pattern: RegExp): ScopeDeclaration<TKey> {
  const declaration = { key, pattern };
  assertValidScopeDeclaration(declaration, 'scope()');
  return declaration;
}

/**
 * Internal primitive factory. The user-facing `channel()` for declaring a
 * channel in a contract lives at `~/channel/definition.ts`. This factory is
 * called by the implementer's compile step to wrap a channel's compiled
 * child primitives.
 *
 * @param pattern A string (static channel name) or a `ScopeDeclaration` from
 *   `scope()` for dynamic families that match many subscription paths.
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
