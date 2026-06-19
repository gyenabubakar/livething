import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as WireRuntime from '~/_engine/runtime/wire.ts';
import type * as ChannelRuntime from '~/channel/runtime.ts';
import type * as PublicApi from '~/context.ts';
import type * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type { ScheduledCancelResult } from '~/scheduled/types.ts';
import type { Validator } from '~/types.ts';

/**
 * Hidden scope markers attached to live connection contexts for engine-owned
 * helpers and primitive context extenders.
 */
export interface EngineScopeMeta {
  channelName?: string;
  /**
   * Scope marker for the active channel: `null` for static channels, the
   * family key for dynamic channel families, `undefined` when no channel is
   * active.
   */
  channelScope?: string | null;
}

/**
 * Symbol key used to attach scope metadata (channel name) to a handler context.
 *
 * @internal
 */
export const ENGINE_SCOPE_META = Symbol('wskit-engine-scope-meta');

/**
 * Symbol key under which engine internals stash the runtime connection on a
 * handler context. Engine-installed protocol handlers read this to perform
 * connection-state checks (membership, etc.). Product handlers cannot see
 * this field — symbol keys do not appear in the public ctx type, in
 * `Object.keys`, or in `JSON.stringify`.
 *
 * @internal
 */
export const ENGINE_INTERNAL_CONNECTION = Symbol('wskit-engine-internal-connection');

/**
 * Shared capabilities needed to build init, task, shutdown, and connection
 * contexts from the engine state.
 */
export interface ContextCommonDeps {
  env: Record<string, unknown>;

  logger: PublicApi.Logger;

  platform: unknown;

  waitUntilImpl: (promise: Promise<unknown>) => void;

  /**
   * The engine's instance id, or `undefined` when running single-instance.
   * Read when building `ConnectionRef`s on `ConnectionInfo` or `ctx.self`.
   */
  instanceId: string | undefined;

  requireStorage(): PublicApi.StorageProvider;

  getTimers(): PublicApi.TimerProvider | undefined;

  scheduleTask(taskId: string, time: number, data: unknown): void;

  cancelScheduled(taskId: string, filter?: Record<string, unknown>): ScheduledCancelResult;

  broadcastToConnections(
    connections: readonly EngineRuntimeTypes.RuntimeConnection[],
    opts: OutgoingRuntime.BroadcastToConnectionsOptions,
  ): void;

  sendThroughPipeline(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: OutgoingRuntime.SendThroughPipelineOptions,
  ): boolean;

  broadcastToChannel(opts: OutgoingRuntime.BroadcastToChannelOptions): void;

  getChannelMembers(
    channelName: string,
    channelScope: string | null,
  ): PublicApi.ConnectionInfo<Record<string, unknown>>[];

  kickChannelMembers(opts: ChannelRuntime.KickChannelMembersOptions): Promise<void>;

  /**
   * Remove every live connection of the given identity from one channel
   * scope AND drop the durable membership row. True-leave semantics —
   * `onUnsubscribe` fires, `__memberLeave__`/`__memberOffline__` broadcast.
   */
  removeChannelMember(
    channelName: string,
    channelScope: string | null,
    identity: string,
  ): Promise<void>;

  /**
   * Server-initiated channel subscribe. Invoked from `channelHandle.subscribe(ref)`.
   * Resolves to a no-op when the target connection is already a member.
   */
  subscribeConnectionAsServer(
    ref: PublicApi.ConnectionRef,
    opts: Omit<ChannelRuntime.SubscribeConnectionAsServerOptions, 'rejoining'>,
  ): Promise<void>;

  resolveChannel(
    target: string | { family: string; name: string },
  ):
    | { channelName: string; channelScope: string | null; params: Record<string, string> }
    | undefined;

  sendReplay(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: WireRuntime.SendReplayOptions,
  ): void;

  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: WireRuntime.SendProtocolMessageOptions,
  ): void;

  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;

  toConnectionInfo(
    connection: EngineRuntimeTypes.RuntimeConnection,
  ): PublicApi.ConnectionInfo<Record<string, unknown>>;

  /** Look up a `plugin(...)` API factory by id for the `ctx.plugin(id)` accessor. */
  getPluginApiFactory(id: string): ((ctx: unknown) => unknown) | undefined;

  contextExtenders?: readonly ((ctx: unknown) => Record<string, unknown>)[];
  /**
   * Whether at least one tag group was declared via the contract's `tagGroups`
   * config. When `false`, `ctx.tags` is omitted from every connection context.
   */
  usesTags: boolean;

  /**
   * Whether the contract enabled persistence via `persistence: true`.
   * Persistent tag writes are no-ops when this is `false`.
   */
  persistenceEnabled: boolean;

  /**
   * Check whether a given `(kind, group)` is declared on this engine. The tag
   * runtime throws when a handler accesses an undeclared group.
   */
  isTagGroupDeclared(kind: 'ephemeral' | 'persistent', group: string): boolean;

  /** The runtime validator for a tag group, or `undefined` when it has none. */
  getTagGroupSchema(kind: 'ephemeral' | 'persistent', group: string): Validator | undefined;
}

/**
 * Extra data required when building a live connection context.
 */
export interface BuildConnectionContextDeps extends ContextCommonDeps {
  compiled: EngineCompileTypes.CompiledServer;
  connections: Map<string, EngineRuntimeTypes.RuntimeConnection>;
  tagMembers: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
  hibernationEnabled: boolean;
}

/**
 * Extra data required when building a task or shutdown context.
 */
export interface CreateTaskContextDeps extends ContextCommonDeps {
  connections: Map<string, EngineRuntimeTypes.RuntimeConnection>;
}

export type {
  BroadcastOptions,
  ConnectionContext,
  ConnectionInfo,
  InitContext,
  ShutdownContext,
  TaskContext,
} from '~/context.ts';

export type { CompiledChannel, CompiledServer } from '~/_engine/compile/types.ts';

export type { RuntimeConnection } from '~/_engine/runtime/types.ts';
