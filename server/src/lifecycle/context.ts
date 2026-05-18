import { createLazyStorageView } from '~/_engine/contexts/lazy-storage.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';

/**
 * Build the context passed to the `onInit` lifecycle hook.
 */
export function createInitContext(
  deps: Pick<
    EngineContextTypes.CreateTaskContextDeps,
    'env' | 'logger' | 'platform' | 'requireStorage'
  >,
): EngineContextTypes.InitContext<Record<string, unknown>, unknown> {
  const { sql, kv } = createLazyStorageView(deps.requireStorage);
  return {
    sql,
    kv,
    env: deps.env,
    log: deps.logger,
    platform: deps.platform,
  };
}

/**
 * Build the context passed to the shutdown hook.
 */
export function createShutdownContext(
  deps: EngineContextTypes.CreateTaskContextDeps,
): EngineContextTypes.ShutdownContext<Record<string, unknown>, Record<string, unknown>, unknown> {
  const { sql, kv } = createLazyStorageView(deps.requireStorage);
  function cancelScheduled(taskId: string, filter?: Record<string, unknown>): void {
    const result = deps.cancelScheduled(taskId, filter);
    if (result.removed === 0) {
      deps.logger.error('[wskit] cancelScheduled matched no runs', {
        taskId,
        filter,
        taskExists: result.taskExists,
      });
    }
  }
  return {
    closeAll: (code, reason) => {
      for (const connection of deps.connections.values()) {
        connection.descriptor.close(code, reason);
      }
    },
    broadcast: (event, payload) => {
      deps.broadcastToConnections([...deps.connections.values()], event, payload, undefined);
    },
    sql,
    kv,
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled,
    connectionCount: deps.connections.size,
    getConnections: () => {
      return [...deps.connections.values()].map((connection) => deps.toConnectionInfo(connection));
    },
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,
  };
}
