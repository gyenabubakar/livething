/* oxlint-disable @typescript-eslint/no-explicit-any */
import { definePrimitive } from '~/primitives/define.ts';
import type { Primitive } from '~/primitives/define.ts';
import type { IncomingPrimitive } from '~/primitives/incoming.ts';
import type { OutgoingPrimitive } from '~/primitives/outgoing.ts';
import type { RequestPrimitive } from '~/primitives/request.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/primitives/stream.ts';
import type {
  FoldState,
  HandlerCtxFromState,
  NoOutgoing,
  ScopeState,
  StreamBaseCtxFromState,
} from '~/types/scope-state.ts';

type AnyOutgoing = OutgoingPrimitive<string, any>;
type AnyIncoming = IncomingPrimitive<string, any, any>;
type AnyRequest = RequestPrimitive<string, any, any, any>;
type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
type NamespaceStatePrimitive = AnyOutgoing | AnyIncoming | AnyRequest | AnyGenerate;

type NamespaceHandlerCtx<TPrefix extends readonly NamespaceStatePrimitive[]> = HandlerCtxFromState<
  FoldState<TPrefix, ScopeState<'namespace'>>
>;

type NamespaceStreamBaseCtx<TPrefix extends readonly NamespaceStatePrimitive[]> =
  StreamBaseCtxFromState<FoldState<TPrefix, ScopeState<'namespace'>>>;

export type NamespaceChild = NamespaceStatePrimitive;

export type NamespaceHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  HandlerCtxFromState<ScopeState<'namespace', TOutgoing, false>>;

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
  incomingPrimitive: IncomingPrimitive<TIncomingEvent, TIncomingPayload, NamespaceHandlerCtx<[P1]>>,
): NamespacePrimitive<TPattern, readonly [P1, typeof incomingPrimitive]>;
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
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    NamespaceHandlerCtx<[P1, P2]>
  >,
  requestPrimitive: RequestPrimitive<
    TRequestEvent,
    TRequestPayload,
    TRequestResponse,
    NamespaceHandlerCtx<[P1, P2]>
  >,
  generatePrimitive: GeneratePrimitive<TStream, NamespaceStreamBaseCtx<[P1, P2]>, any>,
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
