/* oxlint-disable @typescript-eslint/no-explicit-any */
import type * as ChannelPrimitive from '~/channel/channel.ts';
import type * as IncomingPrimitive from '~/incoming/index.ts';
import type * as InterceptPrimitive from '~/intercept/intercept.ts';
import type * as OutgoingPrimitive from '~/outgoing/index.ts';
import type * as PrimitiveCore from '~/primitive.ts';
import type * as RequestPrimitive from '~/request/request.ts';
import type * as ScheduledPrimitive from '~/scheduled/scheduled.ts';
import type * as RecordedStreamPrimitive from '~/stream-recorded/stream-recorded.ts';
import type * as StreamPrimitive from '~/stream/stream.ts';

// Widened type aliases — used throughout the compile and runtime layers so
// generic parameters don't leak into every function signature. Each alias
// erases the specific event name, payload, and handler types to `any` while
// keeping the structural shape intact.

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
/** Compiled recorded stream handler (`recordedStream(...)` after compile). */
export type AnyRecordedStream = RecordedStreamPrimitive.RecordedStreamGeneratePrimitive;
/** Any `.intercept()` primitive. */
export type AnyIntercept = InterceptPrimitive.InterceptPrimitive<any>;
/** Any `.scheduled()` task declaration. */
export type AnyScheduled = ScheduledPrimitive.ScheduledPrimitive<string, any, any, any>;
/** Widened `.channel()` primitive type for the compile layer. */
export type ChannelPrimitiveType = ChannelPrimitive.ChannelPrimitive;
/** Adapter dependency manifest — which platform features a primitive needs. */
type RequiresManifest = PrimitiveCore.RequiresManifest;

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

  recordedStreams: Map<string, AnyRecordedStream>;

  intercepts: AnyIntercept[];

  /**
   * The owning plugin id when this channel was contributed by a `plugin(...)`,
   * else `undefined`. Set from the channel primitive's `__plugin` provenance
   * marker; the compile name guards read it to permit the framework-namespaced
   * `__<id>::<name>` channel and its child events.
   */
  __plugin?: string;
}

/**
 * Flattened server definition the engine executes at runtime.
 *
 * The compile step converts the declarative primitive list into maps and flags
 * so the runtime can answer questions quickly while messages are flowing.
 */
/**
 * How the server caps the number of live connections one user may hold at once.
 * `maxConnections` is the ceiling; `onExceed` decides what happens when a new
 * connection would breach it — `reject` refuses the newcomer, `replace` evicts
 * the user's oldest connection(s) to make room. Absent means unlimited.
 */
interface UsersPolicy {
  maxConnections?: number;
  onExceed: 'replace' | 'reject';
}

export interface CompiledServer {
  outgoing: Map<string, AnyOutgoing>;

  incoming: Map<string, AnyIncoming>;

  requests: Map<string, AnyRequest>;

  streams: Map<string, AnyGenerate>;

  recordedStreams: Map<string, AnyRecordedStream>;

  intercepts: AnyIntercept[];

  channels: Map<string, CompiledChannel>;

  channelFamilies: Map<string, CompiledChannel>;

  scheduled: Map<string, AnyScheduled>;

  requires: RequiresManifest;

  /**
   * Channel keys (static channel names or family keys) that have an explicit
   * `.replay(...)` or `.replay(false)` registered inside them.
   *
   * Server-level replay uses this to decide which channels' traffic it should
   * skip. Without an entry here, server-level replay captures the channel's
   * outgoing messages too — that's the auto-cascade behavior.
   */
  replayClaimedChannelKeys: Set<string>;

  /** Per-user connection cap from `server({ users: {...} })`, or `undefined` for unlimited. */
  usersPolicy?: UsersPolicy;
}
