/* oxlint-disable @typescript-eslint/no-explicit-any */
import type {
  HandlerCtxFromState,
  NoOutgoing,
  ScopeState,
  StreamBaseCtxFromState,
} from '~/_types/scope-state.ts';
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/intercept/intercept.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/stream/stream.ts';

// Internal aliases that keep the union types below readable.
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
 * Every primitive type accepted as a child of a namespace. Namespaces support
 * all handler and contract primitives but not channel-only features like replay
 * or subscribe/unsubscribe lifecycle hooks.
 */
export type NamespaceChild =
  | AnyOutgoing
  | AnyPreIntercept
  | AnyPostIntercept
  | AnyIncoming
  | AnyRequest
  | AnyGenerate;

/**
 * The `ctx` type available inside a namespace handler. Provides access to
 * `ctx.send` (the namespace's declared outgoing events).
 */
export type NamespaceHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  HandlerCtxFromState<
    ScopeState<
      'namespace',
      TOutgoing,
      false,
      false,
      { incoming: {}; outgoing: {}; requests: {}; streams: {}; channels: {}; namespaces: {} },
      readonly [],
      Record<string, unknown>,
      never
    >
  >;

/**
 * The `ctx` type available inside a namespace stream generator.
 */
export type NamespaceStreamHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  StreamBaseCtxFromState<
    ScopeState<
      'namespace',
      TOutgoing,
      false,
      false,
      { incoming: {}; outgoing: {}; requests: {}; streams: {}; channels: {}; namespaces: {} },
      readonly [],
      Record<string, unknown>,
      never
    >
  >;

/**
 * The primitive type produced by `namespace()`. Carries the namespace name and
 * a frozen array of child primitives so the engine can set up event prefix
 * routing for this namespace scope.
 */
export interface NamespacePrimitive<
  TPattern extends string = string,
  TPrimitives extends readonly NamespaceChild[] = readonly NamespaceChild[],
  _TName extends string = string,
  _TContract = unknown,
> extends Primitive<'namespace'> {
  /** The namespace name used as the event prefix at the wire level. */
  readonly pattern: TPattern;
  /** The primitives that define this namespace's behaviour. */
  readonly primitives: TPrimitives;
}

/** Unique symbol. The registration ID is the namespace name, so each name is its own singleton. */
const NAMESPACE_KEY = Symbol('namespace');

/**
 * Creates a namespace primitive. Packages a name and a set of child primitives
 * into a single scope primitive that the engine registers as a named event
 * prefix group inside a handler.
 *
 * All events declared inside a namespace are prefixed with the namespace name
 * at the wire level (e.g., `chat/message`, `chat/typing`). Clients send and
 * receive events using the full prefixed names.
 *
 * In practice you rarely call `namespace()` directly. Use it through the
 * builder: `server('name').namespace('chat')` — that method calls this factory.
 *
 * @param pattern    The namespace name / event prefix.
 * @param primitives The outgoing events, handlers, and interceptors for this namespace.
 */
export function namespace<
  const TPattern extends string,
  const TPrimitives extends readonly NamespaceChild[],
>(pattern: TPattern, ...primitives: TPrimitives): NamespacePrimitive<TPattern, TPrimitives> {
  return {
    __wskit: 'namespace',
    __kind: 'scope',
    __identity: [NAMESPACE_KEY, pattern],
    __dependencies: [],
    __requires: {},
    pattern,
    primitives: Object.freeze([...primitives]) as unknown as TPrimitives,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
namespace.__key = NAMESPACE_KEY;
