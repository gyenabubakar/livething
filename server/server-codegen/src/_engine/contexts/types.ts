import type {
  CompiledChannel,
  CompiledNamespace,
  CompiledServer,
} from '~/_engine/compile/types.ts';
import type { ModuleRuntime, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type {
  BroadcastOptions,
  ConnectionContext,
  ConnectionInfo,
  InitContext,
  Logger,
  ShutdownContext,
  StorageProvider,
  TaskContext,
  TimerProvider,
} from '~/index.ts';

/**
 * Hidden scope markers attached to live connection contexts for engine-owned
 * helpers and primitive context extenders.
 */
export interface EngineScopeMeta {
  namespaceName?: string;
  channelName?: string;
  channelScope?: string;
}

export const ENGINE_SCOPE_META = Symbol('wskit-engine-scope-meta');

/**
 * Shared capabilities needed to build init, task, shutdown, and connection
 * contexts from the engine state.
 */
export interface ContextCommonDeps {
  env: Record<string, unknown>;
  logger: Logger;
  platform: unknown;
  waitUntilImpl: (promise: Promise<unknown>) => void;
  requireStorage(): StorageProvider;
  requireTimers(): TimerProvider;
  scheduleTask(taskId: string, time: number, data: unknown): void;
  cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;
  broadcastToConnections(
    connections: readonly RuntimeConnection[],
    event: string,
    payload: unknown,
    options?: BroadcastOptions & { namespace?: string },
    excludeConnectionId?: string,
  ): void;
  sendThroughPipeline(
    connection: RuntimeConnection,
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
    connection: RuntimeConnection,
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
  toConnectionInfo(connection: RuntimeConnection): ConnectionInfo<Record<string, unknown>>;
  attachModuleApis(ctx: Record<PropertyKey, unknown>, connection?: RuntimeConnection): void;
  contextExtenders?: readonly ((ctx: unknown) => Record<string, unknown>)[];
}

/**
 * Extra data required when building a live connection context.
 */
export interface BuildConnectionContextDeps extends ContextCommonDeps {
  compiled: CompiledServer;
  connections: Map<string, RuntimeConnection>;
}

/**
 * Extra data required when building a task or shutdown context.
 */
export interface CreateTaskContextDeps extends ContextCommonDeps {
  connections: Map<string, RuntimeConnection>;
}

export type {
  BroadcastOptions,
  ConnectionContext,
  ConnectionInfo,
  InitContext,
  ModuleRuntime,
  RuntimeConnection,
  ShutdownContext,
  TaskContext,
  CompiledChannel,
  CompiledNamespace,
};
