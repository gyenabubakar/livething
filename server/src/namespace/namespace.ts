/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { IncomingPrimitive } from '~/incoming/incoming.ts';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/intercept/intercept.ts';
import type { OutgoingPrimitive } from '~/outgoing/outgoing.ts';
import type { Primitive } from '~/primitive.ts';
import type { RequestPrimitive } from '~/request/request.ts';
import type { RecordedStreamGeneratePrimitive } from '~/stream-recorded/stream-recorded.ts';
import type { ResumableStreamGeneratePrimitive } from '~/stream-resumable/stream-resumable.ts';
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
  | AnyGenerate
  | ResumableStreamGeneratePrimitive
  | RecordedStreamGeneratePrimitive;

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
 * Internal primitive factory. The user-facing `namespace()` for declaring a
 * namespace in a contract lives at `~/namespace/definition.ts`. This factory
 * is called by the implementer's compile step to wrap a namespace's compiled
 * child primitives.
 */
export function namespace<
  const TPattern extends string,
  const TPrimitives extends readonly NamespaceChild[],
>(pattern: TPattern, ...primitives: TPrimitives): NamespacePrimitive<TPattern, TPrimitives> {
  return {
    __wskit: 'namespace',
    __kind: 'scope',
    __identity: [NAMESPACE_KEY, pattern],
    __requires: {},
    pattern,
    primitives: Object.freeze([...primitives]) as unknown as TPrimitives,
  };
}

/**
 * Symbol key used to reference this primitive in dependency declarations.
 */
namespace.__key = NAMESPACE_KEY;
