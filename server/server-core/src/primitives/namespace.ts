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

export type NamespaceChild =
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

interface NamespaceScopeMethods {
  /**
   * The matched namespace name for the current handler call.
   */
  readonly namespaceName: string;
}

export type NamespaceHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  ServerHandlerContext<TOutgoing, false> & NamespaceScopeMethods;

export type NamespaceStreamHandlerContext<TOutgoing extends Record<string, any> = NoOutgoing> =
  StreamServerHandlerContext<TOutgoing> & NamespaceScopeMethods;

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
 * Typing rule: namespace-local `outgoing()` declarations must come before
 * the namespace handlers they type.
 */
export function namespace<
  TPattern extends string,
  O1 extends AnyOutgoing,
  TIncomingEvent extends string,
  TIncomingPayload,
>(
  pattern: TPattern,
  o1: O1,
  incomingPrimitive: IncomingPrimitive<
    TIncomingEvent,
    TIncomingPayload,
    NamespaceHandlerContext<OutgoingMap<[O1]>>
  >,
): NamespacePrimitive<
  TPattern,
  readonly [
    O1,
    IncomingPrimitive<TIncomingEvent, TIncomingPayload, NamespaceHandlerContext<OutgoingMap<[O1]>>>,
  ]
>;
export function namespace<
  TPattern extends string,
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
    NamespaceHandlerContext<OutgoingMap<[O1, O2]>>
  >,
  requestPrimitive: RequestPrimitive<
    TRequestEvent,
    TRequestPayload,
    TRequestResponse,
    NamespaceHandlerContext<OutgoingMap<[O1, O2]>>
  >,
  generatePrimitive: GeneratePrimitive<
    TStream,
    NamespaceStreamHandlerContext<OutgoingMap<[O1, O2]>>,
    any
  >,
): NamespacePrimitive<
  TPattern,
  readonly [
    O1,
    O2,
    IncomingPrimitive<
      TIncomingEvent,
      TIncomingPayload,
      NamespaceHandlerContext<OutgoingMap<[O1, O2]>>
    >,
    RequestPrimitive<
      TRequestEvent,
      TRequestPayload,
      TRequestResponse,
      NamespaceHandlerContext<OutgoingMap<[O1, O2]>>
    >,
    GeneratePrimitive<TStream, NamespaceStreamHandlerContext<OutgoingMap<[O1, O2]>>, any>,
  ]
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
