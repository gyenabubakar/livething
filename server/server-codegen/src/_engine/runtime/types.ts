/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ConnectionDescriptor } from '~/_engine/adapter/types.ts';
import type {
  AnyModule,
  CompiledChannel,
  CompiledNamespace,
  CompiledServer,
} from '~/_engine/compile/types.ts';
import type { ConnectionInfo } from '~/index.ts';
import type { Validator } from '~/types.ts';

/**
 * One `onBeforeSubscribe` hook plus its optional validator.
 *
 * The validator runs first so the hook can receive a typed, already-checked
 * subscription payload.
 */
export interface ChannelBeforeSubscribeHook {
  handler: (ctx: any, data?: unknown) => void | Promise<void>;
  validator?: Validator<any>;
}

/**
 * One finalized outgoing wire message.
 *
 * At this point sequence, dedup, routing markers, and other engine-owned
 * metadata have already been attached to `payload`.
 */
export interface WireOutgoingMessage {
  connectionId: string;
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Reserved websocket events that can arrive from the client into the engine.
 *
 * These are the protocol-level messages wskit itself understands before app
 * handlers run. Built-in primitives can hook into these names through
 * `onProtocolMessage(...)`.
 */
export type IncomingProtocolEvent =
  | 'ping'
  | '_subscribe'
  | '_unsubscribe'
  | '_streamCancel'
  | '_replay';

/**
 * All hook registries the engine fills during primitive setup.
 *
 * These are the runtime lists and maps the engine dispatches later while
 * processing messages, connections, shutdown, and alarms.
 */
export interface RegisteredEngineHooks {
  activity: ((connectionId: string) => void | Promise<void>)[];
  incoming: ((message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void)[];
  outgoing: ((message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void)[];
  beforeSend: ((message: WireOutgoingMessage) => void)[];
  afterSend: ((message: WireOutgoingMessage) => void | Promise<void>)[];
  protocol: Map<
    IncomingProtocolEvent,
    ((
      ctx: any,
      payload: Record<string, unknown> | undefined,
    ) => boolean | void | Promise<boolean | void>)[]
  >;
  contextExtenders: ((ctx: any) => Record<string, unknown>)[];
  init: ((ctx: any) => void | Promise<void>)[];
  connect: ((ctx: any) => void | Promise<void>)[];
  disconnect: ((ctx: any) => void | Promise<void>)[];
  shutdown: ((ctx: any) => void | Promise<void>)[];
  error: ((ctx: any, error: unknown, event?: string) => boolean | void | Promise<boolean | void>)[];
  upgrade: ((request: Request) =>
    | { meta?: Record<string, unknown>; tags?: readonly string[] }
    | Promise<{
        meta?: Record<string, unknown>;
        tags?: readonly string[];
      }>)[];
  binary: ((ctx: any, data: ArrayBuffer) => void | Promise<void>)[];
  validationError: ((ctx: any, event: string, validationError: unknown) => void | Promise<void>)[];
  boot: (() => void | Promise<void>)[];
  alarm: (() => void | Promise<void>)[];
  beforeSubscribe: Map<string, ChannelBeforeSubscribeHook[]>;
  subscribe: Map<string, ((ctx: any) => void | Promise<void>)[]>;
  unsubscribe: Map<string, ((ctx: any) => void | Promise<void>)[]>;
}

/**
 * Mutable in-memory state for one live connection.
 *
 * This is the engine's private record for a websocket connection while it is
 * active.
 */
export interface RuntimeConnection {
  id: string;
  wsKey: unknown;
  descriptor: ConnectionDescriptor;
  meta: Record<string, unknown>;
  tags: Set<string>;
  channels: Set<string>;
  latency: number | null;
  quality: 'excellent' | 'good' | 'degraded' | 'poor';
  activeAckId?: string;
  heartbeatTimer?: unknown;
}

/**
 * Runtime bookkeeping for one active stream generator.
 *
 * This tracks the live generator, any queued nudges, and whether the stream
 * has been closed.
 */
export interface ActiveStream {
  id: string;
  connectionId: string;
  generator: AsyncGenerator<unknown, void, unknown>;
  nudges: { event: string; payload: unknown }[];
  nudgeValidators: Map<string, unknown>;
  closed: boolean;
}

/**
 * Runtime hooks and context factory for one installed module.
 *
 * Each installed module gets one of these records so the engine can call the
 * module's hooks and build its scoped helper API when needed.
 */
export interface ModuleRuntime {
  instance: AnyModule;
  onInit?: (ctx: any) => void | Promise<void>;
  onIncoming?: (message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void;
  onOutgoing?: (message: {
    event: string;
    payload: unknown;
  }) => { event: string; payload: unknown } | void;
  onConnect?: (ctx: any) => void | Promise<void>;
  onDisconnect?: (ctx: any) => void | Promise<void>;
  onShutdown?: () => void | Promise<void>;
  contextFactory: (ctx: any) => unknown;
}

/**
 * Extra routing metadata attached to one outgoing message.
 *
 * The engine uses this to carry namespace, channel, correlation, and stream
 * routing information through the send pipeline.
 */
export interface RoutingTarget {
  namespace?: string;
  channel?: string;
  channelScope?: string;
  correlationId?: string;
  streamId?: string;
}

/**
 * The resolved scope for one incoming message.
 *
 * This is the engine's parsed view of `_namespace`, `_channel`, and
 * `_channelScope` markers from the incoming payload.
 */
export interface ResolvedScope {
  namespace?: CompiledNamespace;
  channel?: CompiledChannel;
  channelName?: string;
  channelScope?: string;
}

/**
 * Shared dependency bag for helpers that need connection lookup and channel
 * membership data.
 */
export interface ConnectionMembersRuntime {
  connections: Map<string, RuntimeConnection>;
  compiled: CompiledServer;
  toConnectionInfo(connection: RuntimeConnection): ConnectionInfo<Record<string, unknown>>;
  sendThroughPipeline(
    connection: RuntimeConnection,
    routing: RoutingTarget | undefined,
    event: string,
    payload: unknown,
  ): boolean;
}
