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
 * The TypeScript type returned by `namespace()`. Holds the namespace name and
 * the child primitives that define its behaviour.
 */
export interface NamespacePrimitive<
  TPattern extends string = string,
  TPrimitives extends readonly NamespaceChild[] = readonly NamespaceChild[],
  _TName extends string = string,
  _TContract = unknown,
> extends Primitive<'namespace'> {
  /** The namespace name. Events declared inside are prefixed with this string. */
  readonly pattern: TPattern;
  /** The primitives that define this namespace's behaviour. */
  readonly primitives: TPrimitives;
}

/** Unique symbol. The registration ID is the namespace name, so each name is its own singleton. */
const NAMESPACE_KEY = Symbol('namespace');

/**
 * Creates a namespace primitive. Groups a set of events under a shared name
 * prefix so you can organize a server into logical sections (e.g. `chat`,
 * `presence`, `editor`) without opening multiple connections.
 *
 * Events declared inside a namespace are sent and received with the prefix
 * included (e.g. `chat/message`, `chat/typing`).
 *
 * In practice you rarely call `namespace()` directly. Use it through the
 * builder: `server('name').namespace('chat', (ns) => ...)` — that method calls
 * this factory internally and gives you a sub-builder scoped to the namespace.
 *
 * @param pattern    The namespace name / event prefix.
 * @param primitives The outgoing events, handlers, and interceptors for this namespace.
 *
 * @example
 * ```ts
 * // Builder form (typical):
 * base.namespace('chat', (ns) =>
 *   ns.outgoing(NewMessage).incoming(SendMessage, (ctx, p) => ctx.broadcast('new-message', p)),
 * );
 *
 * // Direct factory form (rare — for sharing namespace definitions):
 * const chat = namespace('chat', outgoing('new-message'));
 * base.use(chat);
 * ```
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
