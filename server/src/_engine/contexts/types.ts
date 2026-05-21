import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';
import type { ScheduledCancelResult } from '~/scheduled/types.ts';

/**
 * Hidden scope markers attached to live connection contexts for engine-owned
 * helpers and primitive context extenders.
 */
export interface EngineScopeMeta {
  namespaceName?: string;
  channelName?: string;
  /**
   * Scope marker for the active channel: `null` for static channels, the
   * family key for dynamic channel families, `undefined` when no channel is
   * active.
   */
  channelScope?: string | null;
}

/**
 * Symbol key used to attach scope metadata (namespace name, channel name) to a handler context.
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
 * Symbol key under which the engine stashes the current message's ack id on a
 * handler context. `ctx.ack()` reads it so a handler always confirms its own
 * message — never a later message that interleaved on the same connection.
 *
 * @internal
 */
export const ENGINE_ACK_ID = Symbol('wskit-engine-ack-id');

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
  requireTimers(): PublicApi.TimerProvider;
  scheduleTask(taskId: string, time: number, data: unknown): void;
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): ScheduledCancelResult;
  broadcastToConnections(
    connections: readonly EngineRuntimeTypes.RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: PublicApi.BroadcastOptions & { namespace?: string; channelScope?: string | null },
    excludeConnectionId?: string,
  ): void;
  sendThroughPipeline(
    connection: EngineRuntimeTypes.RuntimeConnection,
    routing:
      | {
          namespace?: string;
          channel?: string;
          channelScope?: string | null;
          correlationId?: string;
          streamId?: string;
        }
      | undefined,
    event: string,
    payload: unknown,
  ): boolean;
  broadcastToChannel(
    channelName: string,
    event: string,
    payload: unknown,
    excludeConnectionId: string | undefined,
    channelScope: string | null,
    excludeSelf?: boolean,
  ): void;
  getChannelMembers(
    channelName: string,
    channelScope: string | null,
  ): ConnectionInfo<Record<string, unknown>>[];
  kickChannelMembers(
    channelName: string,
    target:
      | PublicApi.ConnectionRef
      | PublicApi.TagRef
      | { __wskit: 'group-handle'; kind: 'ephemeral' | 'persistent'; group: string },
    reason: string,
    channelScope: string | null,
  ): Promise<void>;
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
    channelName: string,
    channelScope: string | null,
    payload: unknown,
  ): Promise<void>;
  resolveChannel(
    target: string | { family: string; name: string },
  ): { channelName: string; channelScope: string | null } | undefined;
  sendReplay(
    connection: EngineRuntimeTypes.RuntimeConnection,
    channelName: string | null,
    channelScope: string | null,
    event: string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string },
  ): void;
  sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
    wskit: Record<string, unknown>,
  ): void;
  persistAttachment(connection: RuntimeConnection): void;
  toConnectionInfo(
    connection: EngineRuntimeTypes.RuntimeConnection,
  ): PublicApi.ConnectionInfo<Record<string, unknown>>;
  attachModuleApis(
    ctx: Record<PropertyKey, unknown>,
    connection?: EngineRuntimeTypes.RuntimeConnection,
  ): void;
  contextExtenders?: readonly ((ctx: unknown) => Record<string, unknown>)[];
  /**
   * Whether at least one tag group was declared via `.tagGroups(...)`. When
   * `false`, `ctx.tags` is omitted from every connection context.
   */
  usesTags: boolean;
  /**
   * Whether the engine flipped persistence on via `.enablePersistence()`.
   * Persistent tag writes are no-ops when this is `false`.
   */
  persistenceEnabled: boolean;
  /**
   * Check whether a given `(kind, group)` is declared on this engine. The tag
   * runtime throws when a handler accesses an undeclared group.
   */
  isTagGroupDeclared(kind: 'ephemeral' | 'persistent', group: string): boolean;
}

/**
 * Extra data required when building a live connection context.
 */
export interface BuildConnectionContextDeps extends ContextCommonDeps {
  compiled: EngineCompileTypes.CompiledServer;
  connections: Map<string, EngineRuntimeTypes.RuntimeConnection>;
}

/**
 * Extra data required when building a task or shutdown context.
 */
export interface CreateTaskContextDeps extends ContextCommonDeps {
  connections: Map<string, EngineRuntimeTypes.RuntimeConnection>;
}

// ---------------------------------------------------------------------------
// Re-exports for internal context builders — keeps import paths short within
// the engine without exposing engine-specific modules from the public API.
// ---------------------------------------------------------------------------

/** Public broadcast options re-exported here so engine helpers can share one import path. */
export type BroadcastOptions = PublicApi.BroadcastOptions;

/** Public connection context re-exported for internal helpers that extend live handler ctx objects. */
export type ConnectionContext<
  TMeta extends Record<string, unknown>,
  TEnv extends Record<string, unknown>,
  TPlatform,
> = PublicApi.ConnectionContext<TMeta, TEnv, TPlatform>;

/** Public read-only connection snapshot shape used by internal channel/member helpers. */
export type ConnectionInfo<TMeta extends Record<string, unknown>> = PublicApi.ConnectionInfo<TMeta>;

/** Public init-hook context re-exported for engine setup helpers. */
export type InitContext<TEnv extends Record<string, unknown>, TPlatform> = PublicApi.InitContext<
  TEnv,
  TPlatform
>;

/** Public shutdown-hook context re-exported for engine teardown helpers. */
export type ShutdownContext<
  TMeta extends Record<string, unknown>,
  TEnv extends Record<string, unknown>,
  TPlatform,
> = PublicApi.ShutdownContext<TMeta, TEnv, TPlatform>;

/** Public scheduled-task context re-exported for runtime task helpers. */
export type TaskContext<
  TMeta extends Record<string, unknown>,
  TEnv extends Record<string, unknown>,
  TPlatform,
> = PublicApi.TaskContext<TMeta, TEnv, TPlatform>;

/** Compiled channel definition used by runtime routing and scoped ctx builders. */
export type CompiledChannel = EngineCompileTypes.CompiledChannel;

/** Compiled namespace definition used by runtime routing and scoped ctx builders. */
export type CompiledNamespace = EngineCompileTypes.CompiledNamespace;

/** Fully compiled server definition the engine executes at runtime. */
export type CompiledServer = EngineCompileTypes.CompiledServer;

/** Installed module runtime hooks and API factory bundle for one module instance. */
export type ModuleRuntime = EngineRuntimeTypes.ModuleRuntime;

/** Live connection record tracked by the engine. */
export type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
