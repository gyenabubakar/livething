/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WSKitConfigError } from '@wskit/core';
import {
  compileChannelPrimitive,
  validateChannelFamilyPatternsDisjointFromStaticNames,
} from '~/channel/compile.ts';
import { compileChannelTemplate } from '~/channel/template.ts';
import type { CompiledChannel, CompiledServer } from '~/_engine/compile/types.ts';
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
 * Extract the `{name}` parameters from a channel template literal type as an
 * object of string values. Best-effort: escaped braces (`{{`/`}}`) are not
 * modelled at the type level — the runtime parser handles them, so a template
 * that uses literal braces may infer a param the runtime ignores (or vice
 * versa). That trade-off keeps the type tractable; the runtime is the source of
 * truth.
 *
 * @example
 * ```ts
 * type A = ExtractParams<'room:{id}'>;          // { id: string }
 * type B = ExtractParams<'org:{org}/t:{tid}'>;  // { org: string; tid: string }
 * type C = ExtractParams<'lobby'>;              // {}
 * ```
 */
export type ExtractParams<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name extends `${string}{${string}`
    ? ExtractParams<Rest>
    : Name extends ''
      ? ExtractParams<Rest>
      : Record<Name, string> & ExtractParams<Rest>
  : {};

/**
 * A named dynamic channel pattern used in `scope()`. Groups many matching
 * subscription paths under one channel family.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { channels } from '@wskit/server/channels';
 *
 * const base = define({ capabilities: [channels()] });
 *
 * // A `[familyKey, pattern]` tuple declares a channel family that matches
 * // `room:<anything>` subscriptions. The family key ('rooms') is used in
 * // `ctx.channels.get(key, name)` lookups.
 * const rooms = base.channel(['rooms', 'room:{id}']);
 *
 * rooms.subscribe((ctx) => {
 *   // ctx.channel.family is the family key ('rooms')
 *   // ctx.channel.name is the matched path (e.g. 'room:alpha-42')
 *   // ctx.channel.params.id is the captured segment (e.g. 'alpha-42')
 * });
 * ```
 */
export interface ScopeDeclaration<
  TKey extends string = string,
  // Phantom: carries the inferred `{name}` param shape so `ctx.channel.params`
  // can be typed. Never read at runtime.
  TParams = Record<string, string>,
> {
  /** Identifier for this channel family. Used with `ctx.channels.get(key, name)` lookups. */
  readonly key: TKey;
  /** The original template string (e.g. `'room:{id}'`). Kept for reconstruction. */
  readonly template: string;
  /** The compiled matcher, built only from escaped literals and named groups. */
  readonly pattern: RegExp;
  /** Capture names declared by the template, in order. */
  readonly paramNames: readonly string[];
  /** @internal phantom — the inferred param shape; never set at runtime. */
  readonly __params?: TParams;
}

/**
 * The argument accepted by `channel()`. Either a plain string for exact channel
 * names (e.g. `'notifications'`) or a `ScopeDeclaration` for dynamic names
 * that match many paths under one family (e.g. `scope('rooms', 'room:{id}')`).
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
  /**
   * The capability kinds this channel's own `capabilities` list declares
   * (e.g. `inbox()`, `readReceipts()`). Read by `resolveCapabilityRequirements`
   * as the channel's local requirement scope. Attached after construction by
   * `ChannelBuilder`, since the factory here has no view of a channel's
   * capabilities list. @internal
   */
  readonly __capabilityKinds?: ReadonlySet<string>;
  /**
   * Build-seam: compile this channel primitive into a `CompiledChannel`. Carried
   * on the primitive so the core compile step never imports the channel compile
   * code; a handler with no channels ships none of it. @internal
   */
  readonly __compile: (primitive: ChannelPrimitive) => CompiledChannel;
  /**
   * Build-seam: reject a family pattern that overlaps a static channel name.
   * Carried here for the same reason as `__compile`. @internal
   */
  readonly __validateDisjoint: (compiled: CompiledServer) => void;
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
    throw new WSKitConfigError(
      `${source} requires a non-empty key — got ${JSON.stringify(declaration.key)}.`,
    );
  }
  if (!(declaration.pattern instanceof RegExp) || typeof declaration.template !== 'string') {
    throw new WSKitConfigError(
      `${source} requires a compiled template — build it with scope(key, template), ` +
        `not a hand-rolled object.`,
    );
  }
}

/**
 * Create a `ScopeDeclaration` for a dynamic channel family. A dynamic channel
 * matches many subscription paths against one template and groups them under a
 * single family key.
 *
 * In the authoring API you declare a family with a `[familyKey, pattern]`
 * tuple: `base.channel(['rooms', 'room:{id}'])` matches subscriptions like
 * `room:general`, `room:alpha-42`, etc. The full matched string is available at
 * `ctx.channel.name`, the family key at `ctx.channel.family`, and each `{name}`
 * capture at `ctx.channel.params.name`.
 *
 * The template grammar is just literals plus `{name}` captures (`{{`/`}}` for a
 * literal brace). wskit compiles it to a linear-time matcher itself, so unlike a
 * raw regex it can never trigger catastrophic backtracking.
 *
 * @param key      Family identifier. Used as the first tuple element in
 *   `base.channel([key, pattern])` and in `ctx.channels.get(key, name)` lookups.
 * @param template Pattern matched against the subscription path, e.g.
 *   `'room:{id}'` or `'org:{org}/thread:{tid}'`. Each `{name}` matches one or
 *   more characters; a literal must separate two adjacent params.
 *
 * @example
 * ```ts
 * const rooms = base.channel(['rooms', 'room:{id}']);
 * // ctx.channel.name      → 'room:alpha-42'
 * // ctx.channel.family    → 'rooms'
 * // ctx.channel.params.id → 'alpha-42'
 * ```
 */
export function scope<TKey extends string, const TTemplate extends string>(
  key: TKey,
  template: TTemplate,
): ScopeDeclaration<TKey, ExtractParams<TTemplate>> {
  const compiled = compileChannelTemplate(template, 'scope()');
  const declaration: ScopeDeclaration<TKey, ExtractParams<TTemplate>> = {
    key,
    template: compiled.template,
    pattern: compiled.regex,
    paramNames: compiled.paramNames,
  };
  assertValidScopeDeclaration(declaration, 'scope()');
  return declaration;
}

/**
 * Internal primitive factory. The user-facing channel builder lives at
 * `base.channel(...)`. This factory is called by the definition compiler to
 * wrap a channel's assembled child primitives.
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
      throw new WSKitConfigError(
        `channel() requires a non-empty name — got ${JSON.stringify(pattern)}.`,
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
    __compile: compileChannelPrimitive,
    __validateDisjoint: validateChannelFamilyPatternsDisjointFromStaticNames,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
channel.__key = CHANNEL_KEY;
