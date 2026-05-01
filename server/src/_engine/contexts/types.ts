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
  channelScope?: string;
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
 * Shared capabilities needed to build init, task, shutdown, and connection
 * contexts from the engine state.
 */
export interface ContextCommonDeps {
  env: Record<string, unknown>;
  logger: PublicApi.Logger;
  platform: unknown;
  waitUntilImpl: (promise: Promise<unknown>) => void;
  requireStorage(): PublicApi.StorageProvider;
  requireTimers(): PublicApi.TimerProvider;
  scheduleTask(taskId: string, time: number, data: unknown): void;
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): ScheduledCancelResult;
  broadcastToConnections(
    connections: readonly EngineRuntimeTypes.RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: PublicApi.BroadcastOptions & { namespace?: string; channelScope?: string },
    excludeConnectionId?: string,
  ): void;
  sendThroughPipeline(
    connection: EngineRuntimeTypes.RuntimeConnection,
    routing:
      | {
          namespace?: string;
          channel?: string;
          channelScope?: string;
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
    excludeConnectionId?: string,
    channelScope?: string,
    excludeSelf?: boolean,
  ): void;
  getChannelMembers(
    channelName: string,
    channelScope?: string,
  ): ConnectionInfo<Record<string, unknown>>[];
  kickChannelMembers(
    channelName: string,
    tag: string,
    reason: string,
    channelScope?: string,
  ): Promise<void>;
  resolveChannel(
    target: string | { family: string; name: string },
  ): { channelName: string; channelScope?: string } | undefined;
  sendReplay(
    connection: EngineRuntimeTypes.RuntimeConnection,
    channelName: string | undefined,
    channelScope: string | undefined,
    event: string,
    payload: unknown,
    wire: { seq: number; messageId: string; channel?: string },
  ): void;
  sendProtocolMessage(
    connection: RuntimeConnection,
    event: string,
    payload: Record<string, unknown>,
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
