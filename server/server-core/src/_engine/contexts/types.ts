import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

/**
 * Hidden scope markers attached to live connection contexts for engine-owned
 * helpers and primitive context extenders.
 */
export interface EngineScopeMeta {
  namespaceName?: string;
  channelName?: string;
  channelScope?: string;
}

/** Symbol key used to attach scope metadata (namespace name, channel name) to a handler context. */
export const ENGINE_SCOPE_META = Symbol('wskit-engine-scope-meta');

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
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;
  broadcastToConnections(
    connections: readonly EngineRuntimeTypes.RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: PublicApi.BroadcastOptions & { namespace?: string },
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
  ): void;
  getChannelMembers(channelName: string): ConnectionInfo<Record<string, unknown>>[];
  kickChannelMembers(channelName: string, tag: string, reason: string): void;
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

export type BroadcastOptions = PublicApi.BroadcastOptions;
export type ConnectionContext<
  TMeta extends Record<string, unknown>,
  TEnv extends Record<string, unknown>,
  TPlatform,
> = PublicApi.ConnectionContext<TMeta, TEnv, TPlatform>;
export type ConnectionInfo<TMeta extends Record<string, unknown>> = PublicApi.ConnectionInfo<TMeta>;
export type InitContext<TEnv extends Record<string, unknown>, TPlatform> = PublicApi.InitContext<
  TEnv,
  TPlatform
>;
export type ShutdownContext<
  TMeta extends Record<string, unknown>,
  TEnv extends Record<string, unknown>,
  TPlatform,
> = PublicApi.ShutdownContext<TMeta, TEnv, TPlatform>;
export type TaskContext<
  TMeta extends Record<string, unknown>,
  TEnv extends Record<string, unknown>,
  TPlatform,
> = PublicApi.TaskContext<TMeta, TEnv, TPlatform>;
export type CompiledChannel = EngineCompileTypes.CompiledChannel;
export type CompiledNamespace = EngineCompileTypes.CompiledNamespace;
export type CompiledServer = EngineCompileTypes.CompiledServer;
export type ModuleRuntime = EngineRuntimeTypes.ModuleRuntime;
export type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
