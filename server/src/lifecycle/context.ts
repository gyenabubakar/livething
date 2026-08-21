import { buildConnectionsManager, buildUsersManager } from '~/_engine/contexts/contexts.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type * as PublicApi from '~/context.ts';

/**
 * Build the context passed to the `onInit` lifecycle hook.
 */
export function createInitContext(
  deps: Pick<
    EngineContextTypes.CreateTaskContextDeps,
    'env' | 'logger' | 'platform' | 'getStorageView'
  >,
): PublicApi.InitContext<Record<string, unknown>, unknown> {
  const { sql, kv } = deps.getStorageView();
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
): PublicApi.ShutdownContext<Record<string, unknown>, Record<string, unknown>, unknown> {
  const { sql, kv } = deps.getStorageView();
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
      deps.broadcastToConnections([...deps.connections.values()], { event, payload });
    },
    sql,
    kv,
    schedule: (taskId, options) => {
      deps.scheduleTask(taskId, options.time, options.data);
    },
    cancelScheduled,
    get connectionCount() {
      return deps.connections.size;
    },
    connections: buildConnectionsManager(deps),
    users: buildUsersManager(deps),
    env: deps.env,
    log: deps.logger,
    waitUntil: deps.waitUntilImpl,
    platform: deps.platform,
  };
}
