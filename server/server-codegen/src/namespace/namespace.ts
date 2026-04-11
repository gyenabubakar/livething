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
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/intercept/intercept.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
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
type NamespaceStatePrimitive =
  | AnyOutgoing
  | AnyPreIntercept
  | AnyPostIntercept
  | AnyIncoming
  | AnyRequest
  | AnyGenerate;

type NamespaceIncoming<
  TPrefix extends readonly NamespaceStatePrimitive[],
  TEvent extends string,
  TPayload,
> = IncomingForPrefix<'namespace', TPrefix, TEvent, TPayload>;
type NamespaceRequest<
  TPrefix extends readonly NamespaceStatePrimitive[],
  TEvent extends string,
  TPayload,
  TResponse,
> = RequestForPrefix<'namespace', TPrefix, TEvent, TPayload, TResponse>;
type NamespaceGenerate<
  TPrefix extends readonly NamespaceStatePrimitive[],
  TStream extends StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
> = GenerateForPrefix<'namespace', TPrefix, TStream>;
type NamespacePreIntercept<TPrefix extends readonly NamespaceStatePrimitive[]> =
  PreInterceptForPrefix<'namespace', TPrefix>;
type NamespacePostIntercept<
  TPrefix extends readonly NamespaceStatePrimitive[],
  TIncoming extends IncomingPrimitive<string, any, any>,
> = PostInterceptForIncoming<'namespace', TPrefix, TIncoming>;

export type NamespaceChild = NamespaceStatePrimitive;

/**
 * The handler context type inside a namespace scope.
 *
 * Handlers inside a `namespace(...)` block receive this as `ctx`. It
 * includes the namespace-specific `ctx.namespace` scope API.
 */
export type NamespaceHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  HandlerCtxFromState<ScopeState<'namespace', TOutgoing, false>>;

/**
 * The stream handler context type inside a namespace scope.
 *
 * The base `ctx` type for `generate(...)` handlers inside a `namespace(...)`
 * block. Stream-local helpers are added on top by the stream declaration.
 */
export type NamespaceStreamHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  StreamBaseCtxFromState<ScopeState<'namespace', TOutgoing, false>>;

export interface NamespacePrimitive<
  TPattern extends string = string,
  TPrimitives extends readonly NamespaceChild[] = readonly NamespaceChild[],
> extends Primitive<'namespace'> {
  readonly pattern: TPattern;
  readonly primitives: TPrimitives;
}

const NAMESPACE_KEY = Symbol('namespace');

const _namespace = definePrimitive<
  'namespace',
  [pattern: string, ...primitives: NamespaceChild[]],
  { pattern: string; primitives: readonly NamespaceChild[] }
>({
  tag: 'namespace' as const,
  key: NAMESPACE_KEY,
  kind: 'scope' as const,
  registrationId(pattern: string) {
    return pattern;
  },
  create(pattern: string, ...primitives: NamespaceChild[]) {
    return {
      pattern,
      primitives: Object.freeze([...primitives]) as readonly NamespaceChild[],
    };
  },
});

/**
 * Group events under a routing-only scope within a single connection.
 *
 * Unlike channels, namespaces have no membership or subscription. They are
 * purely for organizing events under a prefix so handlers can be scoped
 * without pub/sub overhead.
 *
 * ```ts
 * namespace('notifications',
 *   outgoing('alert', t<{ text: string }>()),
 *   incoming(markRead, async (ctx, payload) => {
 *     ctx.namespace.send('alert', { text: 'Marked as read' });
 *   }),
 * )
 * ```
 *
 * Typing rule: namespace-local primitives that affect handler ctx must come
 * before the handlers they type.
 */
export function namespace<
  TPattern extends string,
  P1 extends NamespaceStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  pattern: TPattern,
  p1: P1,
  interceptPrimitive: NamespacePreIntercept<[P1]>,
  incomingPrimitive: NamespaceIncoming<
    AppendFoldable<[P1], typeof interceptPrimitive>,
    TIncomingEvent,
    TIncomingPayload
  >,
): NamespacePrimitive<TPattern, readonly [P1, typeof interceptPrimitive, typeof incomingPrimitive]>;
export function namespace<
  TPattern extends string,
  P1 extends NamespaceStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  pattern: TPattern,
  p1: P1,
  incomingPrimitive: NamespaceIncoming<[P1], TIncomingEvent, TIncomingPayload>,
): NamespacePrimitive<TPattern, readonly [P1, typeof incomingPrimitive]>;
export function namespace<
  TPattern extends string,
  P1 extends NamespaceStatePrimitive,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  pattern: TPattern,
  p1: P1,
  incomingPrimitive: NamespaceIncoming<[P1], TIncomingEvent, TIncomingPayload>,
  interceptPrimitive: NamespacePostIntercept<[P1], typeof incomingPrimitive>,
): NamespacePrimitive<TPattern, readonly [P1, typeof incomingPrimitive, typeof interceptPrimitive]>;
export function namespace<
  TPattern extends string,
  P1 extends NamespaceStatePrimitive,
  P2 extends NamespaceStatePrimitive,
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
  incomingPrimitive: NamespaceIncoming<[P1, P2], TIncomingEvent, TIncomingPayload>,
  requestPrimitive: NamespaceRequest<[P1, P2], TRequestEvent, TRequestPayload, TRequestResponse>,
  generatePrimitive: NamespaceGenerate<[P1, P2], TStream>,
): NamespacePrimitive<
  TPattern,
  readonly [P1, P2, typeof incomingPrimitive, typeof requestPrimitive, typeof generatePrimitive]
>;
export function namespace<
  const TPattern extends string,
  const TPrimitives extends readonly NamespaceChild[],
>(pattern: TPattern, ...primitives: TPrimitives): NamespacePrimitive<TPattern, TPrimitives>;
export function namespace(pattern: string, ...primitives: NamespaceChild[]): NamespacePrimitive {
  return _namespace(pattern, ...primitives) as unknown as NamespacePrimitive;
}

/** Dependency ref — use in `dependencies: [namespace]` to assert it's registered. */
namespace.__key = NAMESPACE_KEY;
