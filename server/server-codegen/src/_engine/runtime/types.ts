/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { ConnectionInfo, TimerProvider } from '../../index.ts';
import type { ConnectionDescriptor } from '../adapter/types.ts';
import type {
  AnyModule,
  CompiledChannel,
  CompiledNamespace,
  CompiledServer,
} from '../compile/types.ts';

/**
 * Mutable in-memory state for one live connection.
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
 * One scheduled task instance waiting to run.
 */
export interface ScheduledRun {
  id: string;
  taskId: string;
  time: number;
  data: unknown;
  every?: number;
}

/**
 * Runtime bookkeeping for an active stream generator.
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
 */
export interface ModuleRuntime {
  instance: AnyModule;
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
 * Extra routing metadata the engine adds to outgoing wire payloads.
 */
export interface RoutingTarget {
  namespace?: string;
  channel?: string;
  channelScope?: string;
  correlationId?: string;
  streamId?: string;
}

/**
 * Result of resolving `_namespace`, `_channel`, and `_channelScope` markers
 * from an incoming payload.
 */
export interface ResolvedScope {
  namespace?: CompiledNamespace;
  channel?: CompiledChannel;
  channelName?: string;
  channelScope?: string;
}

/**
 * Small dependency bag for the scheduling helpers.
 */
export interface SchedulingRuntime {
  storage?: {
    sql: {
      exec(
        sql: string,
        ...bindings: unknown[]
      ): {
        toArray(): Record<string, unknown>[];
      };
      transaction(
        callback: (tx: { exec(sql: string, ...bindings: unknown[]): void }) => void,
      ): void;
    };
  };
  timers?: TimerProvider;
  scheduledRuns: Map<string, ScheduledRun>;
  compiled: Pick<CompiledServer, 'scheduled'>;
  alarmState: { current: unknown | null };
  generateId(prefix?: string): string;
  createTaskContext(): unknown;
  onAlarm(): Promise<void>;
}

/**
 * Shared dependency bag for helpers that need access to channel membership and
 * connection lookup.
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
