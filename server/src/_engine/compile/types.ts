/* oxlint-disable @typescript-eslint/no-explicit-any */
import type * as ChannelPrimitive from '~/channel/channel.ts';
import type * as IncomingPrimitive from '~/incoming/index.ts';
import type * as InterceptPrimitive from '~/intercept/intercept.ts';
import type * as NamespacePrimitive from '~/namespace/namespace.ts';
import type * as OutgoingPrimitive from '~/outgoing/index.ts';
import type * as DefinePlugin from '~/plugins/define.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as RequestPrimitive from '~/request/request.ts';
import type * as ScheduledPrimitive from '~/scheduled/scheduled.ts';
import type * as RecordedStreamPrimitive from '~/stream-recorded/stream-recorded.ts';
import type * as ResumableStreamPrimitive from '~/stream-resumable/stream-resumable.ts';
import type * as StreamPrimitive from '~/stream/stream.ts';

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
/** Any `.request()` handler, regardless of event, payload, or response type. */
export type AnyRequest = RequestPrimitive.RequestPrimitive<string, any, any, any>;
/** Any `.generate()` handler attached to a stream declaration. */
export type AnyGenerate = StreamPrimitive.GeneratePrimitive<
  StreamPrimitive.StreamPrimitive<string, any, any, readonly StreamPrimitive.NudgeDeclaration[]>,
  any,
  any
>;
/** Compiled resumable stream handler (`resumableStream(...)` after compile). */
export type AnyResumableStream = ResumableStreamPrimitive.ResumableStreamGeneratePrimitive;
/** Compiled recorded stream handler (`recordedStream(...)` after compile). */
export type AnyRecordedStream = RecordedStreamPrimitive.RecordedStreamGeneratePrimitive;
/** Any `.intercept()` primitive. */
export type AnyIntercept = InterceptPrimitive.InterceptPrimitive<any>;
/** Any `.scheduled()` task declaration. */
export type AnyScheduled = ScheduledPrimitive.ScheduledPrimitive<string, any, any, any>;
/** Any installed plugin instance from `definePlugin(...)`. */
export type AnyPlugin = DefinePlugin.PluginInstance<
  string,
  any,
  any,
  Record<string, unknown>,
  DefinePlugin.PluginErrorMap
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

  resumableStreams: Map<string, AnyResumableStream>;

  recordedStreams: Map<string, AnyRecordedStream>;

  intercepts: AnyIntercept[];
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

  resumableStreams: Map<string, AnyResumableStream>;

  recordedStreams: Map<string, AnyRecordedStream>;

  intercepts: AnyIntercept[];
}

/**
 * Flattened server definition the engine executes at runtime.
 *
 * The compile step converts the declarative primitive list into maps and flags
 * so the runtime can answer questions quickly while messages are flowing.
 */
export interface CompiledServer {
  /** Whether the contract enabled raw binary frames via `binary: true`. */
  binary: boolean;

  outgoing: Map<string, AnyOutgoing>;

  incoming: Map<string, AnyIncoming>;

  requests: Map<string, AnyRequest>;

  streams: Map<string, AnyGenerate>;

  resumableStreams: Map<string, AnyResumableStream>;

  recordedStreams: Map<string, AnyRecordedStream>;

  intercepts: AnyIntercept[];

  namespaces: Map<string, CompiledNamespace>;

  channels: Map<string, CompiledChannel>;

  channelFamilies: Map<string, CompiledChannel>;

  scheduled: Map<string, AnyScheduled>;

  plugins: AnyPlugin[];

  requires: RequiresManifest;

  /**
   * Channel keys (static channel names or scope keys) that have an explicit
   * `.replay(...)` or `.replay(false)` registered inside them.
   *
   * Server-level replay uses this to decide which channels' traffic it should
   * skip. Without an entry here, server-level replay captures the channel's
   * outgoing messages too — that's the auto-cascade behavior.
   */
  replayClaimedChannelKeys: Set<string>;
}

export type { ChannelPrimitive, NamespacePrimitive, OutgoingPrimitive, RequestPrimitive };
