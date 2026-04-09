/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ChannelPrimitive, ScopeDeclaration } from '~/channel/index.ts';
import type { ModuleInstance } from '~/define-module.ts';
import type { ErrorsPrimitive } from '~/errors/index.ts';
import type { IncomingPrimitive } from '~/incoming/index.ts';
import type { PostInterceptPrimitive, PreInterceptPrimitive } from '~/intercept/index.ts';
import type { NamespacePrimitive } from '~/namespace/index.ts';
import type { OutgoingPrimitive } from '~/outgoing/index.ts';
import type { RequiresManifest } from '~/primitive.ts';
import type { RequestPrimitive } from '~/request/index.ts';
import type { ScheduledPrimitive } from '~/scheduled/index.ts';
import type { GeneratePrimitive, NudgeDeclaration, StreamPrimitive } from '~/stream/index.ts';

export type AnyOutgoing = OutgoingPrimitive<string, any>;
export type AnyIncoming = IncomingPrimitive<string, any, any>;
export type AnyRequest = RequestPrimitive<string, any, any, any>;
export type AnyGenerate = GeneratePrimitive<
  StreamPrimitive<string, any, any, readonly NudgeDeclaration[]>,
  any,
  any
>;
export type AnyPreIntercept = PreInterceptPrimitive<any>;
export type AnyPostIntercept = PostInterceptPrimitive<string, any, any>;
export type AnyScheduled = ScheduledPrimitive<string, any, any>;
export type AnyModule = ModuleInstance<string, any, any, readonly AnyOutgoing[], readonly any[]>;

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
  pattern: string | ScopeDeclaration<string>;
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
  errors: ErrorsPrimitive<any>[];
  ack: boolean;
  requires: RequiresManifest;
}

export type {
  ChannelPrimitive,
  ErrorsPrimitive,
  NamespacePrimitive,
  OutgoingPrimitive,
  RequestPrimitive,
  RequiresManifest,
  ScopeDeclaration,
};
