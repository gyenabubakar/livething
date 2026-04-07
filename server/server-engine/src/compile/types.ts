/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ChannelPrimitive, ScopeDeclaration } from '@wskit/server-codegen/channel';
import type { ErrorsPrimitive } from '@wskit/server-codegen/errors/errors';
import type { IncomingPrimitive } from '@wskit/server-codegen/incoming';
import type {
  PostInterceptPrimitive,
  PreInterceptPrimitive,
} from '@wskit/server-codegen/intercept';
import type { ModuleInstance } from '@wskit/server-codegen/internal/define-module';
import type {
  BeforeSubscribePrimitive,
  BinaryPrimitive,
  ConnectPrimitive,
  DisconnectPrimitive,
  ErrorPrimitive,
  InitPrimitive,
  ShutdownPrimitive,
  SubscribePrimitive,
  UnsubscribePrimitive,
  UpgradePrimitive,
  ValidationErrorPrimitive,
} from '@wskit/server-codegen/lifecycle';
import type { NamespacePrimitive } from '@wskit/server-codegen/namespace';
import type { OutgoingPrimitive } from '@wskit/server-codegen/outgoing';
import type { RequiresManifest } from '@wskit/server-codegen/primitive';
import type { ReplayPrimitive } from '@wskit/server-codegen/replay';
import type { RequestPrimitive } from '@wskit/server-codegen/request';
import type { ScheduledPrimitive } from '@wskit/server-codegen/scheduled';
import type {
  GeneratePrimitive,
  NudgeDeclaration,
  StreamPrimitive,
} from '@wskit/server-codegen/stream';

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
  replay?: ReplayPrimitive<any>;
  onBeforeSubscribe?: BeforeSubscribePrimitive<any, any>;
  onSubscribe?: SubscribePrimitive<any>;
  onUnsubscribe?: UnsubscribePrimitive<any>;
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
  sequence: boolean;
  dedup: boolean;
  replay?: ReplayPrimitive<any>;
  heartbeatTimeout?: number;
  hibernationEnabled: boolean;
  lifecycle: {
    onInit?: InitPrimitive<any>;
    onConnect?: ConnectPrimitive<any>;
    onDisconnect?: DisconnectPrimitive<any>;
    onShutdown?: ShutdownPrimitive<any>;
    onError?: ErrorPrimitive<any>;
    onUpgrade?: UpgradePrimitive;
    onBinary?: BinaryPrimitive<any>;
    onValidationError?: ValidationErrorPrimitive<any>;
  };
  requires: RequiresManifest;
}

export type {
  BeforeSubscribePrimitive,
  BinaryPrimitive,
  ChannelPrimitive,
  ConnectPrimitive,
  DisconnectPrimitive,
  ErrorPrimitive,
  ErrorsPrimitive,
  InitPrimitive,
  NamespacePrimitive,
  OutgoingPrimitive,
  RequestPrimitive,
  RequiresManifest,
  ScopeDeclaration,
  ShutdownPrimitive,
  SubscribePrimitive,
  UnsubscribePrimitive,
  UpgradePrimitive,
  ValidationErrorPrimitive,
};
