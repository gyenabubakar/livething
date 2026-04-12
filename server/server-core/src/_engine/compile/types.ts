/* oxlint-disable @typescript-eslint/no-explicit-any */
import type * as ChannelPrimitive from '~/channel/index.ts';
import type * as IncomingPrimitive from '~/incoming/index.ts';
import type * as InterceptPrimitive from '~/intercept/index.ts';
import type * as DefineModule from '~/modules/define.ts';
import type * as NamespacePrimitive from '~/namespace/index.ts';
import type * as OutgoingPrimitive from '~/outgoing/index.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as RequestPrimitive from '~/request/index.ts';
import type * as ScheduledPrimitive from '~/scheduled/index.ts';
import type * as StreamPrimitive from '~/stream/index.ts';

// ---------------------------------------------------------------------------
// Widened type aliases — used throughout the compile and runtime layers so
// generic parameters don't leak into every function signature. Each alias
// erases the specific event name, payload, and handler types to `any` while
// keeping the structural shape intact.
// ---------------------------------------------------------------------------

/** Any `.outgoing()` declaration, regardless of event name or payload type. */
export type AnyOutgoing = OutgoingPrimitive.OutgoingPrimitive<string, any>;
/** Any `.incoming()` handler, regardless of event name or payload type. */
export type AnyIncoming = IncomingPrimitive.IncomingPrimitive<string, any, any>;
/** Any `.reply()` handler, regardless of event, payload, or response type. */
export type AnyRequest = RequestPrimitive.RequestPrimitive<string, any, any, any>;
/** Any `.generate()` handler attached to a stream declaration. */
export type AnyGenerate = StreamPrimitive.GeneratePrimitive<
  StreamPrimitive.StreamPrimitive<string, any, any, readonly StreamPrimitive.NudgeDeclaration[]>,
  any,
  any
>;
/** Any pre-validation `.intercept()` primitive. */
export type AnyPreIntercept = InterceptPrimitive.PreInterceptPrimitive<any>;
/** Any post-validation `.intercept(event, handler)` primitive. */
export type AnyPostIntercept = InterceptPrimitive.PostInterceptPrimitive<string, any, any>;
/** Any `.scheduled()` task declaration. */
export type AnyScheduled = ScheduledPrimitive.ScheduledPrimitive<string, any, any>;
/** Any installed module instance from `defineModule(...)`. */
export type AnyModule = DefineModule.ModuleInstance<
  string,
  any,
  any,
  readonly AnyOutgoing[],
  readonly any[]
>;
/** Widened `.namespace()` primitive type for the compile layer. */
export type NamespacePrimitiveType = NamespacePrimitive.NamespacePrimitive;
/** Widened `.channel()` primitive type for the compile layer. */
export type ChannelPrimitiveType = ChannelPrimitive.ChannelPrimitive;
/** Adapter dependency manifest — which platform features a primitive needs. */
export type RequiresManifest = PrimitiveCore.RequiresManifest;

/**
 * Precomputed namespace view used by the runtime for fast event lookup.
 */
export interface CompiledNamespace {
  kind: 'namespace';
  name: string;
  outgoing: Map<string, AnyOutgoing>;
  incoming: Map<string, AnyIncoming>;
  requests: Map<string, AnyRequest>;
  streams: Map<string, AnyGenerate>;
  preIntercepts: AnyPreIntercept[];
  postIntercepts: Map<string, AnyPostIntercept[]>;
}

/**
 * Precomputed channel or channel-family view used by the runtime.
 */
export interface CompiledChannel {
  kind: 'channel';
  key: string;
  pattern: string | ChannelPrimitive.ScopeDeclaration<string>;
  outgoing: Map<string, AnyOutgoing>;
  incoming: Map<string, AnyIncoming>;
  requests: Map<string, AnyRequest>;
  streams: Map<string, AnyGenerate>;
  preIntercepts: AnyPreIntercept[];
  postIntercepts: Map<string, AnyPostIntercept[]>;
}

/**
 * Flattened server definition the engine executes at runtime.
 *
 * The compile step converts the declarative primitive list into maps and flags
 * so the runtime can answer questions quickly while messages are flowing.
 */
export interface CompiledServer {
  outgoing: Map<string, AnyOutgoing>;
  incoming: Map<string, AnyIncoming>;
  requests: Map<string, AnyRequest>;
  streams: Map<string, AnyGenerate>;
  preIntercepts: AnyPreIntercept[];
  postIntercepts: Map<string, AnyPostIntercept[]>;
  namespaces: Map<string, CompiledNamespace>;
  channels: Map<string, CompiledChannel>;
  channelFamilies: Map<string, CompiledChannel>;
  scheduled: Map<string, AnyScheduled>;
  modules: AnyModule[];
  requires: RequiresManifest;
}

export type { ChannelPrimitive, NamespacePrimitive, OutgoingPrimitive, RequestPrimitive };
